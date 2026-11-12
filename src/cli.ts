#!/usr/bin/env node
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Command, CommanderError, Option } from "commander";
import { registerConnection } from "./commands/connection.js";
import { registerOverview } from "./commands/overview.js";
import { registerRunbooks } from "./commands/runbooks.js";
import { registerTasks } from "./commands/tasks.js";
import { registerWatch } from "./commands/watch.js";
import { applyColor, defaultIO, type IO } from "./context.js";
import { red } from "./color.js";
import { CliError, HttpError } from "./errors.js";
import { VERSION } from "./version.js";

export function buildProgram(io: IO): Command {
  const program = new Command();
  program
    .name("calandria")
    .description("Command-line client for Calandria: run and watch coding-agent tasks.")
    .version(VERSION)
    .option("--url <url>", "Calandria base URL (overrides CALANDRIA_URL, profiles and discovery)")
    .option("--token <token>", "API token (default: CALANDRIA_API_TOKEN or the profile's token)")
    .option("--profile <name>", "named profile from the config file (default: CALANDRIA_PROFILE or the config default)")
    .option("--json", "machine output: raw JSON, no colors")
    .addOption(new Option("--no-color", "disable colors (NO_COLOR is honored too)"))
    .enablePositionalOptions(false)
    .showHelpAfterError("(run with --help for usage)")
    .configureOutput({ writeOut: (s) => io.out(s), writeErr: (s) => io.err(s) })
    .exitOverride();
  registerConnection(program, io);
  registerOverview(program, io);
  registerTasks(program, io);
  registerWatch(program, io);
  registerRunbooks(program, io);
  return program;
}

/** Runs the CLI and returns the exit code: 0 ok, 1 runtime error, 2 usage, 3 connection. */
export async function run(argv: string[], io: IO = defaultIO()): Promise<number> {
  const program = buildProgram(io);
  process.exitCode = undefined;
  try {
    await program.parseAsync(argv);
    const code = process.exitCode as number | undefined;
    process.exitCode = undefined;
    return code ?? 0;
  } catch (e) {
    process.exitCode = undefined;
    if (e instanceof CommanderError) {
      if (e.code === "commander.helpDisplayed" || e.code === "commander.version" || e.code === "commander.help") return 0;
      return 2;
    }
    applyColor({ json: argv.includes("--json"), color: !argv.includes("--no-color") }, io);
    const message = e instanceof Error ? e.message : String(e);
    if (argv.includes("--json")) {
      io.err(`${JSON.stringify({ error: message, status: e instanceof HttpError ? e.status : undefined })}\n`);
    } else {
      io.err(`${red("error:")} ${message}\n`);
    }
    return e instanceof CliError ? e.exitCode : 1;
  }
}

function isMain(): boolean {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  // A closed pipe (`calandria tasks | head`) is a normal way to stop reading.
  process.stdout.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EPIPE") process.exit(0);
    throw e;
  });
  run(process.argv).then((code) => {
    // Flush buffered stdout/stderr before exiting, since open sockets can keep the loop alive.
    process.stderr.write("", () => process.stdout.write("", () => process.exit(code)));
  });
}
