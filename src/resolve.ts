import type { Client } from "./client.js";
import { CliError, usage } from "./errors.js";
import type { Project, ProjectDetail, Runbook, Schedule, Task, TaskLite } from "./types.js";

export const MIN_PREFIX = 4;

export type Match<T> = { kind: "one"; item: T } | { kind: "none" } | { kind: "many"; items: T[] };

/** Exact id wins; otherwise a unique prefix of at least MIN_PREFIX characters. */
export function matchId<T extends { id: string }>(items: T[], ref: string): Match<T> {
  const exact = items.find((i) => i.id === ref);
  if (exact) return { kind: "one", item: exact };
  if (ref.length < MIN_PREFIX) return { kind: "none" };
  const hits = items.filter((i) => i.id.startsWith(ref));
  if (hits.length === 1) return { kind: "one", item: hits[0] };
  if (hits.length > 1) return { kind: "many", items: hits };
  return { kind: "none" };
}

/** Id (exact or prefix) first, then a case-insensitive exact name. */
export function matchIdOrName<T extends { id: string; name: string }>(items: T[], ref: string): Match<T> {
  const byId = matchId(items, ref);
  if (byId.kind !== "none") return byId;
  const lower = ref.toLowerCase();
  const hits = items.filter((i) => i.name.toLowerCase() === lower);
  if (hits.length === 1) return { kind: "one", item: hits[0] };
  if (hits.length > 1) return { kind: "many", items: hits };
  return { kind: "none" };
}

export const shortId = (id: string): string => id.slice(0, 8);

function settle<T>(m: Match<T>, what: string, ref: string, describe: (t: T) => string): T {
  if (m.kind === "one") return m.item;
  if (m.kind === "none") throw usage(`no ${what} matches "${ref}"`);
  throw usage(`"${ref}" is ambiguous. ${m.items.length} ${what}s match:\n${m.items.map((t) => `  ${describe(t)}`).join("\n")}`);
}

export async function listProjects(client: Client): Promise<Project[]> {
  return client.get<Project[]>("/api/projects");
}

export async function resolveProject(client: Client, ref: string): Promise<Project> {
  const projects = await listProjects(client);
  return settle(matchIdOrName(projects, ref), "project", ref, (p) => `${shortId(p.id)}  ${p.name}`);
}

export async function listTasksLite(client: Client): Promise<TaskLite[]> {
  const res = await client.get<{ tasks: TaskLite[] }>("/api/tasks");
  return res.tasks;
}

/**
 * Resolves a task id or unique prefix. GET /api/tasks omits suggested tasks, so when the lite list has no
 * match the per-project rows (which include them) are searched too.
 */
export async function resolveTaskId(client: Client, ref: string): Promise<string> {
  const lite = matchId(await listTasksLite(client), ref);
  if (lite.kind === "one") return lite.item.id;
  if (lite.kind === "many") settle(lite, "task", ref, (t) => `${shortId(t.id)}  ${t.project_name}  ${t.title}`);
  const rows = await allProjectTasks(client);
  const m = matchId(rows.map((r) => r.task), ref);
  if (m.kind === "one") return m.item.id;
  if (m.kind === "many") {
    const byId = new Map(rows.map((r) => [r.task.id, r]));
    settle(m, "task", ref, (t) => `${shortId(t.id)}  ${byId.get(t.id)?.project.name ?? ""}  ${t.title}`);
  }
  throw usage(`no task matches "${ref}"`);
}

export async function allProjectTasks(client: Client): Promise<{ project: ProjectDetail; task: Task }[]> {
  const projects = await listProjects(client);
  const details = await Promise.all(projects.map((p) => client.get<ProjectDetail>(`/api/projects/${encodeURIComponent(p.id)}`)));
  return details.flatMap((project) => project.tasks.map((task) => ({ project, task })));
}

export async function resolveTask(client: Client, ref: string): Promise<string> {
  return resolveTaskId(client, ref);
}

export async function listRunbooks(client: Client, projects: Project[]): Promise<(Runbook & { project_name: string })[]> {
  const lists = await Promise.all(
    projects.map(async (p) => {
      const res = await client.get<{ runbooks: Runbook[] }>(`/api/projects/${encodeURIComponent(p.id)}/runbooks`);
      return res.runbooks.map((r) => ({ ...r, project_name: p.name }));
    }),
  );
  return lists.flat();
}

export async function listSchedules(client: Client, projects: Project[]): Promise<(Schedule & { project_name: string })[]> {
  const lists = await Promise.all(
    projects.map(async (p) => {
      const res = await client.get<{ schedules: Schedule[] }>(`/api/projects/${encodeURIComponent(p.id)}/schedules`);
      return res.schedules.map((s) => ({ ...s, project_name: p.name }));
    }),
  );
  return lists.flat();
}

export async function resolveRunbook(client: Client, ref: string, projectRef?: string): Promise<Runbook & { project_name: string }> {
  const projects = projectRef ? [await resolveProject(client, projectRef)] : await listProjects(client);
  const all = await listRunbooks(client, projects);
  return settle(matchIdOrName(all, ref), "runbook", ref, (r) => `${shortId(r.id)}  ${r.project_name} / ${r.name}`);
}

export async function resolveSchedule(client: Client, ref: string, projectRef?: string): Promise<Schedule & { project_name: string }> {
  const projects = projectRef ? [await resolveProject(client, projectRef)] : await listProjects(client);
  const all = await listSchedules(client, projects);
  return settle(matchIdOrName(all, ref), "schedule", ref, (s) => `${shortId(s.id)}  ${s.project_name} / ${s.name}`);
}

/** Resolves tag names (case-insensitive) or ids within one project's tag list. */
export function resolveTags(tags: { id: string; name: string }[], refs: string[]): string[] {
  return refs.map((ref) => {
    const m = matchIdOrName(tags, ref);
    if (m.kind === "one") return m.item.id;
    if (m.kind === "many") throw usage(`tag "${ref}" is ambiguous`);
    throw new CliError(`no tag "${ref}" in this project (known: ${tags.map((t) => t.name).join(", ") || "none"})`, 2);
  });
}
