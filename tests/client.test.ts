import { describe, expect, it } from "vitest";
import { Client, errorText, isLoopbackHost, resolveInstance } from "../src/client.js";

const cfg = { default: "home", profiles: { home: { url: "https://c.example", token: "ptok" }, lab: { url: "http://lab:3000", token: "labtok", cfAccessClientId: "id", cfAccessClientSecret: "sec" } } };
const none = async () => undefined;

describe("resolveInstance order", () => {
  it("--url beats CALANDRIA_URL beats profile beats discovery", async () => {
    const env = { CALANDRIA_URL: "http://env" };
    expect((await resolveInstance({ url: "http://flag/" }, { env, config: cfg, discover: none })).url).toBe("http://flag");
    expect((await resolveInstance({}, { env, config: cfg, discover: none })).url).toBe("http://env");
    expect((await resolveInstance({}, { env: {}, config: cfg, discover: none })).url).toBe("https://c.example");
    expect((await resolveInstance({}, { env: {}, config: { profiles: {} }, discover: async () => ({ url: "http://127.0.0.1:3000", how: "probe" }) })).source).toMatch(/local discovery/);
  });

  it("picks a profile by --profile or CALANDRIA_PROFILE", async () => {
    expect((await resolveInstance({ profile: "lab" }, { env: {}, config: cfg, discover: none })).url).toBe("http://lab:3000");
    expect((await resolveInstance({}, { env: { CALANDRIA_PROFILE: "lab" }, config: cfg, discover: none })).url).toBe("http://lab:3000");
  });

  it("does not send a profile's token to an unrelated --url", async () => {
    const i = await resolveInstance({ url: "http://other" }, { env: {}, config: cfg, discover: none });
    expect(i.token).toBeUndefined();
  });

  it("token precedence: flag, env, profile", async () => {
    expect((await resolveInstance({ token: "flag" }, { env: { CALANDRIA_API_TOKEN: "env" }, config: cfg, discover: none })).token).toBe("flag");
    expect((await resolveInstance({}, { env: { CALANDRIA_API_TOKEN: "env" }, config: cfg, discover: none })).token).toBe("env");
    expect((await resolveInstance({}, { env: {}, config: cfg, discover: none })).token).toBe("ptok");
  });

  it("reads Cloudflare Access credentials from env or profile", async () => {
    const fromProfile = await resolveInstance({ profile: "lab" }, { env: {}, config: cfg, discover: none });
    expect(fromProfile.cfAccessClientId).toBe("id");
    const fromEnv = await resolveInstance({}, { env: { CF_ACCESS_CLIENT_ID: "eid", CF_ACCESS_CLIENT_SECRET: "esec" }, config: cfg, discover: none });
    expect(fromEnv.cfAccessClientSecret).toBe("esec");
  });

  it("fails with exit code 3 when nothing is found", async () => {
    await expect(resolveInstance({}, { env: {}, config: { profiles: {} }, discover: none })).rejects.toMatchObject({ exitCode: 3 });
  });

  it("an unknown --profile is a usage error", async () => {
    await expect(resolveInstance({ profile: "zzz" }, { env: {}, config: cfg, discover: none })).rejects.toMatchObject({ exitCode: 2 });
  });
});

describe("headers and errors", () => {
  it("sends bearer, CF Access and user-agent headers and never an Origin", () => {
    const h = new Client({ url: "http://x", source: "t", token: "tok", cfAccessClientId: "i", cfAccessClientSecret: "s" }).headers();
    expect(h.authorization).toBe("Bearer tok");
    expect(h["cf-access-client-id"]).toBe("i");
    expect(h["cf-access-client-secret"]).toBe("s");
    expect(h["user-agent"]).toMatch(/^calandria-cli\//);
    expect(Object.keys(h).map((k) => k.toLowerCase())).not.toContain("origin");
  });

  it("maps a 403 from a remote host without a token to guidance", async () => {
    const fetchImpl = (async () => new Response("Forbidden", { status: 403 })) as typeof fetch;
    const c = new Client({ url: "https://calandria.example", source: "--url" }, fetchImpl);
    await expect(c.get("/api/projects")).rejects.toThrow(/CALANDRIA_API_TOKEN on the server/);
  });

  it("keeps the server's own 403 text on loopback", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ error: "origin refused" }), { status: 403 })) as typeof fetch;
    const c = new Client({ url: "http://127.0.0.1:3000", source: "--url" }, fetchImpl);
    await expect(c.get("/x")).rejects.toThrow(/origin refused/);
  });

  it("names the URL and how it was resolved on a network error, with exit code 3", async () => {
    const fetchImpl = (async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    }) as typeof fetch;
    const c = new Client({ url: "http://127.0.0.1:9", source: "profile \"home\"" }, fetchImpl);
    await expect(c.get("/x")).rejects.toMatchObject({ exitCode: 3, message: expect.stringMatching(/127\.0\.0\.1:9.*profile "home".*ECONNREFUSED/) });
  });

  it("extracts error text from several body shapes", () => {
    expect(errorText({ error: "a" })).toBe("a");
    expect(errorText({ error: { message: "b" } })).toBe("b");
    expect(errorText("plain\n")).toBe("plain");
  });

  it("classifies loopback hosts", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("127.0.0.5")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("192.168.1.5")).toBe(false);
  });
});
