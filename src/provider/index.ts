// ---------------------------------------------------------------------------
// Provider 模块公共 API
// ---------------------------------------------------------------------------

// 核心类型
export type {
  ChatMessage,
  ChatOptions,
  ChatChunk,
  ProviderToolCall,
  UsageInfo,
  CostInfo,
  BalanceInfo,
  BalanceResult,
  Provider,
  ModelId,
  ModelMeta,
  ToolDefinition,
  ChatCompletionRequest,
  ClientOptions,
  SSEEvent,
} from "./types.js";

// 错误类型
export {
  ProviderError,
  AuthError,
  RateLimitError,
  ServerError,
  NetworkError,
  ModelNotSupportedError,
  TimeoutError,
  StreamIdleTimeoutError,
  mapHttpError,
  isRetryableError,
} from "./errors.js";

// HTTP 客户端
export { HttpClient } from "./client.js";
export type { HttpClientConfig, RequestOptions } from "./client.js";

// SSE 解析器
export { parseSSE } from "./sse.js";
export type { ParseSSEOptions } from "./sse.js";

// 重试策略
export {
  withRetry,
  computeBackoffDelay,
  overrideSleep,
  DEFAULT_RETRY_OPTIONS,
} from "./retry.js";
export type { RetryOptions } from "./retry.js";

// 模型定义与校验
export {
  SUPPORTED_MODELS,
  SUPPORTED_MODEL_IDS,
  isSupportedModel,
  getModelMeta,
  estimateTokens,
  calculateCost,
  formatCost,
} from "./models.js";

// 工厂注册表
export {
  ProviderRegistry,
  defaultRegistry,
  createProvider,
} from "./registry.js";
export type { ProviderFactory } from "./registry.js";

// DeepSeek Provider
export { DeepSeekProvider } from "./deepseek.js";
export type { DeepSeekProviderConfig } from "./deepseek.js";