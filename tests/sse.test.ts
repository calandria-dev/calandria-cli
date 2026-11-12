import { describe, expect, it } from "vitest";
import { SseParser, parseSseStream } from "../src/sse.js";

const all = (chunks: string[]) => {
  const p = new SseParser();
  return chunks.flatMap((c) => p.push(c));
};

describe("SseParser", () => {
  it("parses unnamed data frames", () => {
    expect(all(['data: {"a":1}\n\n'])).toEqual([{ data: '{"a":1}' }]);
  });

  it("joins multi-line data with newlines", () => {
    expect(all(["data: one\ndata: two\n\n"])).toEqual([{ data: "one\ntwo" }]);
  });

  it("ignores comments and ping keep-alives", () => {
    expect(all([": ping\n\ndata: x\n\n: ping\n\n"])).toEqual([{ data: "x" }]);
  });

  it("handles CRLF and bare CR line ends", () => {
    expect(all(["data: a\r\n\r\ndata: b\r\r"])).toEqual([{ data: "a" }, { data: "b" }]);
  });

  it("handles CRLF split across chunks", () => {
    expect(all(["data: a\r", "\n\r", "\ndata: b\n\n"])).toEqual([{ data: "a" }, { data: "b" }]);
  });

  it("reassembles frames split mid-line", () => {
    expect(all(["da", "ta: hel", "lo\n", "\n"])).toEqual([{ data: "hello" }]);
  });

  it("reads event and id fields and strips one leading space", () => {
    expect(all(["event: ping\nid: 7\ndata:  keep\n\n"])).toEqual([{ event: "ping", id: "7", data: " keep" }]);
  });

  it("strips a BOM and skips frames with no data", () => {
    expect(all(["\ufeffevent: x\n\ndata: ok\n\n"])).toEqual([{ data: "ok" }]);
  });

  it("drops an unterminated trailing frame", () => {
    const p = new SseParser();
    expect(p.push("data: partial")).toEqual([]);
    expect(p.end()).toEqual([]);
  });
});

describe("parseSseStream", () => {
  it("decodes a byte stream, including multi-byte characters split across chunks", async () => {
    const bytes = new TextEncoder().encode('data: {"t":"h\u00e9llo"}\n\n');
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.slice(0, 12));
        c.enqueue(bytes.slice(12));
        c.close();
      },
    });
    const out: string[] = [];
    for await (const m of parseSseStream(stream)) out.push(m.data);
    expect(out).toEqual(['{"t":"h\u00e9llo"}']);
  });
});
