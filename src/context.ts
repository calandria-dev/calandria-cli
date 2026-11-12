import readline from "node:readline/promises";
import type { Command } from "commander";
import { Client, resolveInstance, type ResolveDeps } from "./client.js";
import { colorWanted, setColorEnabled } from "./color.js";
import { loadConfig } from "./config.js";
import { CliError } from "./errors.js";

/** Everything a command touches in the outside world, so tests can substitute it. */
export interface IO {
  out: (s: string) => void;
  err: (s: string) => void;
  env: NodeJS.ProcessEnv;
  stdin: NodeJS.ReadableStream;
  stdinIsTty: boolean;
  stdoutIsTty: boolean;
  fetchImpl?: typeof fetch;
  /** Path of the config file; defaults to the platform location. */
  configFile?: string;
  /** Sleep used between reconnect attempts. */
  sleep?: (ms: number) => Promise<void>;
  discover?: ResolveDeps["discover"];
}

export interface GlobalOpts {
  url?: string;
  token?: string;
  profile?: string;
  json?: boolean;
  color?: boolean;
}

export interface Ctx {
  client: Client;
  io: IO;
  json: boolean;
  println: (s?: string) => void;
  /** Prints JSON when --json is set and returns true; otherwise returns false. */
  emit: (data: unknown) => boolean;
}

export function defaultIO(): IO {
  return {
    out: (s) => void process.stdout.write(s),
    err: (s) => void process.stderr.write(s),
    env: process.env,
    stdin: process.stdin,
    stdinIsTty: Boolean(process.stdin.isTTY),
    stdoutIsTty: Boolean(process.stdout.isTTY),
  };
}

export function globalOpts(cmd: Command): GlobalOpts {
  return cmd.optsWithGlobals() as GlobalOpts;
}

export function applyColor(opts: GlobalOpts, io: IO): void {
  setColorEnabled(colorWanted(opts, io.env, io.stdoutIsTty));
}

export function makeOut(io: IO, json: boolean): Pick<Ctx, "println" | "emit"> {
  return {
    println: (s = "") => io.out(`${s}\n`),
    emit: (data) => {
      if (!json) return false;
      io.out(`${JSON.stringify(data)}\n`);
      return true;
    },
  };
}

/** Resolves the instance and builds a client for a command. */
export async function makeCtx(cmd: Command, io: IO): Promise<Ctx> {
  const opts = globalOpts(cmd);
  applyColor(opts, io);
  const config = io.configFile ? loadConfig(io.configFile) : loadConfig();
  const instance = await resolveInstance(opts, { env: io.env, config, discover: io.discover });
  const json = Boolean(opts.json);
  return { client: new Client(instance, io.fetchImpl), io, json, ...makeOut(io, json) };
}

export async function readStdin(io: IO): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of io.stdin) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as string));
  return Buffer.concat(chunks).toString("utf8");
}

/** Asks one question on the terminal. Throws when stdin is not a TTY. */
export async function prompt(io: IO, question: string): Promise<string> {
  if (!io.stdinIsTty) throw new CliError("cannot prompt: stdin is not a terminal", 2);
  const rl = readline.createInterface({ input: io.stdin as NodeJS.ReadableStream & { fd?: number }, output: process.stderr });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

export const sleepFor = (io: IO): ((ms: number) => Promise<void>) => io.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
