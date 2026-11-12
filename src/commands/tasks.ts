import fs from "node:fs";
import type { Command } from "commander";
import { pendingCards } from "../cards.js";
import { dim, green, yellow } from "../color.js";
import { makeCtx, prompt, readStdin, type Ctx, type IO } from "../context.js";
import { CliError, HttpError, usage } from "../errors.js";
import { listProjects, resolveProject, resolveTags, resolveTask, shortId } from "../resolve.js";
import { renderCard, renderMessage, taskHeader } from "../render.js";
import { PRIORITIES, STATUSES, type DiscardPreview, type MergeResult, type PrResult, type ProjectDetail, type Task, type TaskDetail } from "../types.js";
import { watchTask } from "./watch.js";

export const getTask = (ctx: Ctx, id: string): Promise<TaskDetail> => ctx.client.get<TaskDetail>(`/api/tasks/${encodeURIComponent(id)}`);

/** Starts a task's first turn. A suggested task is accepted first. */
export async function startTask(ctx: Ctx, id: string): Promise<Task> {
  const task = await getTask(ctx, id);
  if (task.started || task.running) throw usage(`task ${shortId(id)} is already ${task.running ? "running" : "started"}. Use \`calandria send ${shortId(id)} <text>\` to message it.`);
  if (task.suggested) await ctx.client.patch(`/api/tasks/${encodeURIComponent(id)}`, { suggested: 0 });
  await ctx.client.post(`/api/tasks/${encodeURIComponent(id)}/messages`, { text: "" });
  return task;
}

async function descriptionFrom(io: IO, o: { description?: string; descriptionFile?: string }): Promise<string | undefined> {
  if (o.description !== undefined && o.descriptionFile !== undefined) throw usage("use either --description or --description-file, not both");
  const file = o.descriptionFile;
  if (file === "-" || o.description === "-") return (await readStdin(io)).trimEnd();
  if (file !== undefined) {
    try {
      return fs.readFileSync(file, "utf8").trimEnd();
    } catch (e) {
      throw usage(`cannot read ${file}: ${(e as Error).message}`);
    }
  }
  return o.description;
}

const collect = (v: string, prev: string[] = []): string[] => [...prev, v];

