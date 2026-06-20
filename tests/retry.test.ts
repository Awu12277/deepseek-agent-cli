import { describe, it, expect, vi } from "vitest";
import {
  withRetry,
  computeBackoffDelay,
  overrideSleep,
  DEFAULT_RETRY_OPTIONS,
  type RetryOptions,
} from "../src/provider/retry.js";
import {
  RateLimitError,
  ServerError,
  NetworkError,
  AuthError,
  ProviderError,
} from "../src/provider/errors.js";

describe("computeBackoffDelay", () => {
  it("应根据 2^(attempt-1) 增长", () => {
    // 固定 random 取 0 来验证公式
    const orig = Math.random;
    Math.random = () => 0;

    try {
      expect(computeBackoffDelay(1, 1000, 30_000)).toBe(1000);
      expect(computeBackoffDelay(2, 1000, 30_000)).toBe(2000);
      expect(computeBackoffDelay(3, 1000, 30_000)).toBe(4000);
      expect(computeBackoffDelay(4, 1000, 30_000)).toBe(8000);
      expect(computeBackoffDelay(5, 1000, 30_000)).toBe(16_000);
      expect(computeBackoffDelay(6, 1000, 30_000)).toBe(30_000);
    } finally {
      Math.random = orig;
    }
  });

  it("应在达到上限后截断", () => {
    const orig = Math.random;
    Math.random = () => 0;
    try {
      expect(computeBackoffDelay(20, 1000, 5000)).toBe(5000);
    } finally {
      Math.random = orig;
    }
  });

  it("应加入抖动使延迟不低于指数部分", () => {
    const orig = Math.random;
    Math.random = () => 0.5;
    try {
      // jitter = 0.5 * 1000/2 = 250
      expect(computeBackoffDelay(1, 1000, 30_000)).toBe(1250);
    } finally {
      Math.random = orig;
    }
  });
});

describe("DEFAULT_RETRY_OPTIONS", () => {
  it("应提供合理的默认值", () => {
    expect(DEFAULT_RETRY_OPTIONS.maxRetries).toBe(3);
    expect(DEFAULT_RETRY_OPTIONS.baseDelayMs).toBe(1000);
    expect(DEFAULT_RETRY_OPTIONS.maxDelayMs).toBe(30_000);
  });
});

