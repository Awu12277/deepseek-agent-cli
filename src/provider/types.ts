// ---------------------------------------------------------------------------
// Provider 层核心类型定义
// ---------------------------------------------------------------------------

/** 聊天消息 */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** 工具调用 ID（role=tool 时必填，对应 assistant 消息中的 toolCalls[].id） */
  toolCallId?: string;
  /** 工具名称（role=tool 时的函数名） */
  name?: string;
  /** 工具调用列表（role=assistant 时，模型请求执行工具） */
  toolCalls?: ProviderToolCall[];
}

/** 聊天请求选项 */
export interface ChatOptions {
  /** 中止信号，用于取消请求 */
  signal?: AbortSignal;
  /** 本次请求最大生成 token 数（覆盖配置中的默认值） */
  maxTokens?: number;
  /** 生成温度（0.0 ~ 2.0，覆盖配置中的默认值） */
  temperature?: number;
}

/** 工具调用信息（模型返回的 function call） */
export interface ProviderToolCall {
  /** 工具调用唯一标识 */
  id: string;
  /** 被调用的工具名称 */
  name: string;
  /** 工具调用参数（JSON 字符串） */
  arguments: string;
}

/** 聊天响应流中的一个增量块 */
export interface ChatChunk {
  /** 文本内容增量（可能为空字符串） */
  content: string;
  /** 完成原因：stop=正常结束，tool_calls=需要调用工具，length=达到最大长度 */
  finishReason: "stop" | "tool_calls" | "length" | null;
  /** 工具调用列表（finishReason 为 tool_calls 时包含完整调用信息） */
  toolCalls?: ProviderToolCall[];
  /** Token 使用统计（通常在最后一个块中返回） */
  usage?: UsageInfo;
}

/** Token 使用统计 */
export interface UsageInfo {
  /** 输入 token 数 */
  promptTokens: number;
  /** 输出 token 数 */
  completionTokens: number;
  /** DeepSeek Prefix Cache 命中的 token 数（缓存命中的 token 按半价计费） */
  cachedPromptTokens?: number;
}

/** 费用计算结果（单位：元） */
export interface CostInfo {
  /** 输入费用（缓存未命中部分） */
  inputCost: number;
  /** 缓存命中费用（享受更低单价） */
  cacheHitCost: number;
  /** 输出费用 */
  outputCost: number;
  /** 总费用 = inputCost + cacheHitCost + outputCost */
  totalCost: number;
}

/** 单个币种的余额信息 */
export interface BalanceInfo {
  /** 币种（如 "CNY"） */
  currency: string;
  /** 总余额 */
  totalBalance: number;
  /** 赠送余额 */
  grantedBalance: number;
  /** 充值余额 */
  toppedUpBalance: number;
}

/** 余额查询结果 */
export interface BalanceResult {
  /** API Key 是否可用 */
  isAvailable: boolean;
  /** 各币种的余额明细 */
  balances: BalanceInfo[];
}

/** Provider 接口 — 每个模型后端都需要实现此接口 */
export interface Provider {
  /** Provider 标识符（如 "deepseek"） */
  readonly name: string;
  /** 发起聊天补全请求，返回流式响应 */
  chat(messages: ChatMessage[], opts?: ChatOptions): AsyncIterable<ChatChunk>;
  /** 统计文本的近似 token 数 */
  countTokens(text: string): number;
  /** 返回当前使用的模型标识 */
  model(): string;
}

/** 支持的模型标识符 */
export type ModelId = "deepseek-v4-flash" | "deepseek-v4-pro";

/** 模型元数据（定价、上下文窗口等） */
export interface ModelMeta {
  /** 模型 ID */
  id: ModelId;
  /** 显示名称 */
  displayName: string;
  /** 上下文窗口大小（token） */
  contextWindow: number;
  /** 输入价格（元 / 百万 token） */
  inputPricePerMillion: number;
  /** 输出价格（元 / 百万 token） */
  outputPricePerMillion: number;
  /** 缓存命中价格（元 / 百万 token） */
  cacheHitPricePerMillion: number;
}