import fs from "node:fs";

function read(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** The package version. dist/ and src/ both sit one level below package.json. */
export const VERSION = read();