export function registerTasks(program: Command, io: IO): void {
  program
    .command("show <task>")
    .description("task details and the last transcript messages")
    .option("--messages <n>", "how many trailing messages to render", "10")
    .action(async (ref: string, o: { messages: string }, cmd: Command) => {
      const ctx = await makeCtx(cmd, io);
      const n = Number.parseInt(o.messages, 10);
      if (!Number.isInteger(n) || n < 0) throw usage("--messages must be a non-negative integer");
      const id = await resolveTask(ctx.client, ref);
      const task = await getTask(ctx, id);
      const tail = n === 0 ? [] : task.messages.slice(-n);
      if (ctx.emit({ ...task, messages: tail })) return;
      const projects = await listProjects(ctx.client);
      ctx.println(taskHeader(task, projects.find((p) => p.id === task.project_id)?.name));
      if (task.description.trim()) ctx.println(`\n${task.description.trim()}`);
      if (tail.length) {
        ctx.println(dim(`\n--- last ${tail.length} of ${task.messages.length} messages ---`));
        for (const m of tail) ctx.println(`${renderMessage(m)}\n`);
      }
      for (const card of pendingCards(task.messages)) ctx.println(renderCard(card, task.id));
    });

  program
    .command("new <title>")
    .description("create a task")
    .requiredOption("--project <project>", "project id or name")
    .option("--description <text>", "task description (`-` reads stdin)")
    .option("--description-file <file>", "read the description from a file (`-` reads stdin)")
    .option("--priority <p>", "hi, med or lo")
    .option("--agent <agent>", "claude, codex or gemini")
    .option("--model <model>", "model id or alias")
    .option("--provider <id>", "model provider id")
    .option("--tag <name>", "tag name or id (repeatable)", collect)
    .option("--start", "launch the first turn immediately")
    .option("--watch", "stream the turn (implies --start)")
    .action(async (title: string, o: Record<string, string | string[] | boolean | undefined>, cmd: Command) => {
      const ctx = await makeCtx(cmd, io);
      if (o.priority !== undefined && !PRIORITIES.includes(o.priority as never)) throw usage(`--priority must be one of ${PRIORITIES.join(", ")}`);
      const description = await descriptionFrom(io, { description: o.description as string | undefined, descriptionFile: o.descriptionFile as string | undefined });
      const project = await resolveProject(ctx.client, o.project as string);
      let tagIds: string[] | undefined;
      if (o.tag) {
        const detail = await ctx.client.get<ProjectDetail>(`/api/projects/${encodeURIComponent(project.id)}`);
        tagIds = resolveTags(detail.tags, o.tag as string[]);
      }
      const body: Record<string, unknown> = {
        project_id: project.id,
        title,
        ...(description !== undefined ? { description } : {}),
        ...(o.priority ? { priority: o.priority } : {}),
        ...(o.agent ? { agent: o.agent } : {}),
        ...(o.model ? { model: o.model } : {}),
        ...(o.provider ? { provider_id: o.provider } : {}),
        ...(tagIds ? { tag_ids: tagIds } : {}),
      };
      const task = await ctx.client.post<Task>("/api/tasks", body);
      const start = Boolean(o.start || o.watch);
      if (start) await ctx.client.post(`/api/tasks/${encodeURIComponent(task.id)}/messages`, { text: "" });
      if (!ctx.json || !o.watch) {
        if (!ctx.emit({ ...task, started_now: start })) ctx.println(`Created ${green(shortId(task.id))} in ${project.name}: ${task.title}${start ? " (started)" : ""}`);
      }
      if (o.watch) process.exitCode = await watchTask(ctx, task.id, {});
    });

  program
    .command("start <task>")
    .description("start a task's first turn (a suggested task is accepted first)")
    .option("--watch", "stream the turn")
    .action(async (ref: string, o: { watch?: boolean }, cmd: Command) => {
      const ctx = await makeCtx(cmd, io);
      const id = await resolveTask(ctx.client, ref);
      const t = await startTask(ctx, id);
      if (!ctx.emit({ id, started: true })) ctx.println(`Started ${shortId(id)}: ${t.title}`);
      if (o.watch) process.exitCode = await watchTask(ctx, id, {});
    });

  program
    .command("send <task> [text...]")
    .description("send a follow-up message (`-` reads stdin)")
    .option("--watch", "stream the turn")
    .action(async (ref: string, words: string[], o: { watch?: boolean }, cmd: Command) => {
      const ctx = await makeCtx(cmd, io);
      const text = (words.length === 1 && words[0] === "-" ? await readStdin(io) : words.join(" ")).trim();
      if (!text) throw usage("nothing to send: pass text or `-` to read stdin");
      const id = await resolveTask(ctx.client, ref);
      const task = await getTask(ctx, id);
      if (!task.started && !task.running) throw usage(`task ${shortId(id)} has not started. Run \`calandria start ${shortId(id)}\` first.`);
      const res = await ctx.client.post<{ ok?: boolean; sent?: boolean; queued?: boolean }>(`/api/tasks/${encodeURIComponent(id)}/messages`, { text });
      if (!ctx.emit(res)) ctx.println(res?.queued ? "Queued behind the running turn." : res?.sent ? "Sent to the lingering session." : "Sent.");
      if (o.watch) process.exitCode = await watchTask(ctx, id, {});
    });

  program
    .command("stop <task>")
    .description("abort the task's running turn")
    .action(async (ref: string, _o: unknown, cmd: Command) => {
      const ctx = await makeCtx(cmd, io);
      const id = await resolveTask(ctx.client, ref);
      const res = await ctx.client.post<{ ok: boolean; aborted: boolean }>(`/api/tasks/${encodeURIComponent(id)}/abort`);
      if (!ctx.emit(res)) ctx.println(res.aborted ? `Stopped ${shortId(id)}.` : `Nothing was running on ${shortId(id)}.`);
    });

  program
    .command("set <task>")
    .description("edit a task")
    .option("--status <status>", `one of ${STATUSES.join(", ")}`)
    .option("--title <title>", "new title")
    .option("--priority <p>", "hi, med or lo")
    .option("--description <text>", "new description")
    .option("--auto-start <on|off>", "start automatically when blockers finish")
    .action(async (ref: string, o: { status?: string; title?: string; priority?: string; description?: string; autoStart?: string }, cmd: Command) => {
      const ctx = await makeCtx(cmd, io);
      const patch: Record<string, unknown> = {};
      if (o.status !== undefined) {
        if (!STATUSES.includes(o.status as never)) throw usage(`--status must be one of ${STATUSES.join(", ")}`);
        patch.status = o.status;
      }
      if (o.priority !== undefined) {
        if (!PRIORITIES.includes(o.priority as never)) throw usage(`--priority must be one of ${PRIORITIES.join(", ")}`);
        patch.priority = o.priority;
      }
      if (o.title !== undefined) patch.title = o.title;
      if (o.description !== undefined) patch.description = o.description;
      if (o.autoStart !== undefined) {
        if (o.autoStart !== "on" && o.autoStart !== "off") throw usage("--auto-start must be on or off");
        patch.auto_start = o.autoStart === "on" ? 1 : 0;
      }
      if (Object.keys(patch).length === 0) throw usage("nothing to change: pass at least one of --status, --title, --priority, --description, --auto-start");
      const id = await resolveTask(ctx.client, ref);
      await applyPatch(ctx, id, patch);
    });

  // Shorthands for the statuses a person reaches for most.
  for (const [name, status, label] of [
    ["done", "done", "mark a task done"],
    ["hold", "on_hold", "put a task on hold"],
    ["cancel", "cancelled", "cancel a task (aborts a running turn; the worktree is kept)"],
  ] as const) {
    program
      .command(`${name} <task>`)
      .description(label)
      .action(async (ref: string, _o: unknown, cmd: Command) => {
        const ctx = await makeCtx(cmd, io);
        await applyPatch(ctx, await resolveTask(ctx.client, ref), { status });
      });
  }

  program
    .command("accept <task>")
    .description("accept a suggested task onto the board")
    .action(async (ref: string, _o: unknown, cmd: Command) => {
      const ctx = await makeCtx(cmd, io);
      const id = await resolveTask(ctx.client, ref);
      const task = await getTask(ctx, id);
      if (!task.suggested) throw usage(`task ${shortId(id)} is not a suggestion`);
      await applyPatch(ctx, id, { suggested: 0 }, `Accepted ${shortId(id)}: ${task.title}`);
    });

  program
    .command("dismiss <task>")
    .description("dismiss a suggested task (a hard delete)")
    .action(async (ref: string, _o: unknown, cmd: Command) => {
      const ctx = await makeCtx(cmd, io);
      const id = await resolveTask(ctx.client, ref);
      const task = await getTask(ctx, id);
      if (!task.suggested) throw usage(`task ${shortId(id)} is not a suggestion. Use \`calandria rm\` to delete a task.`);
      await deleteOne(ctx, id, `Dismissed ${shortId(id)}: ${task.title}`);
    });

  program
    .command("rm <task...>")
    .description("delete tasks permanently (hard delete: no undo)")
    .option("--yes", "skip the confirmation prompt")
    .action(async (refs: string[], o: { yes?: boolean }, cmd: Command) => {
      const ctx = await makeCtx(cmd, io);
      const ids = [...new Set(await Promise.all(refs.map((r) => resolveTask(ctx.client, r))))];
      if (!o.yes) {
        if (!io.stdinIsTty) throw usage("refusing to delete without confirmation: pass --yes");
        const answer = await prompt(io, `Delete ${ids.length} task${ids.length === 1 ? "" : "s"} (${ids.map(shortId).join(", ")}) permanently? This is a hard delete and cannot be undone. [y/N] `);
        if (!/^y(es)?$/i.test(answer)) {
          ctx.println("Cancelled.");
          return;
        }
      }
      for (const id of ids) await deleteOne(ctx, id, `Deleted ${shortId(id)}.`);
    });

  program
    .command("move <task...>")
    .description("move tasks to another project")
    .requiredOption("--to <project>", "destination project (id or name)")
    .option("--discard-worktree", "allow tearing down the checkout of a started task")
    .option("--discard-unsafe", "also allow discarding unsaved or unlanded work in that checkout")
    .action(async (refs: string[], o: { to: string; discardWorktree?: boolean; discardUnsafe?: boolean }, cmd: Command) => {
      const ctx = await makeCtx(cmd, io);
      const dest = await resolveProject(ctx.client, o.to);
      const ids = [...new Set(await Promise.all(refs.map((r) => resolveTask(ctx.client, r))))];
      const previews =
        ids.length === 1
          ? { [ids[0]]: await ctx.client.get<DiscardPreview>(`/api/tasks/${encodeURIComponent(ids[0])}/move`) }
          : (await ctx.client.get<{ previews: Record<string, DiscardPreview> }>("/api/tasks/move", { query: { ids: ids.join(",") } })).previews;
      const needWorktree = ids.filter((id) => previews[id]?.has_worktree);
      const needUnsafe = needWorktree.filter((id) => previews[id] && !previews[id].safe);
      const costLine = (id: string): string => {
        const p = previews[id];
        return `  ${shortId(id)}  branch ${p.branch}${p.dirty ? ", uncommitted changes" : ""}${p.ahead ? `, ${p.ahead} unlanded commit${p.ahead === 1 ? "" : "s"}` : ""}${p.reason ? ` (${p.reason})` : ""}`;
      };
      if (needWorktree.length && !o.discardWorktree) {
        throw usage(`moving discards the checkout of ${needWorktree.length} started task${needWorktree.length === 1 ? "" : "s"}:\n${needWorktree.map(costLine).join("\n")}\nRe-run with --discard-worktree to accept.`);
      }
      if (needUnsafe.length && !o.discardUnsafe) {
        throw usage(`these checkouts hold work that would be lost:\n${needUnsafe.map(costLine).join("\n")}\nRe-run with --discard-worktree --discard-unsafe to accept.`);
      }
      const discardWorktree = o.discardWorktree ? needWorktree : [];
      const discardUnsafe = o.discardUnsafe ? needUnsafe : [];
      if (ids.length === 1) {
        const res = await ctx.client.post<Task & { dropped_blockers?: string[]; dropped_dependents?: string[]; discarded?: unknown }>(
          `/api/tasks/${encodeURIComponent(ids[0])}/move`,
          { project_id: dest.id, discard_worktree: discardWorktree.length > 0, discard_unsafe: discardUnsafe.length > 0 },
        );
        if (ctx.emit(res)) return;
        ctx.println(`Moved ${shortId(ids[0])} to ${dest.name}.`);
        const dropped = [...(res.dropped_blockers ?? []), ...(res.dropped_dependents ?? [])];
        if (dropped.length) ctx.println(yellow(`Dropped ${dropped.length} dependency edge${dropped.length === 1 ? "" : "s"} that crossed projects.`));
        if (res.discarded) ctx.println(yellow("Its checkout was discarded."));
        return;
      }
      const res = await ctx.client.post<{ moved: string[]; unchanged: string[]; skipped: { id: string; reason: string }[]; dropped: unknown[]; discarded: unknown[] }>(
        "/api/tasks/move",
        { ids, project_id: dest.id, discard_worktree: discardWorktree, discard_unsafe: discardUnsafe },
      );
      if (ctx.emit(res)) {
        if (res.skipped.length) process.exitCode = 1;
        return;
      }
      ctx.println(`Moved ${res.moved.length} task${res.moved.length === 1 ? "" : "s"} to ${dest.name}${res.unchanged.length ? ` (${res.unchanged.length} already there)` : ""}.`);
      if (res.dropped.length) ctx.println(yellow(`Dropped ${res.dropped.length} dependency edge${res.dropped.length === 1 ? "" : "s"}.`));
      if (res.discarded.length) ctx.println(yellow(`Discarded ${res.discarded.length} checkout${res.discarded.length === 1 ? "" : "s"}.`));
      for (const s of res.skipped) ctx.println(`  skipped ${shortId(s.id)}: ${s.reason}`);
      if (res.skipped.length) process.exitCode = 1;
    });

  program
    .command("merge <task>")
    .description("merge the task branch into its base branch")
    .action(async (ref: string, _o: unknown, cmd: Command) => {
      const ctx = await makeCtx(cmd, io);
      const id = await resolveTask(ctx.client, ref);
      const r = await ctx.client.post<MergeResult & { code?: string }>(`/api/tasks/${encodeURIComponent(id)}/merge`, {}, { allow: [409] });
      if (ctx.emit(r)) {
        if (!r.ok) process.exitCode = 1;
        return;
      }
      if (r.ok) {
        ctx.println(r.alreadyMerged ? `Already merged into ${r.targetBranch}.` : `Merged ${shortId(id)} into ${r.targetBranch}${r.additions !== undefined ? ` (+${r.additions} -${r.deletions ?? 0})` : ""}.`);
        return;
      }
      const lines = [r.error ?? "merge refused"];
      if (r.conflicts?.length) lines.push(`conflicts:\n${r.conflicts.map((c) => `  ${c}`).join("\n")}`);
      if (r.dirty?.length) lines.push(`uncommitted changes in the main checkout:\n${r.dirty.map((d) => `  ${d.code} ${d.path}`).join("\n")}`);
      if (r.code === "review_required") lines.push("Resolve the required review in the web UI first.");
      throw new CliError(lines.join("\n"), 1);
    });

  program
    .command("pr <task>")
    .description("push the task branch and open (or update) its pull request")
    .option("--title <title>", "PR title")
    .action(async (ref: string, o: { title?: string }, cmd: Command) => {
      const ctx = await makeCtx(cmd, io);
      const id = await resolveTask(ctx.client, ref);
      const r = await ctx.client.post<PrResult>(`/api/tasks/${encodeURIComponent(id)}/pr`, o.title ? { title: o.title } : {}, { allow: [409] });
      if (ctx.emit(r)) {
        if (!r.ok) process.exitCode = 1;
        return;
      }
      if (!r.ok) throw new CliError([r.error ?? "could not open the PR", r.detail].filter(Boolean).join("\n"), 1);
      ctx.println(`${r.existing ? "Updated existing PR" : "Opened PR"}: ${r.url}`);
      if (r.editError) ctx.println(yellow(`The push landed but editing the PR failed: ${r.editError}`));
    });
}

async function applyPatch(ctx: Ctx, id: string, patch: Record<string, unknown>, message?: string): Promise<void> {
  try {
    const task = await ctx.client.patch<Task>(`/api/tasks/${encodeURIComponent(id)}`, patch);
    if (ctx.emit(task)) return;
    ctx.println(message ?? `Updated ${shortId(id)}: ${Object.entries(patch).map(([k, v]) => `${k}=${String(v)}`).join(", ")}`);
  } catch (e) {
    throw reviewHint(e);
  }
}

async function deleteOne(ctx: Ctx, id: string, message: string): Promise<void> {
  try {
    await ctx.client.delete(`/api/tasks/${encodeURIComponent(id)}`);
  } catch (e) {
    throw reviewHint(e);
  }
  if (!ctx.emit({ id, deleted: true })) ctx.println(message);
}

/** A 409 `review_required` needs a human decision that only the web UI can record. */
function reviewHint(e: unknown): unknown {
  if (e instanceof HttpError && e.status === 409 && (e.body as { code?: string } | null)?.code === "review_required") {
    return new CliError(`${e.message}\nThis task has a required review. Accept or waive it in the Calandria web UI, then retry.`, 1);
  }
  return e;
}
