import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFakeServer } from "./fakeServer.js";
import { cli } from "./helpers.js";

let srv: Awaited<ReturnType<typeof startFakeServer>>;
beforeEach(async () => {
  srv = await startFakeServer();
});
afterEach(async () => {
  await srv.close();
});

const waitFor = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("end to end against a fake Calandria", () => {
  it("new -> start -> watch (permission card) -> answer -> set -> move -> rm", async () => {
    const base = ["--url", srv.url];

    const created = await cli([...base, "new", "Fix the bug", "--project", "demo", "--description", "details", "--tag", "feature"]);
    expect(created.code).toBe(0);
    expect(created.out).toContain("Created");
    const post = srv.requests.find((r) => r.method === "POST" && r.path === "/api/tasks");
    expect(post?.body).toMatchObject({ project_id: "projAAAA1111", title: "Fix the bug", description: "details", tag_ids: ["tagFEAT"] });

    const id = srv.TASK_ID.slice(0, 6);
    const listed = await cli([...base, "tasks"]);
    expect(listed.out).toContain("Fix the bug");

    const started = await cli([...base, "start", id]);
    expect(started.code).toBe(0);
    expect(srv.requests.some((r) => r.method === "POST" && r.path.endsWith("/messages") && (r.body as { text: string }).text === "")).toBe(true);

    // Watch in the background, answer once the card shows up.
    const out: string[] = [];
    const watching = cli([...base, "watch", id], { out: (s) => void out.push(s) });
    await waitFor(() => out.join("").includes("calandria answer"));
    const text = out.join("");
    expect(text).toContain("Hello world");
    expect(text).toContain("▸ Run npm test");
    expect(text).toContain(`calandria answer ${srv.TASK_ID.slice(0, 8)} --allow`);

    const answered = await cli([...base, "answer", id, "--always"]);
    expect(answered.code).toBe(0);
    expect(srv.requests.findLast((r) => r.path.endsWith("/answer"))?.body).toEqual({ askId: "toolu_perm_1", answers: [["allow_always"]] });

    const watched = await watching;
    expect(watched.code).toBe(0);

    const set = await cli([...base, "set", id, "--status", "on_hold", "--priority", "hi", "--auto-start", "on"]);
    expect(set.code).toBe(0);
    expect(srv.requests.findLast((r) => r.method === "PATCH")?.body).toEqual({ status: "on_hold", priority: "hi", auto_start: 1 });

    const moved = await cli([...base, "move", id, "--to", "other"]);
    expect(moved.code).toBe(0);
    expect(srv.state.movedTo).toBe("projBBBB2222");

    const refused = await cli([...base, "rm", id]);
    expect(refused.code).toBe(2);
    expect(refused.err).toContain("--yes");

    const removed = await cli([...base, "rm", id, "--yes", "--json"]);
    expect(removed.code).toBe(0);
    expect(JSON.parse(removed.out)).toEqual({ id: srv.TASK_ID, deleted: true });
    expect(srv.state.deleted).toBe(true);
  });

  it("watch --exit-on-ask prints the card and exits 0; --json streams NDJSON", async () => {
    await cli(["--url", srv.url, "new", "T", "--project", "Demo", "--start"]);
    const w = await cli(["--url", srv.url, "watch", srv.TASK_ID, "--exit-on-ask"]);
    expect(w.code).toBe(0);
    expect(w.out).toContain("permission requested");

    srv.state.task.running = 0;
    const j = await cli(["--url", srv.url, "--json", "watch", srv.TASK_ID]);
    const frames = j.out.trim().split("\n").map((l) => JSON.parse(l));
    expect(frames[0].type).toBe("snapshot");
  });

  it("never sends an Origin header and always sends a user-agent and bearer token", async () => {
    await cli(["--url", srv.url, "--token", "sekret", "projects"]);
    for (const r of srv.requests) {
      expect(r.headers.origin).toBeUndefined();
      expect(r.headers["user-agent"]).toMatch(/^calandria-cli\//);
      expect(r.headers.authorization).toBe("Bearer sekret");
    }
  });

  it("resolves a task by prefix, reports ambiguity and unknown refs with exit code 2", async () => {
    await cli(["--url", srv.url, "new", "T", "--project", "Demo"]);
    expect((await cli(["--url", srv.url, "show", "nopenope"])).code).toBe(2);
    const ambiguous = await cli(["--url", srv.url, "show", "tsk"]);
    expect(ambiguous.code).toBe(2);
    const ok = await cli(["--url", srv.url, "show", "tskABC", "--json"]);
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.out).id).toBe(srv.TASK_ID);
  });

  it("accepts a suggestion found only in the project rows", async () => {
    const r = await cli(["--url", srv.url, "accept", "tskSUGG"]);
    expect(r.code).toBe(0);
    expect(srv.requests.findLast((x) => x.method === "PATCH")?.path).toBe(`/api/tasks/${srv.SUGGESTED_ID}`);
  });

  it("refuses a move that would discard a worktree until the flags are given", async () => {
    await cli(["--url", srv.url, "new", "T", "--project", "Demo"]);
    srv.state.worktreePreview = true;
    const refused = await cli(["--url", srv.url, "move", srv.TASK_ID, "--to", "Other"]);
    expect(refused.code).toBe(2);
    expect(refused.err).toContain("--discard-worktree");
    const half = await cli(["--url", srv.url, "move", srv.TASK_ID, "--to", "Other", "--discard-worktree"]);
    expect(half.code).toBe(2);
    expect(half.err).toContain("--discard-unsafe");
    const ok = await cli(["--url", srv.url, "move", srv.TASK_ID, "--to", "Other", "--discard-worktree", "--discard-unsafe"]);
    expect(ok.code).toBe(0);
    expect(srv.requests.findLast((x) => x.path.endsWith("/move") && x.method === "POST")?.body).toEqual({ project_id: "projBBBB2222", discard_worktree: true, discard_unsafe: true });
  });

  it("status, inbox and runbooks render", async () => {
    await cli(["--url", srv.url, "new", "T", "--project", "Demo"]);
    const status = await cli(["--url", srv.url, "status"]);
    expect(status.out).toContain("Calandria 9.9.9");
    expect((await cli(["--url", srv.url, "inbox"])).out).toContain("Nothing needs you");
    const rb = await cli(["--url", srv.url, "runbooks"]);
    expect(rb.out).toContain("Sweep");
    expect(rb.out).toContain("needs confirm");
  });

  it("login saves a profile that later commands use", async () => {
    const { makeIO } = await import("./helpers.js");
    const h = makeIO();
    const { run } = await import("../src/cli.js");
    expect(await run(["node", "calandria", "login", srv.url, "--name", "fake"], h.io)).toBe(0);
    expect(h.out()).toContain('profile "fake" (default)');
    const h2 = makeIO({ configFile: h.io.configFile });
    expect(await run(["node", "calandria", "profiles"], h2.io)).toBe(0);
    expect(h2.out()).toContain("fake");
    const h3 = makeIO({ configFile: h.io.configFile });
    expect(await run(["node", "calandria", "projects", "--json"], h3.io)).toBe(0);
    expect(JSON.parse(h3.out())).toHaveLength(2);
    const h4 = makeIO({ configFile: h.io.configFile });
    expect(await run(["node", "calandria", "logout"], h4.io)).toBe(0);
  });
});

describe("error reporting", () => {
  it("maps a rejected token to a clear message", async () => {
    const guarded = await startFakeServer({ token: "right" });
    try {
      const r = await cli(["--url", guarded.url, "--token", "wrong", "projects"]);
      expect(r.code).toBe(1);
      expect(r.err).toContain("token rejected (CALANDRIA_API_TOKEN mismatch)");
      const ok = await cli(["--url", guarded.url, "--token", "right", "projects"]);
      expect(ok.code).toBe(0);
    } finally {
      await guarded.close();
    }
  });

  it("exits 3 when the instance is unreachable", async () => {
    const r = await cli(["--url", "http://127.0.0.1:9", "projects"]);
    expect(r.code).toBe(3);
    expect(r.err).toContain("127.0.0.1:9");
  });

  it("exits 3 when discovery finds nothing", async () => {
    const r = await cli(["projects"]);
    expect(r.code).toBe(3);
  });
});
