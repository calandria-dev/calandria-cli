import { describe, expect, it } from "vitest";
import { answerFor, askAnswer, pendingCards, permissionAnswer, webOnlyReason } from "../src/cards.js";

const q = [{ question: "Which?", header: "Pick", options: [{ label: "Alpha" }, { label: "Beta" }] }];

describe("answers", () => {
  it("builds permission answers", () => {
    expect(permissionAnswer({ allow: true })).toEqual([["allow_once"]]);
    expect(permissionAnswer({ always: true })).toEqual([["allow_always"]]);
    expect(permissionAnswer({ deny: "too risky" })).toEqual([["deny", "too risky"]]);
    expect(permissionAnswer({ deny: true })).toEqual([["deny"]]);
  });
  it("requires exactly one permission flag", () => {
    expect(() => permissionAnswer({})).toThrow(/exactly one/);
    expect(() => permissionAnswer({ allow: true, deny: true })).toThrow(/exactly one/);
  });
  it("matches choices to option labels case-insensitively", () => expect(askAnswer(q, { choice: ["beta"] })).toEqual([["Beta"]]));
  it("accepts free text", () => expect(askAnswer(q, { text: "something else" })).toEqual([["something else"]]));
  it("rejects an unknown choice and lists the options", () => expect(() => askAnswer(q, { choice: ["Gamma"] })).toThrow(/Alpha \| Beta/));
  it("requires an answer per question", () => expect(() => askAnswer(q, {})).toThrow(/needs an answer/));
});

describe("web-only cards", () => {
  const env = { kind: "permission" as const, id: "e", request: { id: "e", tool: "x", kind: "environment" as const, title: "t", detail: "", expiresAt: 0 } };
  const secret = { kind: "permission" as const, id: "s", request: { id: "s", tool: "x", title: "t", detail: "", expiresAt: 0, privateInput: { value: true } } };
  it("flags environment and secret cards", () => {
    expect(webOnlyReason(env)).toMatch(/web UI/);
    expect(webOnlyReason(secret)).toMatch(/secret/);
  });
  it("refuses to answer them", () => expect(() => answerFor(env, { allow: true })).toThrow(/web UI/));
});

describe("pendingCards", () => {
  const msg = (content: unknown) => ({ id: "m", generation: 1, role: "tool" as const, created_at: 1, content: JSON.stringify(content) });
  it("returns only unanswered cards", () => {
    const cards = pendingCards([
      msg({ title: "a", ask: { id: "a1", questions: q, answers: [["Alpha"]] } }),
      msg({ title: "b", ask: { id: "a2", questions: q } }),
      msg({ title: "c", permission: { request: { id: "p1", title: "x" }, outcome: { decision: "deny" } } }),
      msg({ title: "d", permission: { request: { id: "p2", title: "y" } } }),
      { id: "x", generation: 1, role: "tool" as const, created_at: 1, content: "not json" },
    ]);
    expect(cards.map((c) => c.id)).toEqual(["a2", "p2"]);
  });
});
