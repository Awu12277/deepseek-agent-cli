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
  /**
   * 事件发生时间的可读字符串（本地时区），格式 `YYYY-MM-DD HH:mm:ss.SSS`。
   * 由 logger 在写入时自动填充，方便人眼直接查看日志文件。
   */
  time: string;
  /**
   * 调用日志时的源代码位置（文件相对路径 + 行号），由 logger 通过
   * V8 栈自动捕获，调用方无需手动传入。
   */
  loc: { file: string; line: number };
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

/** 思考链 — thinking 模式下一轮中模型输出的完整 CoT（与 assistant_text 互斥） */
export interface ReasoningEvent extends LogEventBase {
  type: "reasoning";
  /** 思考链文本 */
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

/** 反射事件 — 工具失败归因注入到下一轮 prompt 时记录 */
export interface ReflectionEvent extends LogEventBase {
  type: "reflection";
  /** 本轮触发的反射列表 */
  items: Array<{
    /** 反射分类 */
    category: string;
    /** 命中的工具名 */
    toolName: string;
    /** 提示文本 */
    hint: string;
  }>;
}

/** 所有日志事件的联合类型 */
export type LogEvent =
  | SessionStartEvent
  | UserMessageEvent
  | AssistantTextEvent
  | ReasoningEvent
  | ToolCallEvent
  | ToolResultEvent
  | UsageEvent
  | ErrorEvent
  | TurnDoneEvent
  | SessionEndEvent
  | ReflectionEvent;

/**
 * `logger.log()` 接受的入参：任何事件类型均可，time / loc 可选（由 logger 自动填充）。
 * 用映射类型 + 联合的 distributive 方式拼装，避免手写十个分支。
 */
export type LogEventInput = DistributiveOmit<LogEvent, "time" | "loc"> & {
  time?: string;
  loc?: LogEventBase["loc"];
};

type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;

/** 用于在测试或工具中构造事件时复用的"位置"类型 */
export type EventLocation = LogEventBase["loc"];
