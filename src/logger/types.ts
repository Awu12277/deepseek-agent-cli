// ---------------------------------------------------------------------------
// 对话日志事件类型定义
//
// 每个事件序列化为一行 JSON（JSONL 格式），记录用户与 AI 的完整交互过程，
// 用于事后排查问题。所有事件共享 ts（毫秒时间戳）字段。
// ---------------------------------------------------------------------------

/** 日志事件公共字段 */
interface LogEventBase {
  /** 事件发生时间（Date.now()，毫秒） */
  ts: number;
}

/** 会话开始 — 记录会话元信息 */
export interface SessionStartEvent extends LogEventBase {
  type: "session_start";
  /** 会话 ID */
  sessionId: string;
  /** 工作目录 */
  cwd: string;
  /** 使用的模型 */
  model: string;
  /** 会话模式 */
  mode: string;
}

/** 用户消息 — 用户输入的原始文本 */
export interface UserMessageEvent extends LogEventBase {
  type: "user_message";
  /** 用户输入内容 */
  content: string;
}

/** 助手文本 — 一轮对话中模型输出的完整文本（流式累积后记录） */
export interface AssistantTextEvent extends LogEventBase {
  type: "assistant_text";
  /** 模型回复文本 */
  content: string;
  /** 当前工具调用轮次（0 起始） */
  round: number;
}

/** 工具调用 — 模型请求执行的工具 */
export interface ToolCallEvent extends LogEventBase {
  type: "tool_call";
  /** 工具名称 */
  name: string;
  /** 工具调用 ID */
  callId: string;
  /** 工具调用参数（JSON 字符串，原样保留） */
  arguments: string;
  /** 当前工具调用轮次 */
  round: number;
}

/** 工具结果 — 工具执行完成后的结果 */
export interface ToolResultEvent extends LogEventBase {
  type: "tool_result";
  /** 工具名称 */
  name: string;
  /** 工具调用 ID */
  callId: string;
  /** 是否执行成功 */
  success: boolean;
  /** 结果内容（截断到 MAX_DATA_LEN 字符） */
  data: string;
  /** 错误分类标记 */
  error?: string;
  /** 工具执行耗时（毫秒） */
  elapsed?: number;
  /** 当前工具调用轮次 */
  round: number;
}

/** Token 用量与费用 — 每次 LLM 调用后记录 */
export interface UsageEvent extends LogEventBase {
  type: "usage";
  /** 模型标识 */
  model: string;
  /** 输入 token 数 */
  promptTokens: number;
  /** 输出 token 数 */
  completionTokens: number;
  /** 缓存命中 token 数 */
  cachedPromptTokens?: number;
  /** 本次调用费用（元） */
  cost: number;
  /** 当前工具调用轮次 */
  round: number;
}

/** 错误事件 — 对话过程中发生的异常 */
export interface ErrorEvent extends LogEventBase {
  type: "error";
  /** 错误消息 */
  message: string;
  /** 错误堆栈（如有） */
  stack?: string;
}

/** 一轮对话完成 — 记录整轮耗时 */
export interface TurnDoneEvent extends LogEventBase {
  type: "turn_done";
  /** 整轮对话耗时（毫秒） */
  elapsed: number;
  /** 本轮工具调用轮数 */
  toolRounds: number;
}

/** 会话结束 */
export interface SessionEndEvent extends LogEventBase {
  type: "session_end";
  /** 会话总耗时（毫秒） */
  elapsed: number;
}

/** 所有日志事件的联合类型 */
export type LogEvent =
  | SessionStartEvent
  | UserMessageEvent
  | AssistantTextEvent
  | ToolCallEvent
  | ToolResultEvent
  | UsageEvent
  | ErrorEvent
  | TurnDoneEvent
  | SessionEndEvent;
