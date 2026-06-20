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
} from "./types.js";

// 错误类型
export {
  ProviderError,
  AuthError,
  RateLimitError,
  ServerError,
  NetworkError,
  ModelNotSupportedError,
  mapHttpError,
} from "./errors.js";

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