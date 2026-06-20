// ---------------------------------------------------------------------------
// 指数退避重试策略
// ---------------------------------------------------------------------------
//
// 针对可重试错误（RateLimitError / ServerError / NetworkError）自动重试，
// 重试间隔按指数退避 + 抖动增长。429 错误优先服从 Retry-After 提示。

import {
  ProviderError,
  RateLimitError,
  isRetryableError,
} from "./errors.js";

/** 重试策略配置 */
export interface RetryOptions {
  /** 最大重试次数（不含首次），默认 3 */
  maxRetries?: number;
  /** 指数退避基准延迟（毫秒），默认 1000 */
  baseDelayMs?: number;
  /** 单次重试最大延迟上限（毫秒），默认 30000 */
  maxDelayMs?: number;
  /**
   * 重试前的回调，可用于日志输出。
   * 收到 (attempt, error, delayMs) 三个参数。
   */
  onRetry?: (attempt: number, error: Error, delayMs: number) => void;
}

/** 默认重试配置 */
export const DEFAULT_RETRY_OPTIONS: Required<
  Omit<RetryOptions, "onRetry">
> = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
};

/**
 * 计算第 attempt 次重试的退避延迟（毫秒）。
 *
 * 公式：base * 2^(attempt-1) + jitter
 * 其中 jitter 为 [0, base/2) 的随机抖动，避免重试洪峰。
 * 最终结果被 maxDelayMs 截断。
 *
 * @param attempt 重试序号，从 1 开始（第 1 次重试）
 */
export function computeBackoffDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
): number {
  // 指数部分：1, 2, 4, 8, 16 ...
  const exp = Math.pow(2, attempt - 1);
  const jitter = Math.random() * (baseDelayMs / 2);
  const delay = baseDelayMs * exp + jitter;
  return Math.min(delay, maxDelayMs);
}

/**
 * 对一个异步操作执行指数退避重试。
 *
 * - 操作成功（返回值）→ 立即返回结果
 * - 抛出非 ProviderError → 立即向上抛出（不可重试）
 * - 抛出 ProviderError 且 isRetryableError → 按配置重试
 * - 超过 maxRetries 仍未成功 → 抛出最后一次的错误
 *
 * 对于 RateLimitError，若携带 retryAfterMs，则优先使用该值
 * 作为延迟（但仍受 maxDelayMs 截断约束）。
 *
 * @param fn       待执行的重试操作
 * @param options  重试配置
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? DEFAULT_RETRY_OPTIONS.maxRetries;
  const baseDelayMs =
    options.baseDelayMs ?? DEFAULT_RETRY_OPTIONS.baseDelayMs;
  const maxDelayMs =
    options.maxDelayMs ?? DEFAULT_RETRY_OPTIONS.maxDelayMs;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err;

      // 非可重试错误：立即抛出
      if (!(err instanceof ProviderError) || !isRetryableError(err)) {
        throw err;
      }

      // 已达最大尝试次数
      if (attempt >= maxRetries) break;

      // 计算延迟
      let delayMs: number;
      if (err instanceof RateLimitError && err.retryAfterMs !== undefined) {
        // 429 优先服从 Retry-After，但仍受 maxDelayMs 截断
        delayMs = Math.min(err.retryAfterMs, maxDelayMs);
      } else {
        delayMs = computeBackoffDelay(attempt + 1, baseDelayMs, maxDelayMs);
      }

      options.onRetry?.(attempt + 1, err, delayMs);
      await sleep(delayMs);
    }
  }
  // 理论上不会到达；保险起见抛出最后一次错误
  throw lastError instanceof Error
    ? lastError
    : new Error("withRetry: 未知错误");
}

/** 可被外部替换的 sleep 函数，便于测试中加速 */
export let sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 替换模块内的 sleep 实现（仅供测试使用）。
 *
 * @param impl 自定义的 sleep 实现
 * @returns 一个函数，调用后恢复默认 sleep
 */
export function overrideSleep(
  impl: (ms: number) => Promise<void>,
): () => void {
  const original = sleep;
  sleep = impl;
  return () => {
    sleep = original;
  };
}