import type { Command } from "commander";
import { answerFor, pendingCards, webOnlyReason, type AnswerFlags, type Card } from "../cards.js";
import { bold, cyan, dim, green, red, yellow } from "../color.js";
import { makeCtx, prompt, sleepFor, type Ctx, type IO } from "../context.js";
import { CliError, HttpError, usage } from "../errors.js";
import { renderCard, renderMessage, truncate } from "../render.js";
import { resolveTask, shortId } from "../resolve.js";
import type { AskAnswers, GlobalEvent, GlobalTaskEvent, TaskDetail, TaskEvent } from "../types.js";

export interface WatchOptions {
  /** Keep streaming after the turn ends. */
  follow?: boolean;
  /** Prompt on a TTY when a card arrives. */
  interactive?: boolean;
  /** Exit 0 as soon as a card needs an answer. */
  exitOnCard?: boolean;
  /**
   * Transcript length recorded before a start/send in this invocation. The snapshot renders every message
   * past it, so a turn that finished before the stream attached is still shown.
   */
  since?: number;
  /** How long to wait for a just-started turn to register when the snapshot shows no new messages. */
  startWaitMs?: number;
}

const BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 15000];
const MAX_FAILURES = 8;

export async function submitAnswer(ctx: Ctx, taskId: string, card: Card, answers: AskAnswers): Promise<boolean> {
  const res = await ctx.client.post<{ resolved: boolean }>(`/api/tasks/${encodeURIComponent(taskId)}/answer`, { askId: card.id, answers });
  return Boolean(res?.resolved);
}

/** Asks on the terminal and builds the answer for a card. Returns undefined when the user skips. */
async function askInline(ctx: Ctx, card: Card): Promise<AskAnswers | undefined> {
  if (webOnlyReason(card)) return undefined;
  if (card.kind === "permission") {
    const a = (await prompt(ctx.io, "[a]llow once / allow al[w]ays / [d]eny / [s]kip: ")).toLowerCase();
    if (a === "a" || a === "allow") return answerFor(card, { allow: true });
    if (a === "w" || a === "always") return answerFor(card, { always: true });
    if (a === "d" || a === "deny") {
      const note = await prompt(ctx.io, "Reason (optional): ");
      return answerFor(card, { deny: note || true });
    }
    return undefined;
  }
  const answers: string[][] = [];
  for (const q of card.questions) {
    const raw = await prompt(ctx.io, `${q.question}${q.multiSelect ? " (numbers separated by commas)" : ""} [number or text, blank to skip]: `);
    if (!raw) return undefined;
    const picked = raw.split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
      const n = Number.parseInt(s, 10);
      return Number.isInteger(n) && String(n) === s && q.options[n - 1] ? q.options[n - 1].label : s;
    });
    answers.push(q.multiSelect ? picked : [picked.join(", ")]);
  }
  return answers;
}

/**
 * Streams a task's transcript until its turn ends (or forever with `follow`), reconnecting on a dropped
 * connection. Returns the exit code: 1 when the turn reported an error, else 0.
 */
