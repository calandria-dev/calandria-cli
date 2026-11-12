// Minimal ANSI helper. Disabled for --json, --no-color, NO_COLOR and non-TTY output.
let enabled = false;

export function setColorEnabled(on: boolean): void {
  enabled = on;
}

export function colorWanted(opts: { color?: boolean; json?: boolean }, env: NodeJS.ProcessEnv, isTty: boolean): boolean {
  if (opts.json) return false;
  if (opts.color === false) return false;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.FORCE_COLOR && env.FORCE_COLOR !== "0") return true;
  return isTty;
}

const wrap = (open: number, close: number) => (s: string): string => (enabled ? `\x1b[${open}m${s}\x1b[${close}m` : s);

export const bold = wrap(1, 22);
export const dim = wrap(2, 22);
export const red = wrap(31, 39);
export const green = wrap(32, 39);
export const yellow = wrap(33, 39);
export const blue = wrap(34, 39);
export const magenta = wrap(35, 39);
export const cyan = wrap(36, 39);

/** Removes ANSI escapes, for width math and tests. */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}
