import { describe, expect, it } from "vitest";
import { matchId, matchIdOrName, resolveTags } from "../src/resolve.js";

const tasks = [{ id: "abcd1234" }, { id: "abcd9999" }, { id: "wxyz0001" }];

describe("matchId", () => {
  it("prefers an exact id", () => expect(matchId(tasks, "wxyz0001")).toEqual({ kind: "one", item: tasks[2] }));
  it("accepts a unique prefix of 4 or more characters", () => expect(matchId(tasks, "wxyz")).toEqual({ kind: "one", item: tasks[2] }));
  it("reports ambiguity with every candidate", () => expect(matchId(tasks, "abcd")).toEqual({ kind: "many", items: [tasks[0], tasks[1]] }));
  it("refuses prefixes shorter than 4 characters", () => expect(matchId(tasks, "abc")).toEqual({ kind: "none" }));
  it("reports no match", () => expect(matchId(tasks, "nope")).toEqual({ kind: "none" }));
  it("lets an exact id win over a longer id sharing its prefix", () => {
    const rows = [{ id: "abcd" }, { id: "abcd1" }];
    expect(matchId(rows, "abcd")).toEqual({ kind: "one", item: rows[0] });
  });
});

describe("matchIdOrName", () => {
  const projects = [
    { id: "p-1111", name: "Calandria" },
    { id: "p-2222", name: "Website" },
    { id: "p-3333", name: "website" },
  ];
  it("matches a name case-insensitively", () => expect(matchIdOrName(projects, "CALANDRIA")).toEqual({ kind: "one", item: projects[0] }));
  it("matches by id", () => expect(matchIdOrName(projects, "p-1111")).toEqual({ kind: "one", item: projects[0] }));
  it("flags two projects whose names differ only by case", () => expect(matchIdOrName(projects, "Website").kind).toBe("many"));
  it("returns none for an unknown name", () => expect(matchIdOrName(projects, "zzz")).toEqual({ kind: "none" }));
});

describe("resolveTags", () => {
  const tags = [{ id: "t1", name: "Feature" }];
  it("resolves names and ids", () => expect(resolveTags(tags, ["feature", "t1"])).toEqual(["t1", "t1"]));
  it("throws a usage error for an unknown tag", () => expect(() => resolveTags(tags, ["bug"])).toThrow(/no tag "bug"/));
});
