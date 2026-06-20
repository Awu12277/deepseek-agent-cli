// ---------------------------------------------------------------------------
// Agent 主循环事件类型定义
// ---------------------------------------------------------------------------

import type { ProviderToolCall, UsageInfo } from "../provider/index.js";

/** Agent 事件 — Session.chat() 流式输出的每一步 */
export type AgentEvent =
  | { type: "text_delta"; content: string }
  | { type: "tool_calls"; calls: ProviderToolCall[] }
  | { type: "usage"; usage: UsageInfo; model: string }
  | { type: "done"; elapsed: number }
  | { type: "error"; error: Error };

/** Agent 循环中的消息角色，包含 system 用于系统提示词 */
export type MessageRole = "system" | "user" | "assistant" | "tool";

/** 会话状态：空闲 / 思考中 / 流式输出中 / 工具调用中 / 出错 */
export type SessionPhase =
  | "idle"
  | "thinking"
  | "streaming"
  | "tool_calling"
  | "error";

/** 构建系统提示词的选项 */
export interface SystemPromptOptions {
  /** 当前使用的模型标识 */
  model: string;
  /** 可用工具定义列表（用于注入到 system prompt） */
  tools?: Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }>;
  /** 项目上下文（AGENTS.md 内容），可选 */
  projectContext?: string;
  /** 当前工作目录 */
  cwd: string;
}

/** 一轮完整的助手回复结果 */
export interface TurnResult {
  /** 助手回复的文本内容（可能为空，如果只有工具调用） */
  content: string;
  /** 工具调用列表（可能为空） */
  toolCalls: ProviderToolCall[];
  /** Token 使用统计（最后一块 chunk 携带） */
  usage?: UsageInfo;
  /** 使用的模型标识 */
  model: string;
  /** 本次调用耗时（毫秒） */
  elapsed: number;
}