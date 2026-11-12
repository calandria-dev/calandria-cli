import type { AskAnswers, AskQuestion, Message, PermissionDecision, PermissionRequest, ToolData } from "./types.js";
import { usage } from "./errors.js";

export type Card =
  | { kind: "ask"; id: string; questions: AskQuestion[] }
  | { kind: "permission"; id: string; request: PermissionRequest };

export const cardId = (c: Card): string => c.id;

/** True when the card cannot be answered from a terminal and needs the web UI. */
export function webOnlyReason(card: Card): string | undefined {
  if (card.kind !== "permission") return undefined;
  const r = card.request;
  if (r.kind === "environment") return "This is an environment-change proposal. It can only be decided in the Calandria web UI.";
  if (r.privateInput && (r.privateInput.name || r.privateInput.value)) return "This card collects a secret. Enter it in the Calandria web UI.";
  return undefined;
}

/** Cards in a transcript that no one has answered yet, oldest first. */
export function pendingCards(messages: Message[]): Card[] {
  const out: Card[] = [];
  for (const m of messages) {
    if (m.role !== "tool") continue;
    let d: ToolData;
    try {
      d = JSON.parse(m.content) as ToolData;
    } catch {
      continue;
    }
    if (d.ask && !d.ask.answers && !d.ask.dismissed) out.push({ kind: "ask", id: d.ask.id, questions: d.ask.questions });
    else if (d.permission && !d.permission.outcome) out.push({ kind: "permission", id: d.permission.request.id, request: d.permission.request });
  }
  return out;
}

export interface AnswerFlags {
  allow?: boolean;
  always?: boolean;
  deny?: boolean | string;
  choice?: string[];
  text?: string;
}

export function permissionAnswer(flags: AnswerFlags): AskAnswers {
  const picked = [flags.allow ? 1 : 0, flags.always ? 1 : 0, flags.deny !== undefined && flags.deny !== false ? 1 : 0].reduce((a, b) => a + b, 0);
  if (picked !== 1) throw usage("a permission card needs exactly one of --allow, --always or --deny [note]");
  let decision: PermissionDecision = "allow_once";
  if (flags.always) decision = "allow_always";
  if (flags.deny !== undefined && flags.deny !== false) decision = "deny";
  const note = typeof flags.deny === "string" ? flags.deny : "";
  return [note ? [decision, note] : [decision]];
}

/**
 * Builds the answer for an ask card. `--choice` values match option labels (case-insensitive) of the question
 * they belong to; `--text` supplies free text for the first question that matched no option.
 */
export function askAnswer(questions: AskQuestion[], flags: AnswerFlags): AskAnswers {
  const choices = flags.choice ?? [];
  const unused = new Set(choices.map((_, i) => i));
  const answers: string[][] = questions.map(() => []);
  questions.forEach((q, qi) => {
    choices.forEach((c, ci) => {
      const opt = q.options.find((o) => o.label.toLowerCase() === c.toLowerCase());
      if (!opt || !unused.has(ci)) return;
      if (!q.multiSelect && answers[qi].length > 0) return;
      answers[qi].push(opt.label);
      unused.delete(ci);
    });
  });
  if (unused.size) {
    const bad = [...unused].map((i) => `"${choices[i]}"`).join(", ");
    const known = questions.map((q) => `${q.header || q.question}: ${q.options.map((o) => o.label).join(" | ")}`).join("; ");
    throw usage(`no option matches ${bad}. Options: ${known}`);
  }
  if (flags.text !== undefined) {
    const qi = answers.findIndex((a) => a.length === 0);
    answers[qi === -1 ? 0 : qi].push(flags.text);
  }
  const missing = answers.findIndex((a) => a.length === 0);
  if (missing !== -1) {
    throw usage(`question ${missing + 1} ("${questions[missing].question}") needs an answer: pass --choice LABEL or --text TEXT`);
  }
  return answers;
}

export function answerFor(card: Card, flags: AnswerFlags): AskAnswers {
  const reason = webOnlyReason(card);
  if (reason) throw usage(reason);
  return card.kind === "permission" ? permissionAnswer(flags) : askAnswer(card.questions, flags);
}
