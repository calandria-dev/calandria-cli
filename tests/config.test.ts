import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { configPath, loadConfig, pickProfile, saveConfig } from "../src/config.js";
import { tmpDir } from "./helpers.js";

describe("configPath", () => {
  it("uses XDG_CONFIG_HOME when set", () => {
    expect(configPath({ XDG_CONFIG_HOME: "/x" }, "linux", "/home/u")).toBe(path.join("/x", "calandria-cli", "config.json"));
  });
  it("falls back to ~/.config", () => {
    expect(configPath({}, "linux", "/home/u")).toBe(path.join("/home/u", ".config", "calandria-cli", "config.json"));
  });
  it("uses %APPDATA% on Windows", () => {
    expect(configPath({ APPDATA: "C:\\Roaming" }, "win32", "C:\\Users\\u")).toBe(path.join("C:\\Roaming", "calandria-cli", "config.json"));
  });
});

describe("load and save", () => {
  it("returns an empty config when the file is missing", () => {
    expect(loadConfig(path.join(tmpDir(), "none.json"))).toEqual({ profiles: {} });
  });

  it("round-trips and writes mode 0600", () => {
    const file = path.join(tmpDir(), "sub", "config.json");
    saveConfig({ default: "a", profiles: { a: { url: "http://x", token: "t" } } }, file);
    expect(loadConfig(file)).toEqual({ default: "a", profiles: { a: { url: "http://x", token: "t" } } });
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("rejects invalid JSON with the file name", () => {
    const file = path.join(tmpDir(), "bad.json");
    fs.writeFileSync(file, "{nope");
    expect(() => loadConfig(file)).toThrow(/not valid JSON/);
  });
});

describe("pickProfile", () => {
  const cfg = { default: "a", profiles: { a: { url: "http://a" }, b: { url: "http://b" } } };
  it("picks the default", () => expect(pickProfile(cfg)?.name).toBe("a"));
  it("picks a named profile", () => expect(pickProfile(cfg, "b")?.profile.url).toBe("http://b"));
  it("throws for an unknown name", () => expect(() => pickProfile(cfg, "zzz")).toThrow(/no profile named/));
  it("returns undefined with no default", () => expect(pickProfile({ profiles: {} })).toBeUndefined());
});
