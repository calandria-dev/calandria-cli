// A small Server-Sent Events parser. Handles CRLF, CR and LF line ends, comments, multi-line
// data fields, a leading BOM, and frames split across chunk boundaries.

export interface SseMessage {
  event?: string;
  data: string;
  id?: string;
}

export class SseParser {
  private buffer = "";
  private data: string[] = [];
  private event: string | undefined;
  private id: string | undefined;
  private first = true;
  private pendingCr = false;

  /** Feeds a decoded chunk and returns every message it completed. */
  push(chunk: string): SseMessage[] {
    if (this.first && chunk.length) {
      this.first = false;
      if (chunk.charCodeAt(0) === 0xfeff) chunk = chunk.slice(1);
    }
    // A CR at the end of the previous chunk may be half of a CRLF split across chunks.
    if (this.pendingCr) {
      this.pendingCr = false;
      if (chunk.startsWith("\n")) chunk = chunk.slice(1);
    }
    this.buffer += chunk;
    const out: SseMessage[] = [];
    let start = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      const ch = this.buffer[i];
      if (ch !== "\n" && ch !== "\r") continue;
      const line = this.buffer.slice(start, i);
      if (ch === "\r") {
        if (this.buffer[i + 1] === "\n") i++;
        else if (i + 1 === this.buffer.length) this.pendingCr = true;
      }
      start = i + 1;
      const done = this.line(line);
      if (done) out.push(done);
    }
    this.buffer = this.buffer.slice(start);
    return out;
  }

  /** Flushes a final unterminated frame at end of stream. Per the spec an incomplete frame is dropped. */
  end(): SseMessage[] {
    this.buffer = "";
    this.data = [];
    this.event = undefined;
    return [];
  }

  private line(line: string): SseMessage | null {
    if (line === "") {
      if (this.data.length === 0) {
        this.event = undefined;
        return null;
      }
      const msg: SseMessage = { data: this.data.join("\n") };
      if (this.event !== undefined) msg.event = this.event;
      if (this.id !== undefined) msg.id = this.id;
      this.data = [];
      this.event = undefined;
      return msg;
    }
    if (line.startsWith(":")) return null; // comment, such as the 25s ": ping"
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") this.data.push(value);
    else if (field === "event") this.event = value;
    else if (field === "id") this.id = value;
    return null;
  }
}

/** Parses a byte stream into SSE messages. */
export async function* parseSseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<SseMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const m of parser.push(decoder.decode(value, { stream: true }))) yield m;
    }
    const tail = decoder.decode();
    if (tail) for (const m of parser.push(tail)) yield m;
    parser.end();
  } finally {
    try {
      await reader.cancel();
    } catch {
      // already closed
    }
  }
}
