// Marks the compiled entry point executable and checks it starts with a shebang.
import fs from "node:fs";
const file = new URL("../dist/cli.js", import.meta.url);
const text = fs.readFileSync(file, "utf8");
if (!text.startsWith("#!")) throw new Error("dist/cli.js lost its shebang");
fs.chmodSync(file, 0o755);
