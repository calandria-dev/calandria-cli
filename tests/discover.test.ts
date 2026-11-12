import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { discoverLocal, sidecarCandidates } from "../src/discover.js";
import { tmpDir } from "./helpers.js";

const noFetch = (async () => {
  throw new Error("offline");
}) as unknown as typeof fetch;

function writeSidecar(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
}

describe("sidecarCandidates", () => {
  it("orders CALANDRIA_DB_DIR, ~/.calandria, then the legacy file", () => {
    expect(sidecarCandidates({ CALANDRIA_DB_DIR: "/db" }, "/h")).toEqual([
      path.join("/db", "calandria.lock.json"),
      path.join("/db", "orchestrator.lock.json"),
      path.join("/h", ".calandria", "calandria.lock.json"),
      path.join("/h", ".zen-orchestrator", "orchestrator.lock.json"),
    ]);
  });
});

describe("discoverLocal", () => {
  it("uses the lock sidecar url when the pid is alive on this host", async () => {
    const home = tmpDir();
    writeSidecar(path.join(home, ".calandria", "calandria.lock.json"), { pid: 4242, host: "box", startedAt: 1, url: "http://127.0.0.1:4555/" });
    const found = await discoverLocal({ env: {}, home, hostname: "box", isAlive: (pid) => pid === 4242, fetchImpl: noFetch, ports: [] });
    expect(found?.url).toBe("http://127.0.0.1:4555");
    expect(found?.how).toMatch(/lock file/);
  });

  it("prefers CALANDRIA_DB_DIR over the home directory", async () => {
    const home = tmpDir();
    const db = tmpDir();
    writeSidecar(path.join(home, ".calandria", "calandria.lock.json"), { pid: 1, host: "box", url: "http://home" });
    writeSidecar(path.join(db, "calandria.lock.json"), { pid: 1, host: "box", url: "http://db" });
    const found = await discoverLocal({ env: { CALANDRIA_DB_DIR: db }, home, hostname: "box", isAlive: () => true, fetchImpl: noFetch, ports: [] });
    expect(found?.url).toBe("http://db");
  });

  it("reads the legacy orchestrator sidecar", async () => {
    const home = tmpDir();
    writeSidecar(path.join(home, ".zen-orchestrator", "orchestrator.lock.json"), { pid: 1, host: "box", url: "http://legacy" });
    const found = await discoverLocal({ env: {}, home, hostname: "box", isAlive: () => true, fetchImpl: noFetch, ports: [] });
    expect(found?.url).toBe("http://legacy");
  });

  it("skips a sidecar whose pid is dead, whose host differs, or that has no url", async () => {
    const home = tmpDir();
    writeSidecar(path.join(home, ".calandria", "calandria.lock.json"), { pid: 1, host: "box", url: "http://dead" });
    expect(await discoverLocal({ env: {}, home, hostname: "box", isAlive: () => false, fetchImpl: noFetch, ports: [] })).toBeUndefined();
    expect(await discoverLocal({ env: {}, home, hostname: "other", isAlive: () => true, fetchImpl: noFetch, ports: [] })).toBeUndefined();
    writeSidecar(path.join(home, ".calandria", "calandria.lock.json"), { pid: 1, host: "box" });
    expect(await discoverLocal({ env: {}, home, hostname: "box", isAlive: () => true, fetchImpl: noFetch, ports: [] })).toBeUndefined();
  });

  it("falls back to probing ports for a JSON /api/version", async () => {
    const good = http.createServer((_q, r) => {
      r.setHeader("content-type", "application/json");
      r.end('{"version":"1.2.3"}');
    });
    const html = http.createServer((_q, r) => r.end("<html></html>"));
    await Promise.all([good, html].map((s) => new Promise<void>((res) => s.listen(0, "127.0.0.1", res))));
    const goodPort = (good.address() as AddressInfo).port;
    const htmlPort = (html.address() as AddressInfo).port;
    try {
      const found = await discoverLocal({ env: {}, home: tmpDir(), hostname: "box", ports: [htmlPort, goodPort], timeoutMs: 500 });
      expect(found?.url).toBe(`http://127.0.0.1:${goodPort}`);
    } finally {
      good.close();
      html.close();
    }
  });

  it("returns undefined when nothing answers", async () => {
    expect(await discoverLocal({ env: {}, home: tmpDir(), hostname: "box", fetchImpl: noFetch, ports: [3000, 3001] })).toBeUndefined();
  });
});
