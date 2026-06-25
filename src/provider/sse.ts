// ---------------------------------------------------------------------------
// SSE（Server-Sent Events）流式解析器
// ---------------------------------------------------------------------------
//
// 独立于 HTTP 传输的 SSE 协议解析模块。按照
// [SSE 规范](https://html.spec.whatwg.org/multipage/server-sent-events.html)
// 逐步解析事件流。
//
// 关键设计：
// - 按 \n 拆行，保留跨 chunk 的不完整行
// - 同一事件内的多个 data: 块用 \n 拼接
// - 空行触发事件 emit
// - 支持 idleTimeoutMs：单次 reader.read() 等待超时即抛 StreamIdleTimeoutError
// - 支持外部 AbortSignal 中止读取

import type { SSEEvent } from "./types.js";
import { StreamIdleTimeoutError } from "./errors.js";

/** parseSSE 的可选配置 */
export interface ParseSSEOptions {
  /**
   * 流式空闲超时（毫秒）。
   * 一次 reader.read() 等待超过此时间即抛出 StreamIdleTimeoutError。
   * 默认 60000。
   */
  idleTimeoutMs?: number;
  /**
   * 外部中止信号。中止后立即停止读取并释放 reader。
   */
  signal?: AbortSignal;
  /**
   * 遇到 data: [DONE] 时是否自动停止迭代。
   * SSE 规范并不要求解析器处理 [DONE]，但 OpenAI/DeepSeek
   * 等兼容 API 使用它标记流结束。默认 true。
   */
  stopOnDone?: boolean;
}

/**
 * 解析 SSE 响应流，逐步 yield 事件。
 *
 * 调用方需保证传入的 response 为成功的 2xx 响应且 body 可读。
 *
 * @param response 已返回 2xx 的 fetch 响应
 * @param options  解析选项（超时、中止信号）
 * @yields SSEEvent — 已按 SSE 协议拼装好的事件
 */
export async function* parseSSE(
  response: Response,
  options: ParseSSEOptions = {},
): AsyncIterable<SSEEvent> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("SSE 响应体为空，无法解析");
  }

  const decoder = new TextDecoder();
  let buffer = "";

  // 当前正在拼装的事件字段累积器
  let pendingData: string[] = [];
  let pendingEvent: string | undefined;
  let pendingId: string | undefined;
  let pendingRetry: number | undefined;

  const idleMs = options.idleTimeoutMs ?? 60_000;

  // 是否在遇到 [DONE] 时停止迭代
  const shouldStopOnDone = options.stopOnDone !== false;

  // [DONE] 标记：由 flush 设置，外部循环检查后停止迭代
  let streamDone = false;

  // 将当前累积的事件 flush 为一个 SSEEvent
  function* flush(): Generator<SSEEvent> {
    if (pendingData.length === 0) {
      pendingEvent = undefined;
      pendingId = undefined;
      pendingRetry = undefined;
      return;
    }
    const evt: SSEEvent = { data: pendingData.join("\n") };
    if (pendingEvent) evt.event = pendingEvent;
    if (pendingId) evt.id = pendingId;
    if (pendingRetry !== undefined) evt.retry = pendingRetry;
    pendingData = [];
    pendingEvent = undefined;
    pendingId = undefined;
    pendingRetry = undefined;

    // 遇到 [DONE] 标记时设置流结束标志
    if (shouldStopOnDone && evt.data === "[DONE]") {
      streamDone = true;
    }

    yield evt;
  }

  // 处理单行 SSE 内容
  function* processLine(rawLine: string): Generator<SSEEvent> {
    // 去掉行尾 \r（CRLF 场景）
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

    // 空行：事件分隔符，触发 emit
    if (line === "") {
      yield* flush();
      return;
    }
    // 注释行（以 ":" 开头），忽略
    if (line.startsWith(":")) return;

    // 字段行：field: value（冒号后允许一个可选空格）
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) {
      applyField(line, "");
      return;
    }
    const field = line.slice(0, colonIdx);
    let value = line.slice(colonIdx + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    applyField(field, value);
  }

  function applyField(field: string, value: string): void {
    switch (field) {
      case "event":
        pendingEvent = value;
        break;
      case "data":
        pendingData.push(value);
        break;
      case "id":
        pendingId = value;
        break;
      case "retry": {
        const n = Number(value);
        if (Number.isFinite(n)) pendingRetry = n;
        break;
      }
      default:
        // SSE 规范要求忽略未识别字段
        break;
    }
  }

  try {
    while (true) {
      if (options.signal?.aborted) return;

      const readResult = await readWithTimeout(reader, idleMs, options.signal);
      if (readResult === null) return; // 中止
      const { done, value } = readResult;
      if (done) {
        // flush 解码器残留
        buffer += decoder.decode();
        if (buffer.length > 0) {
          const line = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
          if (line !== "") yield* processLine(line);
          buffer = "";
        }
        yield* flush();
        if (streamDone) return;
        return;
      }

      buffer += decoder.decode(value, { stream: true });

      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        yield* processLine(line);
        if (streamDone) return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// 带超时的 reader.read()
// ---------------------------------------------------------------------------

interface TimedReadResult {
  done: boolean;
  value: Uint8Array;
}

/**
 * 在超时范围内等待 reader.read()，超时抛出 StreamIdleTimeoutError。
 *
 * - signal 中止时立即返回 null（让调用方优雅退出）
 * - 超时抛出 StreamIdleTimeoutError（reader 由外层 finally 释放）
 */
function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleMs: number,
  signal?: AbortSignal,
): Promise<TimedReadResult | null> {
  if (signal?.aborted) return Promise.resolve(null);

  return new Promise<TimedReadResult | null>((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new StreamIdleTimeoutError(`流式空闲超时（${idleMs}ms 无数据）`, idleMs));
    }, idleMs);

    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(null);
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    reader
      .read()
      .then((result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        resolve(result as unknown as TimedReadResult);
      })
      .catch((err: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
        reject(err);
      });
  });
}