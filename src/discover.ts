import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LockSidecar } from "./types.js";

export interface DiscoverDeps {
  env?: NodeJS.ProcessEnv;
  home?: string;
  hostname?: string;
  fetchImpl?: typeof fetch;
  isAlive?: (pid: number) => boolean;
  ports?: number[];
  timeoutMs?: number;
  host?: string;
}

export interface Discovered {
  url: string;
  how: string;
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process exists but belongs to someone else.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Where the server may have written its lock sidecar, most specific first. */
export function sidecarCandidates(env: NodeJS.ProcessEnv, home: string): string[] {
  const out: string[] = [];
  if (env.CALANDRIA_DB_DIR) {
    out.push(path.join(env.CALANDRIA_DB_DIR, "calandria.lock.json"));
    out.push(path.join(env.CALANDRIA_DB_DIR, "orchestrator.lock.json"));
  }
  out.push(path.join(home, ".calandria", "calandria.lock.json"));
  out.push(path.join(home, ".zen-orchestrator", "orchestrator.lock.json"));
  return out;
}

export function readSidecar(file: string): LockSidecar | undefined {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<LockSidecar>;
    if (typeof v?.pid !== "number" || typeof v.host !== "string") return undefined;
    return v as LockSidecar;
  } catch {
    return undefined;
  }
}

/** Probes one base URL's /api/version; true when it answers JSON with a version. */
export async function probeVersion(base: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<boolean> {
  try {
    const res = await fetchImpl(`${base}/api/version`, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
    if (!res.ok) return false;
    const body = (await res.json()) as { version?: unknown };
    return typeof body?.version === "string";
  } catch {
    return false;
  }
}

/** Finds a Calandria on this machine: the lock sidecar first, then a loopback port probe. */
export async function discoverLocal(deps: DiscoverDeps = {}): Promise<Discovered | undefined> {
  const env = deps.env ?? process.env;
  const home = deps.home ?? os.homedir();
  const hostname = deps.hostname ?? os.hostname();
  const alive = deps.isAlive ?? pidAlive;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 300;
  const host = deps.host ?? "127.0.0.1";

  for (const file of sidecarCandidates(env, home)) {
    const side = readSidecar(file);
    if (!side?.url) continue;
    if (side.host !== hostname) continue;
    if (!alive(side.pid)) continue;
    return { url: side.url.replace(/\/+$/, ""), how: `lock file ${file}` };
  }

  const ports = deps.ports ?? Array.from({ length: 20 }, (_, i) => 3000 + i);
  const hits = await Promise.all(
    ports.map(async (port) => ((await probeVersion(`http://${host}:${port}`, fetchImpl, timeoutMs)) ? port : 0)),
  );
  const port = hits.find((p) => p > 0);
  if (port) return { url: `http://${host}:${port}`, how: `port probe on ${host}:${port}` };
  return undefined;
}
