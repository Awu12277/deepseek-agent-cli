// ---------------------------------------------------------------------------
// HttpClient — 通用 HTTP 传输层
// ---------------------------------------------------------------------------
//
// 封装原生 fetch，提供：
// - 连接超时（通过 AbortSignal.timeout 或外部 signal 合并实现）
// - 流式空闲超时（由 SSE 解析器负责）
// - 指数退避重试（针对 429 / 5xx）
//
// 与具体 Provider 解耦：Provider 负责「请求构造 / 响应映射」，
// HttpClient 负责「传输稳定性」。

import type { ClientOptions } from "./types.js";
import {
  NetworkError,
  ProviderError,
  TimeoutError,
  mapHttpError,
} from "./errors.js";
import { withRetry, type RetryOptions } from "./retry.js";

/** HttpClient 配置 */
export interface HttpClientConfig extends ClientOptions {}

/** 请求选项（扩展标准 fetch init） */
export interface RequestOptions {
  /** 外部中止信号，与连接超时信号合并 */
  signal?: AbortSignal;
  /**
   * 本次请求的连接超时（毫秒），覆盖 HttpClient 默认值。
   * 设为 0 表示不超时。
   */
  connectTimeoutMs?: number;
  /**
   * 本次请求的重试配置；为 false 则禁用重试。
   */
  retry?: RetryOptions | false;
}

/** 默认连接超时（30s） */
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

/**
 * 通用 HTTP 客户端。
 *
 * 不持有任何状态，可被多个 Provider 共享。
 */
export class HttpClient {
  readonly #connectTimeoutMs: number;
  readonly #maxRetries: number;
  readonly #retryBaseDelayMs: number;
  readonly #retryMaxDelayMs: number;

  constructor(config: HttpClientConfig = {}) {
    this.#connectTimeoutMs =
      config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.#maxRetries = config.maxRetries ?? 3;
    this.#retryBaseDelayMs = config.retryBaseDelayMs ?? 1000;
    this.#retryMaxDelayMs = config.retryMaxDelayMs ?? 30_000;
  }

  /**
   * 发起单次 HTTP 请求（带连接超时，不重试）。
   *
   * - 自动附加 `Content-Type: application/json`（若 body 是字符串）
   * - 非 2xx 响应：抛出 mapHttpError 映射后的 ProviderError
   * - 网络错误：抛出 NetworkError
   * - 超时：抛出 TimeoutError
   *
   * @param url  请求 URL
   * @param init fetch 初始化（method/headers/body）
   * @param options 请求级选项（超时、中止信号）
   * @returns 成功（2xx）的 Response
   */
  async request(
    url: string,
    init: RequestInit = {},
    options: RequestOptions = {},
  ): Promise<Response> {
    const timeoutMs =
      options.connectTimeoutMs === undefined
        ? this.#connectTimeoutMs
        : options.connectTimeoutMs;

    // 合并 headers
    const headers = new Headers(init.headers);
    if (init.body && typeof init.body === "string" && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    const { signal, cleanup } = this.#mergeSignals(
      options.signal,
      timeoutMs,
    );

    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers,
        signal,
      });
    } catch (err: unknown) {
      // 外部中止优先视为用户主动取消
      if (options.signal?.aborted) {
        throw new ProviderError("请求已取消", "ABORTED");
      }
      // 超时（本客户端内部的超时信号先于外信号触发）
      if (signal?.aborted && !options.signal?.aborted) {
        throw new TimeoutError(
          `连接超时（${timeoutMs}ms）: ${url}`,
          timeoutMs,
        );
      }
      throw new NetworkError(
        `网络错误：无法连接到 ${url}`,
        err instanceof Error ? err : undefined,
      );
    } finally {
      cleanup();
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw mapHttpError(response.status, body);
    }

    return response;
  }

  /**
   * 发起带重试的 HTTP 请求。
   *
   * 等价于 request，但用 withRetry 包装：429 / 5xx / 网络错误会自动重试。
   * 流式响应一旦获得 2xx，重试即停止，剩余流式稳定性交给 SSE 解析器。
   */
  async requestWithRetry(
    url: string,
    init: RequestInit = {},
    options: RequestOptions = {},
  ): Promise<Response> {
    const retryOptions: RetryOptions | undefined =
      options.retry === false
        ? { maxRetries: 0 }
        : (options.retry ?? {
            maxRetries: this.#maxRetries,
            baseDelayMs: this.#retryBaseDelayMs,
            maxDelayMs: this.#retryMaxDelayMs,
          });

    return withRetry(() => this.request(url, init, options), retryOptions);
  }

  /**
   * 合并外部 signal 与连接超时 signal。
   *
   * 策略：
   * - 若 timeoutMs <= 0 且无外部 signal → 不使用 signal
   * - 若已有外部 signal 且无超时 → 直接使用外部 signal
   * - 否则用 AbortSignal.any([外部, 超时]) 合并（Node 20+ 原生支持）
   *
   * @returns { signal, cleanup } 调用方应在 finally 调用 cleanup 取消监听
   */
  #mergeSignals(
    // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
    external: AbortSignal | undefined,
    timeoutMs: number,
  // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
  ): { signal: AbortSignal | undefined; cleanup: () => void } {
    const useTimeout = timeoutMs > 0;

    if (!external && !useTimeout) {
      return { signal: undefined, cleanup: () => {} };
    }
    if (!useTimeout) {
      return { signal: external, cleanup: () => {} };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    // 监听外部 signal：触发时同步中止本控制器
    const onExternalAbort = () => controller.abort();
    if (external) {
      if (external.aborted) controller.abort();
      else external.addEventListener("abort", onExternalAbort, { once: true });
    }

    return {
      signal: controller.signal,
      cleanup: () => {
        clearTimeout(timer);
        if (external) {
          external.removeEventListener("abort", onExternalAbort);
        }
      },
    };
  }
}