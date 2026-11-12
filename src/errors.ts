/** An error that carries the process exit code: 1 runtime, 2 usage, 3 connection. */
export class CliError extends Error {
  constructor(
    message: string,
    public readonly exitCode: 1 | 2 | 3 = 1,
  ) {
    super(message);
    this.name = "CliError";
  }
}

export const usage = (message: string): CliError => new CliError(message, 2);

/** A non-2xx response from the server. */
export class HttpError extends CliError {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message, 1);
    this.name = "HttpError";
  }
}
