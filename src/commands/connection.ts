import type { Command } from "commander";
import { Client, isLoopbackHost, type Instance } from "../client.js";
import { configPath, loadConfig, saveConfig, type Profile } from "../config.js";
import { applyColor, globalOpts, makeOut, type IO } from "../context.js";
import { usage } from "../errors.js";
import { bold, dim } from "../color.js";
import { table } from "../render.js";
import type { VersionInfo } from "../types.js";

export function normalizeUrl(raw: string): string {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `${isLoopbackHost(raw.split(/[/:]/)[0]) ? "http" : "https"}://${raw}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    throw usage(`"${raw}" is not a valid URL`);
  }
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`;
}

const mask = (s?: string): string => (s ? `${s.slice(0, 3)}...` : "");

export function registerConnection(program: Command, io: IO): void {
  program
    .command("login <url>")
    .description("verify an instance and save it as a profile")
    .option("--name <name>", "profile name (default: the URL's host)")
    .option("--cf-client-id <id>", "Cloudflare Access service token client id")
    .option("--cf-client-secret <secret>", "Cloudflare Access service token client secret")
    .action(async (urlArg: string, o: { name?: string; cfClientId?: string; cfClientSecret?: string }, cmd: Command) => {
      const g = globalOpts(cmd);
      applyColor(g, io);
      const url = normalizeUrl(urlArg);
      if (Boolean(o.cfClientId) !== Boolean(o.cfClientSecret)) throw usage("--cf-client-id and --cf-client-secret go together");
      const token = g.token || io.env.CALANDRIA_API_TOKEN || undefined;
      const instance: Instance = {
        url,
        source: `login ${urlArg}`,
        ...(token ? { token } : {}),
        ...(o.cfClientId ? { cfAccessClientId: o.cfClientId, cfAccessClientSecret: o.cfClientSecret } : {}),
      };
      const version = await new Client(instance, io.fetchImpl).get<VersionInfo>("/api/version");
      if (!version || typeof version !== "object" || typeof version.version !== "string") {
        throw usage(`${url} answered, but not like a Calandria instance (no version in /api/version)`);
      }
      const file = io.configFile ?? configPath();
      const config = loadConfig(file);
      const name = o.name || new URL(url).host.replace(/:/g, "-");
      const profile: Profile = {
        url,
        ...(token ? { token } : {}),
        ...(o.cfClientId ? { cfAccessClientId: o.cfClientId, cfAccessClientSecret: o.cfClientSecret } : {}),
      };
      config.profiles[name] = profile;
      const first = !config.default || !config.profiles[config.default];
      if (first) config.default = name;
      saveConfig(config, file);
      const out = makeOut(io, Boolean(g.json));
      if (out.emit({ profile: name, url, version: version.version, default: config.default === name })) return;
      out.println(`Logged in to ${url} (Calandria ${version.version}) as profile "${name}"${first ? " (default)" : ""}.`);
      if (!token && !isLoopbackHost(new URL(url).hostname)) {
        out.println(dim("No token saved. A remote instance needs CALANDRIA_API_TOKEN set on the server and passed with --token."));
      }
    });

  program
    .command("profiles")
    .description("list saved profiles")
    .action(async (_o: unknown, cmd: Command) => {
      const g = globalOpts(cmd);
      applyColor(g, io);
      const config = loadConfig(io.configFile);
      const out = makeOut(io, Boolean(g.json));
      const rows = Object.entries(config.profiles).map(([name, p]) => ({
        name,
        url: p.url,
        default: config.default === name,
        token: Boolean(p.token),
        cfAccess: Boolean(p.cfAccessClientId),
      }));
      if (out.emit(rows)) return;
      if (rows.length === 0) return out.println("No profiles. Run `calandria login <url>`.");
      out.println(
        table(rows, [
          { header: "NAME", value: (r) => (r.default ? `${bold(r.name)} *` : r.name) },
          { header: "URL", value: (r) => r.url },
          { header: "AUTH", value: (r) => [r.token ? `token ${mask(config.profiles[r.name].token)}` : "", r.cfAccess ? "cf-access" : ""].filter(Boolean).join(", ") || "none" },
        ]),
      );
    });

  program
    .command("logout [name]")
    .description("remove a saved profile (default: the default profile)")
    .action(async (name: string | undefined, _o: unknown, cmd: Command) => {
      const g = globalOpts(cmd);
      applyColor(g, io);
      const file = io.configFile ?? configPath();
      const config = loadConfig(file);
      const target = name ?? config.default;
      if (!target || !config.profiles[target]) throw usage(target ? `no profile named "${target}"` : "no default profile to remove");
      delete config.profiles[target];
      if (config.default === target) {
        const next = Object.keys(config.profiles)[0];
        if (next) config.default = next;
        else delete config.default;
      }
      saveConfig(config, file);
      const out = makeOut(io, Boolean(g.json));
      if (out.emit({ removed: target, default: config.default ?? null })) return;
      out.println(`Removed profile "${target}".${config.default ? ` Default is now "${config.default}".` : ""}`);
    });
}