export async function watchTask(ctx: Ctx, taskId: string, opts: WatchOptions): Promise<number> {
  const { io } = ctx;
  const sleep = sleepFor(io);
  const seenCards = new Set<string>();
  let midLine = false;
  let streaming = false;
  let sawError = false;

  const write = (s: string): void => {
    io.out(s);
    midLine = !s.endsWith("\n");
  };
  const line = (s: string): void => {
    if (midLine) write("\n");
    write(`${s}\n`);
  };

  const showCard = async (card: Card): Promise<"exit" | undefined> => {
    if (seenCards.has(card.id)) return undefined;
    seenCards.add(card.id);
    line(renderCard(card, taskId));
    if (opts.exitOnCard) return "exit";
    if (opts.interactive && io.stdinIsTty && !webOnlyReason(card)) {
      const answers = await askInline(ctx, card);
      if (answers) {
        await submitAnswer(ctx, taskId, card, answers);
        line(dim("answer sent"));
      }
    }
    return undefined;
  };

  const handle = async (ev: TaskEvent): Promise<"exit" | "wait" | undefined> => {
    switch (ev.type) {
      case "snapshot": {
        const e = ev as Extract<TaskEvent, { type: "snapshot" }>;
        const fresh = opts.since === undefined ? [] : e.messages.slice(Math.min(opts.since, e.messages.length));
        for (const m of fresh) line(renderMessage(m));
        let exit: "exit" | undefined;
        for (const card of pendingCards(e.messages)) exit = (await showCard(card)) ?? exit;
        if (exit) return exit;
        if (!e.running && !opts.follow) {
          if (opts.since !== undefined && fresh.length === 0) return "wait";
          if (fresh.length === 0) line(dim("task is idle (no turn running)"));
          return "exit";
        }
        return undefined;
      }
      case "user":
        line(`${bold(cyan("> you"))} ${truncate((ev as { content: string }).content, 200)}`);
        return undefined;
      case "queued":
        line(dim(`queued: ${truncate((ev as { content: string }).content, 120)}`));
        return undefined;
      case "assistant_delta": {
        const d = ev as Extract<TaskEvent, { type: "assistant_delta" }>;
        if (d.kind !== "assistant") return undefined;
        streaming = true;
        write(d.delta);
        return undefined;
      }
      case "assistant": {
        const text = (ev as { content: string }).content;
        if (streaming) {
          streaming = false;
          if (midLine) write("\n");
        } else {
          line(text);
        }
        return undefined;
      }
      case "tool":
        line(`${dim("▸")} ${(ev as { title: string }).title}`);
        return undefined;
      case "tool_result": {
        const r = ev as Extract<TaskEvent, { type: "tool_result" }>;
        if (r.isError) line(red(`  ✗ ${truncate(r.content, 200)}`));
        return undefined;
      }
      case "notice":
        line(dim(`• ${(ev as { content: string }).content}`));
        return undefined;
      case "error":
        sawError = true;
        line(red(`✗ ${(ev as { content: string }).content}`));
        return undefined;
      case "ask":
        return showCard({ kind: "ask", id: (ev as { id: string }).id, questions: (ev as Extract<TaskEvent, { type: "ask" }>).questions });
      case "permission":
        return showCard({ kind: "permission", id: (ev as Extract<TaskEvent, { type: "permission" }>).request.id, request: (ev as Extract<TaskEvent, { type: "permission" }>).request });
      case "ask_answered":
        line(green("✓ question answered"));
        return undefined;
      case "permission_decided": {
        const o = (ev as Extract<TaskEvent, { type: "permission_decided" }>).outcome;
        line(o.decision === "deny" ? red(`✗ permission denied${o.auto ? " (automatically)" : ""}`) : green(`✓ permission ${o.decision.replace("_", " ")}`));
        return undefined;
      }
      case "permission_denied":
        line(red(`✗ refused: ${(ev as { tool: string }).tool}${(ev as { reason?: string }).reason ? ` (${(ev as { reason?: string }).reason})` : ""}`));
        return undefined;
      case "background_pending":
        line(dim(`… working in background: ${(ev as { note: string }).note}`));
        return undefined;
      case "background_resumed":
        line(dim(`• background work ${(ev as { status: string }).status}: ${truncate((ev as { summary: string }).summary, 120)}`));
        return undefined;
      case "turn_end":
      case "done":
        if (midLine) write("\n");
        if (!opts.follow) return "exit";
        line(dim("--- turn ended ---"));
        return undefined;
      default:
        return undefined;
    }
  };

  const path = `/api/tasks/${encodeURIComponent(taskId)}/messages`;
  let failures = 0;
  for (;;) {
    const ac = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let idleTimedOut = false;
    try {
      for await (const msg of ctx.client.stream(path, ac.signal)) {
        failures = 0;
        let ev: TaskEvent;
        try {
          ev = JSON.parse(msg.data) as TaskEvent;
        } catch {
          continue;
        }
        // Anything after the snapshot means the turn registered.
        if (ev.type !== "snapshot" && timer) {
          clearTimeout(timer);
          timer = undefined;
        }
        let verdict: "exit" | "wait" | undefined;
        if (ctx.json) {
          io.out(`${msg.data.replace(/\n/g, "")}\n`);
          if (ev.type === "turn_end" || ev.type === "done") {
            if (!opts.follow) return sawError ? 1 : 0;
          } else if (ev.type === "snapshot" && !(ev as { running: boolean }).running && !opts.follow) {
            const msgs = (ev as { messages: unknown[] }).messages;
            verdict = opts.since !== undefined && msgs.length <= opts.since ? "wait" : "exit";
          }
        } else {
          verdict = await handle(ev);
        }
        if (verdict === "exit") return sawError ? 1 : 0;
        if (verdict === "wait") {
          timer = setTimeout(() => {
            idleTimedOut = true;
            ac.abort();
          }, opts.startWaitMs ?? 5000);
        }
      }
    } catch (e) {
      if (idleTimedOut) {
        if (!ctx.json) line(dim("task is idle (no turn started)"));
        return 0;
      }
      if (e instanceof HttpError) throw e;
      if (!(e instanceof CliError) && !(e instanceof TypeError) && (e as Error).name !== "AbortError" && !/terminated|fetch failed|ECONN|socket|network/i.test(String((e as Error)?.message))) throw e;
    }
    if (timer) clearTimeout(timer);
    if (idleTimedOut) {
      if (!ctx.json) line(dim("task is idle (no turn started)"));
      return 0;
    }
    failures++;
    if (failures > MAX_FAILURES) throw new CliError(`lost the connection to ${ctx.client.baseUrl} and could not reconnect`, 3);
    line(dim(`connection dropped, reconnecting (attempt ${failures})...`));
    await sleep(BACKOFF_MS[Math.min(failures - 1, BACKOFF_MS.length - 1)]);
  }
}

