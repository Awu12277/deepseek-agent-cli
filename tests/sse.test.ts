import { describe, it, expect } from "vitest";
import { parseSSE } from "../src/provider/sse.js";
import type { SSEEvent } from "../src/provider/types.js";

// ---------------------------------------------------------------------------
// 工具：把 SSE 文本字符串构造成一个 Response 对象
// ---------------------------------------------------------------------------

function responseFromText(text: string, chunkSize = 1024): Response {
  // 将 text 按字符切分（模拟网络分块到达）
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(encoder.encode(text.slice(i, i + chunkSize)));
  }
  // 极端小的 chunkSize 可以测试跨块拆行
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
  return new Response(stream);
}

async function collect(
  response: Response,
  opts?: Parameters<typeof parseSSE>[1],
): Promise<SSEEvent[]> {
  const events: SSEEvent[] = [];
  for await (const evt of parseSSE(response, opts)) {
    events.push(evt);
  }
  return events;
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

describe("parseSSE", () => {
  it("应解析单条 data 事件", async () => {
    const res = responseFromText("data: hello\n\n");
    const events = await collect(res);
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toBe("hello");
  });

  it("应在遇到 [DONE] 时结束流", async () => {
    const res = responseFromText("data: chunk1\n\ndata: [DONE]\n\ndata: ignored\n\n");
    const events = await collect(res);
    expect(events.map((e) => e.data)).toEqual(["chunk1", "[DONE]"]);
    // parseSSE 默认在遇到 [DONE] 时停止迭代
  });

  it("应拼接同一事件的多行 data", async () => {
    // 多行 data 用 \n 连接
    const res = responseFromText("data: line1\ndata: line2\ndata: line3\n\n");
    const events = await collect(res);
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toBe("line1\nline2\nline3");
  });

  it("应跳过注释行", async () => {
    const res = responseFromText(": 这是一个注释\ndata: payload\n\n");
    const events = await collect(res);
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toBe("payload");
  });

  it("应解析 event / id / retry 字段", async () => {
    const res = responseFromText(
      "event: ping\ndata: 1\nid: 42\nretry: 5000\n\n",
    );
    const events = await collect(res);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: "ping",
      data: "1",
      id: "42",
      retry: 5000,
    });
  });

  it("应处理 CRLF（\\r\\n）行尾", async () => {
    const res = responseFromText("data: crlf-test\r\n\r\n");
    const events = await collect(res);
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toBe("crlf-test");
  });

  it("应忽略空行之间无 data 的事件", async () => {
    // 连续空行只 emit 一个事件（有 data 时），无 data 不 emit
    const res = responseFromText("\n\ndata: only\n\n\n\n");
    const events = await collect(res);
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toBe("only");
  });

  it("应处理不带尾换行符的最后一行", async () => {
    const res = responseFromText("data: tail-without-newline");
    const events = await collect(res);
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toBe("tail-without-newline");
  });

  it("应处理冒号后紧跟空格的字段值（空格不计入 value）", async () => {
    const res = responseFromText("data: hello space\n\n");
    const events = await collect(res);
    expect(events[0]!.data).toBe("hello space");
  });

  it("应支持字段值本身包含冒号", async () => {
    const res = responseFromText("data: {\"k:v\":1}\n\n");
    const events = await collect(res);
    expect(events[0]!.data).toBe('{"k:v":1}');
  });

  it("应正确处理跨 chunk 的不完整行（chunkSize=4）", async () => {
    const res = responseFromText("data: hello\n\ndata: world\n\n", 4);
    const events = await collect(res);
    expect(events.map((e) => e.data)).toEqual(["hello", "world"]);
  });

  it("应处理无 data 的事件类型字段（仅 event 不 emit）", async () => {
    // 仅 event 字段、无 data：SSE 规范要求不 dispatch
    const res = responseFromText("event: noop\n\ndata: payload\n\n");
    const events = await collect(res);
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toBe("payload");
    // 第一个空行虽然累积了 event=noop，但无 data 不 emit
    // 第二个事件重新设置 event（仍是 noop，因为之前没 reset？）
    // 规范：空行触发 dispatch，无 data 时清空累积但仍 reset 字段
    expect(events[0]!.event).toBeUndefined();
  });

  it("应在中止信号触发后优雅退出", async () => {
    const controller = new AbortController();
    // 构造一个永不结束的流
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // 不 enqueue、不 close —— 永久挂起
      },
    });
    const res = new Response(stream);

    // 立即中止
    controller.abort();

    const events = await collect(res, { signal: controller.signal });
    expect(events).toHaveLength(0);
  });

  it("应在流式空闲超时后抛出 StreamIdleTimeoutError", async () => {
    // 构造一个永久挂起的流
    const stream = new ReadableStream<Uint8Array>({
      start() {
        // 永不 enqueue、不 close
      },
    });
    const res = new Response(stream);

    await expect(
      collect(res, { idleTimeoutMs: 50 }),
    ).rejects.toThrow(/流式空闲超时/);
  });

  it("应在响应体为空时抛出错误", async () => {
    const res = new Response(null);
    await expect(collect(res)).rejects.toThrow(/SSE 响应体为空/);
  });

  it("应忽略未识别的字段", async () => {
    const res = responseFromText("foo: bar\ndata: payload\n\n");
    const events = await collect(res);
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toBe("payload");
  });

  it("stopOnDone=false 时不应在 [DONE] 处停止", async () => {
    const res = responseFromText("data: chunk1\n\ndata: [DONE]\n\ndata: ignored\n\n");
    const events = await collect(res, { stopOnDone: false });
    expect(events.map((e) => e.data)).toEqual(["chunk1", "[DONE]", "ignored"]);
  });

  it("应支持 data 后无非空 value", async () => {
    // data: 后紧跟换行 → value 为空字符串
    const res = responseFromText("data:\n\n");
    const events = await collect(res);
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toBe("");
  });
});