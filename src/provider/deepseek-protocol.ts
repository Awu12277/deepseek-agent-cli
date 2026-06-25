// ---------------------------------------------------------------------------
// DeepSeek API 协议层 — 纯数据模型 + HTTP 请求函数
//
// 职责：定义 DeepSeek Chat Completions API 的完整类型，提供纯函数发起请求。
// 不依赖任何 Provider 框架类型，可被任何调用方复用。
// ---------------------------------------------------------------------------

import type { HttpClient, RequestOptions } from "./client.js";
import { parseSSE } from "./sse.js";

// ============================================================================
// 类型定义 — 镜像 DeepSeek API 协议
// ============================================================================

/** 消息角色 */
export type DeepSeekRole = "system" | "user" | "assistant" | "tool";

/** 请求消息 */
export interface DeepSeekMessage {
  role: DeepSeekRole;
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: DeepSeekToolCall[];
}

/** 工具调用（请求中） */
export interface DeepSeekToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

/** 工具定义 */
export interface DeepSeekToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** 聊天补全请求体 */
/** 深度思考模式 */
export interface DeepSeekThinking {
  type: "enabled" | "disabled";
}

/** 推理努力等级 */
export type DeepSeekReasoningEffort = "high" | "max";

/** 响应格式 */
export interface DeepSeekResponseFormat {
  type: "text" | "json_object";
}

/** 工具调用策略 */
export type DeepSeekToolChoice = "none" | "auto" | "required";

/** 聊天补全请求体 */
export interface DeepSeekRequest {
  model: string;
  messages: DeepSeekMessage[];
  stream: boolean;
  max_tokens?: number;
  temperature?: number;
  /** 启用深度思考模式，允许模型在回答前进行更长的推理 */
  thinking?: DeepSeekThinking;
  /** 推理努力等级（仅 thinking 启用时有效） */
  reasoning_effort?: DeepSeekReasoningEffort;
  /** 响应格式控制 */
  response_format?: DeepSeekResponseFormat;
  /** 工具调用策略 */
  tool_choice?: DeepSeekToolChoice;
  /** 可用工具定义 */
  tools?: DeepSeekToolDefinition[];
}

/** 非流式响应 */
export interface DeepSeekResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: DeepSeekChoice[];
  usage: DeepSeekUsage;
}

export interface DeepSeekChoice {
  index: number;
  message: DeepSeekMessage;
  finish_reason: string | null;
}

/** Token 用量 */
export interface DeepSeekUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  /** DeepSeek Prefix Cache 命中的 token 数 */
  prompt_cache_hit_tokens?: number;
}

/** SSE 流中的单个数据块 */
export interface DeepSeekStreamChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: DeepSeekStreamChoice[];
  usage?: DeepSeekUsage;
}

export interface DeepSeekStreamChoice {
  index: number;
  delta: DeepSeekStreamDelta;
  finish_reason: string | null;
}

export interface DeepSeekStreamDelta {
  content?: string;
  tool_calls?: DeepSeekToolCallChunk[];
}

/** 流式 tool call 分块（按 index 标识，需要累积拼接） */
export interface DeepSeekToolCallChunk {
  index: number;
  id?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

/** 余额响应 */
interface DeepSeekBalanceResponse {
  is_available: boolean;
  balance_infos: Array<{
    currency: string;
    total_balance: string;
    granted_balance: string;
    topped_up_balance: string;
  }>;
}

/** 余额查询结果 */
export interface BalanceResult {
  isAvailable: boolean;
  balances: Array<{
    currency: string;
    totalBalance: number;
    grantedBalance: number;
    toppedUpBalance: number;
  }>;
}

// ============================================================================
// 协议层函数
// ============================================================================

/**
 * 发起 DeepSeek Chat Completions 流式请求。
 *
 * 纯协议层函数：只处理 HTTP + SSE 解析，返回原始 StreamChunk。
 * 不涉及任何框架类型映射。
 *
 * @param client     HTTP 客户端
 * @param baseUrl    API 地址（如 https://api.deepseek.com）
 * @param apiKey     API Key
 * @param request    请求体
 * @param opts       请求选项（信号等）
 * @returns          原始流式数据块的异步迭代器
 */
export async function* streamCompletion(
  client: HttpClient,
  baseUrl: string,
  apiKey: string,
  request: DeepSeekRequest,
  opts?: { signal?: AbortSignal; idleTimeoutMs?: number },
): AsyncIterable<DeepSeekStreamChunk> {
  const url = `${baseUrl}/chat/completions`;
  const idleTimeoutMs = opts?.idleTimeoutMs ?? 60_000;

  const response = await client.requestWithRetry(
    url,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(request),
    },
    { signal: opts?.signal } satisfies RequestOptions,
  );

  for await (const evt of parseSSE(response, { idleTimeoutMs, signal: opts?.signal })) {
    if (evt.data === "[DONE]") return;

    let chunk: DeepSeekStreamChunk;
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      chunk = JSON.parse(evt.data) as unknown as DeepSeekStreamChunk;
    } catch {
      continue;
    }

    yield chunk;
  }
}

/**
 * 查询 DeepSeek 账户余额。
 */
export async function getBalance(
  client: HttpClient,
  baseUrl: string,
  apiKey: string,
): Promise<BalanceResult> {
  const response = await client.request(`${baseUrl}/user/balance`, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const data = (await response.json()) as unknown as DeepSeekBalanceResponse;

  return {
    isAvailable: data.is_available,
    balances: data.balance_infos.map((b) => ({
      currency: b.currency,
      totalBalance: Number(b.total_balance),
      grantedBalance: Number(b.granted_balance),
      toppedUpBalance: Number(b.topped_up_balance),
    })),
  };
}
