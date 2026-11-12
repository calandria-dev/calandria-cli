import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { run } from "../src/cli.js";
import type { IO } from "../src/context.js";

export function tmpDir(prefix = "calandria-cli-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export interface Captured {
  code: number;
  out: string;
  err: string;
}

export function makeIO(over: Partial<IO> = {}): { io: IO; out: () => string; err: () => string } {
  let out = "";
  let err = "";
  const io: IO = {
    out: (s) => void (out += s),
    err: (s) => void (err += s),
    env: {},
    stdin: Readable.from([]),
    stdinIsTty: false,
    stdoutIsTty: false,
    sleep: async () => {},
    discover: async () => undefined,
    configFile: path.join(tmpDir(), "config.json"),
    ...over,
  };
  return { io, out: () => out, err: () => err };
}

export async function cli(argv: string[], over: Partial<IO> = {}): Promise<Captured> {
  const h = makeIO(over);
  const code = await run(["node", "calandria", ...argv], h.io);
  return { code, out: h.out(), err: h.err() };
}
