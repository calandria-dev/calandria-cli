import type { Command } from "commander";
import { makeCtx, type IO } from "../context.js";
import { CliError, HttpError, usage } from "../errors.js";
import { dim, yellow } from "../color.js";
import { listProjects, listRunbooks, listSchedules, resolveProject, resolveRunbook, resolveSchedule, shortId } from "../resolve.js";
import { ago, table } from "../render.js";
import type { Schedule, Task } from "../types.js";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function describeSchedule(s: Schedule): string {
  if (s.once_date) return `once on ${s.once_date} at ${s.time_of_day} ${s.timezone}`;
  if (s.days_mask === 127) return `daily at ${s.time_of_day} ${s.timezone}`;
  if (s.days_mask === 62) return `weekdays at ${s.time_of_day} ${s.timezone}`;
  const days = DAYS.filter((_, i) => s.days_mask & (1 << i)).join(",");
  return `${days} at ${s.time_of_day} ${s.timezone}`;
}

export function registerRunbooks(program: Command, io: IO): void {
  program
    .command("runbooks")
    .description("list runbooks (saved task recipes)")
    .option("--project <project>", "only this project")
    .action(async (o: { project?: string }, cmd: Command) => {
      const ctx = await makeCtx(cmd, io);
      const projects = o.project ? [await resolveProject(ctx.client, o.project)] : await listProjects(ctx.client);
      const rows = await listRunbooks(ctx.client, projects);
      if (ctx.emit(rows)) return;
      ctx.println(
        table(rows, [
          { header: "ID", value: (r) => shortId(r.id) },
          { header: "PROJECT", value: (r) => r.project_name, max: 20 },
          { header: "NAME", value: (r) => r.name, max: 40 },
          { header: "AGENT", value: (r) => r.agent },
          { header: "LAST RUN", value: (r) => (r.last_run ? `${ago(r.last_run.created_at)} ago (${r.last_run.status})` : "never") },
          { header: "REVIEW", value: (r) => (r.agent_edit_revision > r.reviewed_agent_edit_revision ? yellow("needs confirm") : "") },
        ]) || "No runbooks.",
      );
    });

  program
    .command("run <runbook>")
    .description("run a runbook: mint a task and start it")
    .option("--project <project>", "disambiguate a runbook name by project")
    .option("--title <title>", "task title")
    .option("--extra <text>", "extra text appended to the recipe's prompt")
    .option("--no-start", "create the task without starting it")
    .option("--confirm <revision>", "confirm an agent-written recipe at this revision")
    .action(async (ref: string, o: { project?: string; title?: string; extra?: string; start: boolean; confirm?: string }, cmd: Command) => {
      const ctx = await makeCtx(cmd, io);
      const rb = await resolveRunbook(ctx.client, ref, o.project);
      const body: Record<string, unknown> = {};
      if (o.title) body.title = o.title;
      if (o.extra) body.extra = o.extra;
      if (!o.start) body.start = false;
      if (o.confirm !== undefined) {
        const rev = Number.parseInt(o.confirm, 10);
        if (!Number.isInteger(rev)) throw usage("--confirm takes the recipe revision number");
        body.confirmed_recipe_revision = rev;
      }
      try {
        const res = await ctx.client.post<{ task: Task | null }>(`/api/runbooks/${encodeURIComponent(rb.id)}/run`, body);
        if (ctx.emit(res)) return;
        ctx.println(`${o.start ? "Started" : "Created"} ${res.task ? `${shortId(res.task.id)}: ${res.task.title}` : "a task"} from runbook "${rb.name}".`);
      } catch (e) {
        const b = e instanceof HttpError ? (e.body as { requires_confirmation?: boolean; recipe_revision?: number } | null) : null;
        if (e instanceof HttpError && e.status === 409 && b?.requires_confirmation) {
          throw new CliError(
            `${e.message}\nReview the recipe in the web UI, then run again with --confirm ${b.recipe_revision}.`,
            1,
          );
        }
        throw e;
      }
    });

  program
    .command("schedules")
    .description("list schedules")
    .option("--project <project>", "only this project")
    .action(async (o: { project?: string }, cmd: Command) => {
      const ctx = await makeCtx(cmd, io);
      const projects = o.project ? [await resolveProject(ctx.client, o.project)] : await listProjects(ctx.client);
      const rows = await listSchedules(ctx.client, projects);
      if (ctx.emit(rows)) return;
      ctx.println(
        table(rows, [
          { header: "ID", value: (s) => shortId(s.id) },
          { header: "PROJECT", value: (s) => s.project_name, max: 20 },
          { header: "NAME", value: (s) => s.name, max: 36 },
          { header: "WHEN", value: (s) => describeSchedule(s) },
          { header: "ON", value: (s) => (s.enabled ? "yes" : dim("no")) },
          { header: "NEXT", value: (s) => (s.enabled && s.next_fire_at ? new Date(s.next_fire_at).toISOString().replace("T", " ").slice(0, 16) : "") },
        ]) || "No schedules.",
      );
    });

  program
    .command("schedule-run <schedule>")
    .description("fire a schedule now")
    .option("--project <project>", "disambiguate a schedule name by project")
    .action(async (ref: string, o: { project?: string }, cmd: Command) => {
      const ctx = await makeCtx(cmd, io);
      const s = await resolveSchedule(ctx.client, ref, o.project);
      const run = await ctx.client.post<{ id?: string; task_id?: string | null; status?: string }>(`/api/schedules/${encodeURIComponent(s.id)}/run`);
      if (ctx.emit(run)) return;
      ctx.println(`Fired schedule "${s.name}"${run?.status ? ` (${run.status})` : ""}${run?.task_id ? `, task ${shortId(run.task_id)}` : ""}.`);
    });
}
