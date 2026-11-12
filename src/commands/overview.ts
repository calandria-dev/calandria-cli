import type { Command } from "commander";
import { dim } from "../color.js";
import { makeCtx, type IO } from "../context.js";
import { listProjects, listTasksLite, resolveProject, shortId } from "../resolve.js";
import { ago, table, taskLiteRows, truncate } from "../render.js";
import type { NeedsYouRow, VersionInfo } from "../types.js";

export function registerOverview(program: Command, io: IO): void {
  program
    .command("status")
    .description("instance URL, version, and running / needs-you counts per project")
    .action(async (_o: unknown, cmd: Command) => {
      const ctx = await makeCtx(cmd, io);
      const [version, projects, tasks, needs] = await Promise.all([
        ctx.client.get<VersionInfo>("/api/version"),
        listProjects(ctx.client),
        listTasksLite(ctx.client),
        ctx.client.get<{ tasks: NeedsYouRow[] }>("/api/needs-you"),
      ]);
      const rows = projects.map((p) => {
        const mine = tasks.filter((t) => t.project_id === p.id);
        return {
          project: p.name,
          id: p.id,
          running: mine.filter((t) => t.running).length,
          awaiting_input: p.awaiting_count ?? mine.filter((t) => t.awaiting_input).length,
          open: mine.filter((t) => t.status !== "done" && t.status !== "cancelled").length,
        };
      });
      const summary = {
        url: ctx.client.baseUrl,
        resolvedFrom: ctx.client.instance.source,
        version: version.version,
        instanceName: version.instanceName ?? null,
        running: tasks.filter((t) => t.running).length,
        needsYou: needs.tasks.length,
        projects: rows,
      };
      if (ctx.emit(summary)) return;
      ctx.println(`${ctx.client.baseUrl}  Calandria ${version.version}${version.instanceName ? `  (${version.instanceName})` : ""}`);
      ctx.println(dim(`resolved from ${summary.resolvedFrom}`));
      ctx.println(`${summary.running} running, ${summary.needsYou} need you`);
      if (rows.length) {
        ctx.println();
        ctx.println(
          table(rows, [
            { header: "PROJECT", value: (r) => r.project, max: 30 },
            { header: "RUNNING", value: (r) => String(r.running) },
            { header: "NEEDS YOU", value: (r) => String(r.awaiting_input) },
            { header: "OPEN", value: (r) => String(r.open) },
          ]),
        );
      }
    });

  program
    .command("projects [sub]")
    .description("list projects (`projects ls` is the same)")
    .action(async (sub: string | undefined, _o: unknown, cmd: Command) => {
      if (sub !== undefined && sub !== "ls") cmd.error(`unknown argument "${sub}" (did you mean \`projects ls\`?)`, { exitCode: 2 });
      const ctx = await makeCtx(cmd, io);
      const projects = await listProjects(ctx.client);
      if (ctx.emit(projects)) return;
      ctx.println(
        table(projects, [
          { header: "ID", value: (p) => shortId(p.id) },
          { header: "NAME", value: (p) => p.name, max: 30 },
          { header: "BRANCH", value: (p) => p.branch },
          { header: "AGENT", value: (p) => p.default_agent },
          { header: "NEEDS YOU", value: (p) => String(p.awaiting_count ?? 0) },
          { header: "REPO", value: (p) => p.repo_path, max: 50 },
        ]) || "No projects.",
      );
    });

  program
    .command("tasks")
    .description("list tasks (done and cancelled are hidden unless --all or --status)")
    .option("--project <project>", "only this project (id or name)")
    .option("--status <status>", "only this status")
    .option("--running", "only tasks with a live turn")
    .option("--needs-you", "only tasks waiting on you")
    .option("--all", "include done and cancelled")
    .action(async (o: { project?: string; status?: string; running?: boolean; needsYou?: boolean; all?: boolean }, cmd: Command) => {
      const ctx = await makeCtx(cmd, io);
      let rows = await listTasksLite(ctx.client);
      if (o.project) {
        const p = await resolveProject(ctx.client, o.project);
        rows = rows.filter((t) => t.project_id === p.id);
      }
      if (o.status) rows = rows.filter((t) => t.status === o.status);
      else if (!o.all) rows = rows.filter((t) => t.status !== "done" && t.status !== "cancelled");
      if (o.running) rows = rows.filter((t) => t.running);
      if (o.needsYou) rows = rows.filter((t) => t.awaiting_input);
      if (ctx.emit(rows)) return;
      ctx.println(taskLiteRows(rows) || "No matching tasks.");
    });

  program
    .command("inbox")
    .description("tasks that need you: open questions, permission cards, failing CI")
    .action(async (_o: unknown, cmd: Command) => {
      const ctx = await makeCtx(cmd, io);
      const { tasks } = await ctx.client.get<{ tasks: NeedsYouRow[] }>("/api/needs-you");
      if (ctx.emit(tasks)) return;
      ctx.println(
        table(tasks, [
          { header: "ID", value: (t) => shortId(t.id) },
          { header: "PROJECT", value: (t) => t.project_name, max: 20 },
          { header: "WHY", value: (t) => (t.reason === "ci" ? `CI${t.pr_number ? ` #${t.pr_number}` : ""}` : "input") },
          { header: "WAITING", value: (t) => ago(t.waiting_since) },
          { header: "TITLE", value: (t) => truncate(t.title, 70) },
        ]) || "Nothing needs you.",
      );
    });
}
