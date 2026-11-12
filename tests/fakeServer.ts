import http from "node:http";
import type { AddressInfo } from "node:net";

export interface Recorded {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

const TASK_ID = "tskABCDEFGH123456789x";
const SUGGESTED_ID = "tskSUGGEST9876543210y";
const PERM_ID = "toolu_perm_1";

/** A tiny scripted stand-in for Calandria's REST API, enough to drive the CLI end to end. */
export async function startFakeServer(opts: { token?: string } = {}) {
  const requests: Recorded[] = [];
  const streams = new Set<http.ServerResponse>();
  const state = {
    task: {
      id: TASK_ID,
      project_id: "projAAAA1111",
      title: "",
      description: "",
      priority: "med",
      status: "not_started",
      suggested: 0,
      agent: "claude",
      model: null as string | null,
      permission_mode: null,
      auto_start: 0,
      started: 0,
      running: 0,
      awaiting_input: 0,
      worktree_path: "",
      work_branch: "",
      merged_at: 0,
      pr_url: "",
    },
    created: false,
    deleted: false,
    cardPending: false,
    decided: undefined as string[][] | undefined,
    movedTo: undefined as string | undefined,
    worktreePreview: false,
    /** "finished": the turn is over before any watcher attaches. "late": it begins after the snapshot. */
    mode: "live" as "live" | "finished" | "late",
    extra: [] as unknown[],
  };
  const projects = [
    { id: "projAAAA1111", name: "Demo", repo_path: "/r/demo", branch: "main", default_agent: "claude", awaiting_count: 0 },
    { id: "projBBBB2222", name: "Other", repo_path: "/r/other", branch: "main", default_agent: "claude", awaiting_count: 0 },
  ];
  const suggested = { ...state.task, id: SUGGESTED_ID, title: "Suggested thing", suggested: 1 };

  const permissionCard = {
    id: PERM_ID,
    tool: "Bash",
    title: "Run npm test",
    detail: "npm test",
    scope: { label: "npm test" },
    expiresAt: 0,
  };
  const cardMessage = () => ({
    id: "m-card",
    generation: 1,
    role: "tool",
    created_at: 1,
    content: JSON.stringify({ title: "Run npm test", permission: { request: permissionCard } }),
  });
  const detail = () => ({ ...state.task, depends_on: [], tag_ids: [], messages: [...state.extra, ...(state.cardPending ? [cardMessage()] : [])] });

  const send = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const frame = (res: http.ServerResponse, ev: unknown) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
  const broadcast = (ev: unknown) => streams.forEach((r) => frame(r, ev));

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString();
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({ method: req.method ?? "GET", path: url.pathname + url.search, headers: req.headers, body });
    const p = url.pathname;
    const m = req.method;

    if (opts.token && req.headers.authorization !== `Bearer ${opts.token}`) {
      res.writeHead(401, { "content-type": "text/plain" });
      return void res.end("Unauthorized: bearer token does not match CALANDRIA_API_TOKEN.\n");
    }

    if (p === "/api/version") return send(res, 200, { version: "9.9.9", sha: "abc", builtAt: "now", instanceName: "fake" });
    if (p === "/api/projects" && m === "GET") return send(res, 200, projects);
    const proj = /^\/api\/projects\/([^/]+)$/.exec(p);
    if (proj && m === "GET") {
      const project = projects.find((x) => x.id === proj[1]);
      if (!project) return send(res, 404, { error: "not found" });
      const tasks = [
        ...(state.created && !state.deleted && state.task.project_id === project.id ? [state.task] : []),
        ...(project.id === "projAAAA1111" ? [suggested] : []),
      ];
      return send(res, 200, { ...project, tasks, tags: [{ id: "tagFEAT", project_id: project.id, name: "Feature" }] });
    }
    if (/^\/api\/projects\/[^/]+\/(runbooks|schedules)$/.test(p)) {
      if (p.endsWith("runbooks"))
        return send(res, 200, { runbooks: [{ id: "rbSWEEP0001", project_id: "projAAAA1111", name: "Sweep", description: "", agent: "claude", recipe_revision: 2, agent_edit_revision: 1, reviewed_agent_edit_revision: 0, last_run: null }] });
      return send(res, 200, { schedules: [] });
    }
    if (p === "/api/tasks" && m === "GET") {
      const rows = state.created && !state.deleted ? [{ id: state.task.id, project_id: state.task.project_id, title: state.task.title, status: state.task.status, running: state.task.running, awaiting_input: state.task.awaiting_input, updated_at: 1, project_name: "Demo", tags: [] }] : [];
      return send(res, 200, { tasks: rows, tags: [] });
    }
    if (p === "/api/tasks" && m === "POST") {
      state.created = true;
      Object.assign(state.task, { title: body.title, description: body.description ?? "", project_id: body.project_id, model: body.model ?? null, tag_ids: body.tag_ids });
      return send(res, 201, state.task);
    }
    if (p === "/api/needs-you") return send(res, 200, { tasks: state.cardPending ? [{ id: TASK_ID, project_id: "projAAAA1111", title: state.task.title, project_name: "Demo", waiting_since: Date.now() - 60000, reason: "input" }] : [] });
    if (p === "/api/tasks/move" && m === "GET") return send(res, 200, { previews: {} });
    const t = /^\/api\/tasks\/([^/]+)(?:\/([a-z]+))?$/.exec(p);
    if (t) {
      const [, id, sub] = t;
      if (id === SUGGESTED_ID && !sub && m === "GET") return send(res, 200, { ...suggested, messages: [] });
      if (id === SUGGESTED_ID && !sub && m === "PATCH") return send(res, 200, Object.assign(suggested, body));
      if (id === SUGGESTED_ID && !sub && m === "DELETE") return send(res, 200, { ok: true });
      if (id !== TASK_ID || state.deleted) return send(res, 404, { error: "not found" });
      if (!sub && m === "GET") return send(res, 200, detail());
      if (!sub && m === "PATCH") {
        Object.assign(state.task, body);
        return send(res, 200, state.task);
      }
      if (!sub && m === "DELETE") {
        state.deleted = true;
        return send(res, 200, { ok: true });
      }
      if (sub === "messages" && m === "POST") {
        if (!state.task.started && !state.task.running) {
          state.task.running = 1;
          state.task.started = 1;
          state.task.status = "in_progress";
          if (state.mode === "finished") {
            state.task.running = 0;
            state.extra.push({ id: "e1", generation: 1, role: "user", created_at: 1, content: "Begin" }, { id: "e2", generation: 1, role: "assistant", created_at: 2, content: "All done quickly." });
          } else if (state.mode === "late") state.task.running = 0;
          return send(res, 202, { ok: true, generation: 1 });
        }
        return send(res, 202, { ok: true, queued: true });
      }
      if (sub === "messages" && m === "GET") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(": ping\r\n\r\n");
        frame(res, { type: "snapshot", messages: [...state.extra, ...(state.cardPending ? [cardMessage()] : [])], pending: [], running: !!state.task.running });
        streams.add(res);
        req.on("close", () => streams.delete(res));
        if (state.mode === "late") {
          setTimeout(() => {
            frame(res, { type: "user", content: "Begin", msgId: "u1" });
            frame(res, { type: "assistant", content: "Late but visible." });
            frame(res, { type: "turn_end" });
          }, 100);
          return;
        }
        if (state.task.running && !state.cardPending && !state.decided) {
          setTimeout(() => {
            frame(res, { type: "user", content: "Begin", msgId: "u1" });
            frame(res, { type: "assistant_delta", id: "a1", kind: "assistant", delta: "Hello " });
            frame(res, { type: "assistant_delta", id: "a1", kind: "assistant", delta: "world" });
            frame(res, { type: "assistant", content: "Hello world" });
            frame(res, { type: "tool", id: "t1", name: "Bash", title: "Run npm test" });
            state.cardPending = true;
            state.task.awaiting_input = 1;
            frame(res, { type: "permission", request: permissionCard });
          }, 20);
        }
        return;
      }
      if (sub === "answer" && m === "POST") {
        state.decided = body.answers;
        state.cardPending = false;
        state.task.awaiting_input = 0;
        setTimeout(() => {
          broadcast({ type: "permission_decided", id: PERM_ID, outcome: { decision: body.answers[0][0] } });
          broadcast({ type: "assistant", content: "Tests pass." });
          state.task.running = 0;
          broadcast({ type: "turn_end" });
        }, 20);
        return send(res, 200, { resolved: true });
      }
      if (sub === "move" && m === "GET")
        return send(res, 200, state.worktreePreview ? { has_worktree: true, safe: false, dirty: true, ahead: 2, reason: "uncommitted changes", branch: "calandria/x" } : { has_worktree: false, safe: true, dirty: false, ahead: 0, reason: null, branch: "" });
      if (sub === "move" && m === "POST") {
        state.movedTo = body.project_id;
        state.task.project_id = body.project_id;
        return send(res, 200, { ...state.task, dropped_blockers: [], dropped_dependents: [], discarded: null });
      }
    }
    send(res, 404, { error: `no route ${m} ${p}` });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    state,
    TASK_ID,
    SUGGESTED_ID,
    close: async () => {
      streams.forEach((r) => r.end());
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