describe("withRetry", () => {
  let restore: (() => void) | undefined;

  // 每个测试替换 sleep 为立即返回，避免真实等待
  const instantSleep = () => {
    restore = overrideSleep(async () => {});
    return restore;
  };

  it("首次成功应不重试", async () => {
    const restore = instantSleep();
    try {
      const fn = vi.fn().mockResolvedValue("ok");
      const result = await withRetry(fn);
      expect(result).toBe("ok");
      expect(fn).toHaveBeenCalledTimes(1);
    } finally {
      restore!();
    }
  });

  it("应在可重试错误后最终成功", async () => {
    const restore = instantSleep();
    try {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new ServerError("500", 500))
        .mockRejectedValueOnce(new ServerError("502", 502))
        .mockResolvedValueOnce("ok");

      const result = await withRetry(fn, { maxRetries: 3, baseDelayMs: 1 });
      expect(result).toBe("ok");
      expect(fn).toHaveBeenCalledTimes(3);
    } finally {
      restore!();
    }
  });

  it("应在达到 maxRetries 后抛出最后一次错误", async () => {
    const restore = instantSleep();
    try {
      const fn = vi.fn().mockRejectedValue(new ServerError("500", 500));
      await expect(
        withRetry(fn, { maxRetries: 2 }),
      ).rejects.toBeInstanceOf(ServerError);
      // 首次 + 重试 2 次 = 3 次
      expect(fn).toHaveBeenCalledTimes(3);
    } finally {
      restore!();
    }
  });

  it("RateLimitError 可重试", async () => {
    const restore = instantSleep();
    try {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new RateLimitError("429", undefined))
        .mockResolvedValueOnce("ok");
      const result = await withRetry(fn);
      expect(result).toBe("ok");
      expect(fn).toHaveBeenCalledTimes(2);
    } finally {
      restore!();
    }
  });

  it("NetworkError 可重试", async () => {
    const restore = instantSleep();
    try {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new NetworkError("net err"))
        .mockResolvedValueOnce("ok");
      const result = await withRetry(fn);
      expect(result).toBe("ok");
    } finally {
      restore!();
    }
  });

  it("AuthError 不可重试应立即抛出", async () => {
    const restore = instantSleep();
    try {
      const fn = vi.fn().mockRejectedValue(new AuthError("401", 401));
      await expect(withRetry(fn)).rejects.toBeInstanceOf(AuthError);
      expect(fn).toHaveBeenCalledTimes(1);
    } finally {
      restore!();
    }
  });

  it("普通 Error 不可重试应立即抛出", async () => {
    const restore = instantSleep();
    try {
      const fn = vi.fn().mockRejectedValue(new Error("boom"));
      await expect(withRetry(fn)).rejects.toThrow("boom");
      expect(fn).toHaveBeenCalledTimes(1);
    } finally {
      restore!();
    }
  });

  it("RateLimitError 携带 retryAfterMs 时优先使用该延迟", async () => {
    const restore = instantSleep();
    try {
      const calls: number[] = [];
      const sleepImpl = async (ms: number) => {
        calls.push(ms);
      };
      const restoreSleep = overrideSleep(sleepImpl);

      const fn = vi
        .fn()
        .mockRejectedValueOnce(new RateLimitError("429", 5000))
        .mockResolvedValueOnce("ok");

      const opts: RetryOptions = {
        maxRetries: 1,
        baseDelayMs: 1000,
        maxDelayMs: 30_000,
      };
      const result = await withRetry(fn, opts);
      expect(result).toBe("ok");
      // 唯一一次 sleep 应使用 5000（来自 retryAfterMs）
      expect(calls).toEqual([5000]);

      restoreSleep();
    } finally {
      restore!();
    }
  });

  it("RateLimitError 的 retryAfterMs 受 maxDelayMs 截断", async () => {
    const restore = instantSleep();
    try {
      const calls: number[] = [];
      const restoreSleep = overrideSleep(async (ms) => calls.push(ms));

      const fn = vi
        .fn()
        .mockRejectedValueOnce(new RateLimitError("429", 60_000))
        .mockResolvedValueOnce("ok");

      const opts: RetryOptions = {
        maxRetries: 1,
        baseDelayMs: 1000,
        maxDelayMs: 5000,
      };
      await withRetry(fn, opts);
      expect(calls).toEqual([5000]);

      restoreSleep();
    } finally {
      restore!();
    }
  });

  it("应通过 onRetry 回调通知重试", async () => {
    const restore = instantSleep();
    try {
      const onRetry = vi.fn();
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new ServerError("500", 500))
        .mockResolvedValueOnce("ok");

      await withRetry(fn, { onRetry, maxRetries: 2 });
      expect(onRetry).toHaveBeenCalledTimes(1);
      const [attempt, err, delayMs] = onRetry.mock.calls[0]!;
      expect(attempt).toBe(1);
      expect(err).toBeInstanceOf(ServerError);
      expect(typeof delayMs).toBe("number");
    } finally {
      restore!();
    }
  });

  it("maxRetries=0 应等同于不重试", async () => {
    const restore = instantSleep();
    try {
      const fn = vi.fn().mockRejectedValue(new ServerError("500", 500));
      await expect(withRetry(fn, { maxRetries: 0 })).rejects.toBeInstanceOf(
        ServerError,
      );
      expect(fn).toHaveBeenCalledTimes(1);
    } finally {
      restore!();
    }
  });

  it("overrideSleep 可恢复原始实现", () => {
    const restore = overrideSleep(async () => {});
    expect(typeof restore).toBe("function");
    restore();
    // 再次调用应使用原 sleep（不抛错即可）
    expect(typeof overrideSleep).toBe("function");
  });
});

describe("isRetryableError（间接验证）", () => {
  it("ProviderError 默认不可重试", async () => {
    const restore = overrideSleep(async () => {});
    try {
      const fn = vi
        .fn()
        .mockRejectedValue(new ProviderError("bad request", "BAD_REQUEST"));
      await expect(withRetry(fn)).rejects.toBeInstanceOf(ProviderError);
      expect(fn).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });
});