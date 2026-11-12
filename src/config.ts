import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface Profile {
  url: string;
  token?: string;
  cfAccessClientId?: string;
  cfAccessClientSecret?: string;
}

export interface Config {
  default?: string;
  profiles: Record<string, Profile>;
}

/** `$XDG_CONFIG_HOME/calandria-cli/config.json`; %APPDATA% on Windows; `~/.config` otherwise. */
export function configPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home: string = os.homedir()): string {
  if (platform === "win32") {
    const base = env.APPDATA || path.join(home, "AppData", "Roaming");
    return path.join(base, "calandria-cli", "config.json");
  }
  const base = env.XDG_CONFIG_HOME || path.join(home, ".config");
  return path.join(base, "calandria-cli", "config.json");
}

export function loadConfig(file: string = configPath()): Config {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { profiles: {} };
    throw e;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`config file ${file} is not valid JSON`);
  }
  const obj = (parsed && typeof parsed === "object" ? parsed : {}) as Partial<Config>;
  return {
    ...(typeof obj.default === "string" ? { default: obj.default } : {}),
    profiles: obj.profiles && typeof obj.profiles === "object" ? obj.profiles : {},
  };
}

/** Writes the config with mode 0600 (it can hold tokens), via a temp file and rename. */
export function saveConfig(config: Config, file: string = configPath()): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    // Windows: modes are advisory
  }
  fs.renameSync(tmp, file);
}

/** The profile named by `name`, else the config default. Throws when `name` is given but unknown. */
export function pickProfile(config: Config, name?: string): { name: string; profile: Profile } | undefined {
  if (name) {
    const profile = config.profiles[name];
    if (!profile) throw new Error(`no profile named "${name}" (known: ${Object.keys(config.profiles).join(", ") || "none"})`);
    return { name, profile };
  }
  if (config.default && config.profiles[config.default]) return { name: config.default, profile: config.profiles[config.default] };
  return undefined;
}
