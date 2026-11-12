import { CliError, HttpError } from "./errors.js";
import { loadConfig, pickProfile, type Config } from "./config.js";
import { discoverLocal, type DiscoverDeps } from "./discover.js";
import { parseSseStream, type SseMessage } from "./sse.js";
import { VERSION } from "./version.js";

export interface ConnectionFlags {
  url?: string;
  token?: string;
  profile?: string;
}

export interface Instance {
  url: string;
  /** How the URL was chosen, for error messages. */
  source: string;
  token?: string;
  cfAccessClientId?: string;
  cfAccessClientSecret?: string;
}

export interface ResolveDeps {
  env?: NodeJS.ProcessEnv;
  config?: Config;
  discover?: (deps?: DiscoverDeps) => Promise<{ url: string; how: string } | undefined>;
}

const trimUrl = (u: string): string => u.replace(/\/+$/, "");

/**
 * Picks the instance: --url > CALANDRIA_URL > named profile (--profile, CALANDRIA_PROFILE, config default) >
 * local discovery. Profile credentials attach only when the profile chose the URL or was named explicitly,
 * so a token never rides along to an unrelated --url.
 */
export async function resolveInstance(flags: ConnectionFlags, deps: ResolveDeps = {}): Promise<Instance> {
  const env = deps.env ?? process.env;
  const config = deps.config ?? loadConfig();
  const explicitProfile = flags.profile || env.CALANDRIA_PROFILE || undefined;

  let url: string | undefined;
  let source = "";
  let profile: ReturnType<typeof pickProfile>;
  const profileFor = (): ReturnType<typeof pickProfile> => {
    try {
      return pickProfile(config, explicitProfile);
    } catch (e) {
      throw new CliError((e as Error).message, 2);
    }
  };

  if (flags.url) {
    url = flags.url;
    source = "--url";
    if (explicitProfile) profile = profileFor();
  } else if (env.CALANDRIA_URL) {
    url = env.CALANDRIA_URL;
    source = "CALANDRIA_URL";
    if (explicitProfile) profile = profileFor();
  } else {
    profile = profileFor();
    if (profile) {
      url = profile.profile.url;
      source = `profile "${profile.name}"`;
    }
  }
  if (!url) {
    const found = await (deps.discover ?? discoverLocal)({ env });
    if (!found) {
      throw new CliError(
        "no Calandria instance found. Start the app or desktop client on this machine, or pass --url, set CALANDRIA_URL, or run `calandria login <url>`.",
        3,
      );
    }
    url = found.url;
    source = `local discovery (${found.how})`;
  }

  const p = profile?.profile;
  const token = flags.token || env.CALANDRIA_API_TOKEN || p?.token || undefined;
  const cfId = env.CF_ACCESS_CLIENT_ID || p?.cfAccessClientId || undefined;
  const cfSecret = env.CF_ACCESS_CLIENT_SECRET || p?.cfAccessClientSecret || undefined;
  return {
    url: trimUrl(url),
    source,
    ...(token ? { token } : {}),
    ...(cfId && cfSecret ? { cfAccessClientId: cfId, cfAccessClientSecret: cfSecret } : {}),
  };
}

export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || h === "127.0.0.1" || /^127\./.test(h) || h.endsWith(".localhost");
}

/** Pulls the human message out of an error body: JSON `error` (string or {message}), `message`, or the text. */
export function errorText(body: unknown): string {
  if (typeof body === "string") return body.trim();
  if (body && typeof body === "object") {
    const o = body as Record<string, unknown>;
    const e = o.error;
    if (typeof e === "string") return e;
    if (e && typeof e === "object" && typeof (e as { message?: unknown }).message === "string") return (e as { message: string }).message;
    if (typeof o.message === "string") return o.message;
    return JSON.stringify(body);
  }
  return "";
}

export interface RequestOptions {
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  signal?: AbortSignal;
  /** Statuses that return the parsed body instead of throwing. */
  allow?: number[];
}

export class Client {
  constructor(
    readonly instance: Instance,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get baseUrl(): string {
    return this.instance.url;
  }

  headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { "user-agent": `calandria-cli/${VERSION}`, accept: "application/json", ...extra };
    if (this.instance.token) h.authorization = `Bearer ${this.instance.token}`;
    if (this.instance.cfAccessClientId && this.instance.cfAccessClientSecret) {
      h["cf-access-client-id"] = this.instance.cfAccessClientId;
      h["cf-access-client-secret"] = this.instance.cfAccessClientSecret;
    }
    return h;
  }

  private url(path: string, query?: RequestOptions["query"]): string {
    const u = new URL(this.instance.url + path);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) u.searchParams.set(k, String(v));
    return u.toString();
  }

  private connectionError(e: unknown): CliError {
    const cause = (e as { cause?: { code?: string; message?: string } })?.cause;
    const detail = cause?.code || cause?.message || (e as Error)?.message || String(e);
    return new CliError(`cannot reach ${this.instance.url} (resolved from ${this.instance.source}): ${detail}`, 3);
  }

  private async failure(res: Response): Promise<HttpError> {
    const text = await res.text().catch(() => "");
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : "";
    } catch {
      // plain text body
    }
    const server = errorText(body);
    let host = "";
    try {
      host = new URL(this.instance.url).hostname;
    } catch {
      // keep empty
    }
    let message: string;
    if (res.status === 401) {
      message = `token rejected (CALANDRIA_API_TOKEN mismatch)${server ? `: ${server}` : ""}`;
    } else if (res.status === 403 && !isLoopbackHost(host) && !this.instance.token) {
      message =
        `403 from ${this.instance.url}: a non-loopback instance refuses requests without a token. ` +
        `Set CALANDRIA_API_TOKEN on the server and pass it with --token (or CALANDRIA_API_TOKEN, or \`calandria login\`).` +
        (server ? ` Server said: ${server}` : "");
    } else {
      message = server || `${res.status} ${res.statusText}`.trim();
      if (res.status >= 400) message = `${res.status}: ${message}`;
    }
    return new HttpError(message, res.status, body);
  }

  async request<T = unknown>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const headers = this.headers(opts.body !== undefined ? { "content-type": "application/json" } : {});
    let res: Response;
    try {
      res = await this.fetchImpl(this.url(path, opts.query), {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: opts.signal,
      });
    } catch (e) {
      if ((e as Error)?.name === "AbortError") throw e;
      throw this.connectionError(e);
    }
    if (!res.ok && !(opts.allow ?? []).includes(res.status)) throw await this.failure(res);
    const text = await res.text();
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }

  get<T = unknown>(path: string, opts?: RequestOptions): Promise<T> {
    return this.request<T>("GET", path, opts);
  }
  post<T = unknown>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
    return this.request<T>("POST", path, { ...opts, body: body ?? {} });
  }
  patch<T = unknown>(path: string, body: unknown, opts?: RequestOptions): Promise<T> {
    return this.request<T>("PATCH", path, { ...opts, body });
  }
  delete<T = unknown>(path: string, opts?: RequestOptions): Promise<T> {
    return this.request<T>("DELETE", path, opts);
  }

  /** Opens an SSE stream and yields its messages until the server or `signal` ends it. */
  async *stream(path: string, signal?: AbortSignal): AsyncGenerator<SseMessage> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.url(path), { headers: this.headers({ accept: "text/event-stream" }), signal });
    } catch (e) {
      if ((e as Error)?.name === "AbortError") return;
      throw this.connectionError(e);
    }
    if (!res.ok) throw await this.failure(res);
    if (!res.body) throw new CliError(`${path} returned no body`, 1);
    yield* parseSseStream(res.body);
  }
}