/** Pending cards for a task, read from its persisted transcript. */
async function pendingFor(ctx: Ctx, id: string): Promise<Card[]> {
  const task = await ctx.client.get<TaskDetail>(`/api/tasks/${encodeURIComponent(id)}`);
  return pendingCards(task.messages);
}

export function registerWatch(program: Command, io: IO): void {
  program
    .command("watch <task>")
    .description("stream a task's live transcript until its turn ends")
    .option("--follow", "keep streaming after the turn ends")
    .option("--interactive", "prompt on a terminal when a permission or question card arrives")
    .option("--exit-on-ask", "exit 0 as soon as a card needs an answer")
    .action(async (ref: string, o: { follow?: boolean; interactive?: boolean; exitOnAsk?: boolean }, cmd: Command) => {
      const ctx = await makeCtx(cmd, io);
      const id = await resolveTask(ctx.client, ref);
      process.exitCode = await watchTask(ctx, id, { follow: o.follow, interactive: o.interactive, exitOnCard: o.exitOnAsk });
    });

  program
    .command("answer <task>")
    .description("answer the task's pending permission or question card")
    .option("--ask <id>", "the card id, when more than one is pending")
    .option("--allow", "permission: allow this call once")
    .option("--always", "permission: allow and remember the rule")
    .option("--deny [note]", "permission: deny, with an optional reason for the agent")
    .option("--choice <label...>", "question: option label(s) to pick")
    .option("--text <text>", "question: free-text answer")
    .action(async (ref: string, o: AnswerFlags & { ask?: string }, cmd: Command) => {
      const ctx = await makeCtx(cmd, io);
      const id = await resolveTask(ctx.client, ref);
      const cards = await pendingFor(ctx, id);
      if (cards.length === 0) throw new CliError(`task ${shortId(id)} has nothing waiting for an answer`, 1);
      let card: Card | undefined;
      if (o.ask) {
        card = cards.find((c) => c.id === o.ask) ?? cards.find((c) => c.id.startsWith(o.ask!));
        if (!card) throw usage(`no pending card "${o.ask}". Pending: ${cards.map((c) => c.id).join(", ")}`);
      } else if (cards.length > 1) {
        throw usage(`${cards.length} cards are pending; pass --ask <id>:\n${cards.map((c) => `  ${c.id}  ${c.kind === "permission" ? c.request.title : c.questions[0]?.question ?? ""}`).join("\n")}`);
      } else {
        card = cards[0];
      }
      const answers = answerFor(card, o);
      const resolved = await submitAnswer(ctx, id, card, answers);
      if (ctx.emit({ resolved, askId: card.id })) return;
      ctx.println(
        resolved
          ? `Answered ${card.kind === "permission" ? card.request.title : "the question"}.`
          : yellow("The card was no longer waiting (the turn was torn down). Send the answer as a normal message with `calandria send`."),
      );
    });

  program
    .command("events")
    .description("tail the global event stream, one line per event")
    .action(async (_o: unknown, cmd: Command) => {
      const ctx = await makeCtx(cmd, io);
      const sleep = sleepFor(io);
      let failures = 0;
      for (;;) {
        try {
          for await (const msg of ctx.client.stream("/api/events")) {
            failures = 0;
            if (ctx.json) {
              io.out(`${msg.data.replace(/\n/g, "")}\n`);
              continue;
            }
            try {
              ctx.println(formatGlobalEvent(JSON.parse(msg.data) as GlobalEvent));
            } catch {
              // ignore a frame that is not JSON
            }
          }
        } catch (e) {
          if (e instanceof HttpError) throw e;
        }
        failures++;
        if (failures > MAX_FAILURES) throw new CliError(`lost the connection to ${ctx.client.baseUrl}`, 3);
        io.err(`connection dropped, reconnecting (attempt ${failures})...\n`);
        await sleep(BACKOFF_MS[Math.min(failures - 1, BACKOFF_MS.length - 1)]);
      }
    });
}

export function formatGlobalEvent(ev: GlobalEvent, now = new Date()): string {
  const time = now.toTimeString().slice(0, 8);
  if (ev.type === "task") {
    const t = ev as GlobalTaskEvent;
    const flags = [t.running ? "running" : "", t.awaiting_input ? "awaiting-input" : ""].filter(Boolean).join(",");
    return `${dim(time)} task ${shortId(t.taskId)} ${t.event} status=${t.status}${flags ? ` [${flags}]` : ""} project=${shortId(t.projectId)}`;
  }
  const { type, ...rest } = ev as { type: string; [k: string]: unknown };
  const extras = Object.entries(rest)
    .filter(([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(" ");
  return `${dim(time)} ${type}${extras ? ` ${extras}` : ""}`;
}
