import { bold, cyan, dim, green, red, stripAnsi, yellow } from "./color.js";
import { webOnlyReason, type Card } from "./cards.js";
import { shortId } from "./resolve.js";
import type { Message, Task, TaskLite, ToolData } from "./types.js";

export function pad(s: string, width: number): string {
  const len = stripAnsi(s).length;
  return len >= width ? s : s + " ".repeat(width - len);
}

export function truncate(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, Math.max(0, max - 1))}…`;
}

export interface Column<T> {
  header: string;
  value: (row: T) => string;
  max?: number;
}

/** Left-aligned plain-text table with a bold header. Empty input renders nothing. */
export function table<T>(rows: T[], columns: Column<T>[]): string {
  if (rows.length === 0) return "";
  const cells = rows.map((r) => columns.map((c) => (c.max ? truncate(c.value(r), c.max) : c.value(r))));
  const widths = columns.map((c, i) => Math.max(c.header.length, ...cells.map((row) => stripAnsi(row[i]).length)));
  const line = (parts: string[]) => parts.map((p, i) => (i === parts.length - 1 ? p : pad(p, widths[i]))).join("  ").trimEnd();
  return [line(columns.map((c) => bold(c.header))), ...cells.map(line)].join("\n");
}

export function statusLabel(status: string): string {
  switch (status) {
    case "in_progress":
      return cyan(status);
    case "done":
      return green(status);
    case "on_hold":
      return yellow(status);
    case "cancelled":
      return dim(status);
    default:
      return status;
  }
}

/** One-character marker: `*` running, `?` awaiting you, `.` idle. */
export function marker(t: { running: number | boolean; awaiting_input: number | boolean }): string {
  if (t.awaiting_input) return yellow("?");
  if (t.running) return green("*");
  return dim(".");
}

export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function taskLiteRows(rows: TaskLite[]): string {
  return table(rows, [
    { header: "ID", value: (t) => shortId(t.id) },
    { header: "PROJECT", value: (t) => t.project_name, max: 20 },
    { header: "STATUS", value: (t) => statusLabel(t.status) },
    { header: "", value: (t) => marker(t) },
    { header: "TITLE", value: (t) => t.title, max: 70 },
  ]);
}

/** Plain-text view of a persisted transcript row. */
export function renderMessage(m: Message): string {
  switch (m.role) {
    case "user":
      return `${bold(cyan("> you"))}\n${indent(m.content)}`;
    case "assistant":
      return `${bold("assistant")}\n${indent(m.content)}`;
    case "system":
      return dim(`• ${m.content}`);
    case "session_break":
      return dim("--- session break ---");
    case "tool": {
      let d: ToolData | undefined;
      try {
        d = JSON.parse(m.content) as ToolData;
      } catch {
        return dim(`▸ ${truncate(m.content, 100)}`);
      }
      if (d.ask) {
        const state = d.ask.answers ? green("answered") : d.ask.dismissed ? dim("dismissed") : yellow("waiting");
        return `${bold("? question")} (${state})\n${indent(d.ask.questions.map((q) => q.question).join("\n"))}`;
      }
      if (d.permission) {
        const o = d.permission.outcome;
        const state = o ? (o.decision === "deny" ? red(o.decision) : green(o.decision)) : yellow("waiting");
        return `${bold("! permission")} (${state}) ${d.permission.request.title}`;
      }
      return `${dim("▸")} ${d.title}${d.isError ? red(" (failed)") : ""}`;
    }
    default:
      return m.content;
  }
}

const indent = (s: string): string => s.split("\n").map((l) => `  ${l}`).join("\n");

/** Prints a card with its choices and the exact command that answers it. */
export function renderCard(card: Card, taskRef: string): string {
  const lines: string[] = [];
  const ref = shortId(taskRef);
  if (card.kind === "permission") {
    const r = card.request;
    lines.push(`${bold(yellow("! permission requested"))}: ${r.title}`);
    if (r.description) lines.push(indent(r.description));
    if (r.detail) lines.push(indent(r.detail));
    const web = webOnlyReason(card);
    if (web) {
      lines.push(yellow(web));
    } else {
      lines.push(dim(`  allow once:    calandria answer ${ref} --allow`));
      lines.push(dim(`  allow always:  calandria answer ${ref} --always${r.scope?.label ? `   (${r.scope.label})` : ""}`));
      lines.push(dim(`  deny:          calandria answer ${ref} --deny "reason"`));
    }
  } else {
    lines.push(bold(yellow("? question")));
    for (const q of card.questions) {
      lines.push(`  ${q.header ? `[${q.header}] ` : ""}${q.question}${q.multiSelect ? " (choose any)" : ""}`);
      q.options.forEach((o, i) => lines.push(`    ${i + 1}. ${o.label}${o.description ? dim(` - ${o.description}`) : ""}`));
    }
    const sample = card.questions[0]?.options[0]?.label ?? "LABEL";
    lines.push(dim(`  answer: calandria answer ${ref} --choice ${JSON.stringify(sample)}   (or --text "...")`));
  }
  return lines.join("\n");
}

export function taskHeader(t: Task & { cost_usd?: number }, projectName?: string): string {
  const flags: string[] = [];
  if (t.suggested) flags.push("suggested");
  if (t.running) flags.push("running");
  if (t.awaiting_input) flags.push("awaiting input");
  const rows: [string, string][] = [
    ["id", t.id],
    ["title", t.title],
    ["project", projectName ? `${projectName} (${shortId(t.project_id)})` : t.project_id],
    ["status", `${statusLabel(t.status)}${flags.length ? `  [${flags.join(", ")}]` : ""}`],
    ["priority", t.priority],
    ["agent", `${t.agent}${t.model ? ` / ${t.model}` : ""}`],
  ];
  if (t.work_branch) rows.push(["branch", `${t.work_branch}${t.merged_at ? " (merged)" : ""}`]);
  if (t.pr_url) rows.push(["pr", `${t.pr_url}${t.pr_state ? ` (${t.pr_state}${t.pr_checks ? `, checks ${t.pr_checks}` : ""})` : ""}`]);
  if (t.withdrawn_reason) rows.push(["withdrawn", t.withdrawn_reason]);
  if (typeof t.cost_usd === "number" && t.cost_usd > 0) rows.push(["cost", `$${t.cost_usd.toFixed(2)}`]);
  return rows.map(([k, v]) => `${dim(pad(k, 9))}${v}`).join("\n");
}
