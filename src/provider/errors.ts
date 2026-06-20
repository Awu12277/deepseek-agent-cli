// ---------------------------------------------------------------------------
// Provider 错误类型与 HTTP 状态映射
// ---------------------------------------------------------------------------

/** Provider 错误基类 */
export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/** 认证失败（401 / 403） */
export class AuthError extends ProviderError {
  constructor(message: string, statusCode?: number) {
    super(message, "AUTH_ERROR", statusCode);
    this.name = "AuthError";
  }
}

/** 速率限制（429） */
export class RateLimitError extends ProviderError {
  /** 建议等待的毫秒数 */
  public readonly retryAfterMs?: number;

  constructor(message: string, retryAfterMs?: number) {
    super(message, "RATE_LIMIT", 429);
    this.name = "RateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

/** 服务端错误（5xx） */
export class ServerError extends ProviderError {
  constructor(message: string, statusCode?: number) {
    super(message, "SERVER_ERROR", statusCode);
    this.name = "ServerError";
  }
}

/** 网络连接错误 */
export class NetworkError extends ProviderError {
  /** 导致网络错误的底层错误 */
  readonly originalError?: Error;

  constructor(message: string, originalError?: Error) {
    super(message, "NETWORK_ERROR");
    this.name = "NetworkError";
    this.originalError = originalError;
  }
}

/** 连接超时错误 */
export class TimeoutError extends ProviderError {
  /** 触发超时的等待时间（毫秒） */
  public readonly timeoutMs: number;

  constructor(message: string, timeoutMs: number) {
    super(message, "TIMEOUT");
    this.name = "TimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/** 流式空闲超时错误——两个 SSE 数据块之间间隔过长 */
export class StreamIdleTimeoutError extends ProviderError {
  /** 触发空闲超时的最大间隔（毫秒） */
  public readonly idleMs: number;

  constructor(message: string, idleMs: number) {
    super(message, "STREAM_IDLE_TIMEOUT");
    this.name = "StreamIdleTimeoutError";
    this.idleMs = idleMs;
  }
}

/** 不支持的模型 */
export class ModelNotSupportedError extends ProviderError {
  constructor(model: string) {
    super(
      `不支持的模型: "${model}"。dskcode 仅支持: deepseek-v4-flash, deepseek-v4-pro`,
      "MODEL_NOT_SUPPORTED",
    );
    this.name = "ModelNotSupportedError";
  }
}

/**
 * 将 HTTP 状态码映射为结构化错误。
 *
 * 覆盖 DeepSeek API 常见的错误码：
 * - 400 → 请求参数错误
 * - 401/403 → 认证失败
 * - 429 → 速率限制
 * - 5xx → 服务端错误
 */
export function mapHttpError(status: number, body: string): ProviderError {
  switch (status) {
    case 401:
    case 403:
      return new AuthError(
        `认证失败：请检查 API Key 是否正确。(${status})`,
        status,
      );

    case 429: {
      // 尝试从响应体中解析重试等待时间
      let retryAfterMs: number | undefined;
      try {
        const parsed = JSON.parse(body) as { error?: { message?: string } };
        const msg = parsed.error?.message ?? "";
        const match = /(\d+)\s*second/i.exec(msg);
        if (match?.[1]) {
          retryAfterMs = Number(match[1]) * 1000;
        }
      } catch {
        // 解析失败 — 不提取重试时间
      }
      return new RateLimitError(
        `请求过于频繁，请稍后再试。${retryAfterMs ? `建议等待 ${Math.ceil(retryAfterMs / 1000)} 秒。` : ""}`,
        retryAfterMs,
      );
    }

    case 400: {
      let detail = "";
      try {
        const parsed = JSON.parse(body) as { error?: { message?: string } };
        detail = parsed.error?.message ?? "";
      } catch {
        // 解析失败 — 不提取详情
      }
      return new ProviderError(
        `请求参数错误${detail ? `: ${detail}` : ""}`,
        "BAD_REQUEST",
        status,
      );
    }

    default:
      if (status >= 500) {
        return new ServerError(
          `服务端错误 (${status})，请稍后再试。`,
          status,
        );
      }
      return new ProviderError(`请求失败 (${status})`, "UNKNOWN_ERROR", status);
  }
}

/**
 * 判断一个 ProviderError 是否可重试。
 *
 * 可重试的错误类型：
 * - RateLimitError（429）——服从 Retry-After，但也可退避
 * - ServerError（5xx）
 * - NetworkError（连接失败、DNS 错误等）
 */
export function isRetryableError(err: ProviderError): boolean {
  return (
    err instanceof RateLimitError ||
    err instanceof ServerError ||
    err instanceof NetworkError
  );
}