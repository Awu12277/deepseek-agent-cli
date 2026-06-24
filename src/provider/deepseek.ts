// ---------------------------------------------------------------------------
// DeepSeek Provider 集成层 — 适配 DeepSeek API 到 Provider 框架
//
// 职责：
// 1. 将内部 ChatMessage[] 转换为 DeepSeek 协议格式（intoDeepSeekMessages）
// 2. 将 DeepSeek 流式响应映射为 ChatChunk 事件（DeepSeekEventMapper）
// 3. 实现 Provider 接口，提供 DeepSeekProvider 类
// ---------------------------------------------------------------------------

import type {
  ChatMessage,
  ChatOptions,
  ChatChunk,
  Provider,
  ProviderToolCall,
  UsageInfo,
  ModelId,
  ClientOptions,
} from "./types.js";
import { getModelMeta, estimateTokens } from "./models.js";
import { HttpClient } from "./client.js";
import { mapHttpError } from "./errors.js";
import {
  type DeepSeekMessage,
  type DeepSeekRequest,
  type DeepSeekStreamChunk,
  type DeepSeekToolCallChunk,
  type DeepSeekThinking,
  type DeepSeekReasoningEffort,
  type DeepSeekResponseFormat,
  type DeepSeekToolChoice,
  streamCompletion as protocolStream,
  getBalance as protocolBalance,
} from "./deepseek-protocol.js";

// ============================================================================
// 转换函数 — 内部类型 → DeepSeek 协议类型
// ============================================================================

/** 将内部消息格式映射为 DeepSeek API 请求格式 */
function intoDeepSeekMessages(messages: ChatMessage[]): DeepSeekMessage[] {
  return messages.map((msg) => {
    const mapped: DeepSeekMessage = {
      role: msg.role,
      content: msg.content || null,
    };

    if (msg.name) mapped.name = msg.name;
    if (msg.toolCallId) mapped.tool_call_id = msg.toolCallId;

    if (msg.toolCalls && msg.toolCalls.length > 0) {
      mapped.tool_calls = msg.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: {
          name: tc.name,
          arguments: tc.arguments,
        },
      }));
    }

    return mapped;
  });
}

// ============================================================================
// DeepSeekEventMapper — 流式事件映射
// ============================================================================

/** 被累积的工具调用（跨多个 SSE 块拼接） */
interface AccumulatedToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** 工具调用累积器：按 index 累积分块到达的 tool call */
class DeepSeekEventMapper {
  readonly #toolCallsByIndex = new Map<number, AccumulatedToolCall>();

  /**
   * 重置内部状态（每次新请求前调用）。
   */
  reset(): void {
    this.#toolCallsByIndex.clear();
  }

  /**
   * 将 DeepSeek 原始流式块映射为 ChatChunk 数组。
   * 一个 SSE 数据块可能生成 0~N 个 ChatChunk 事件。
   */
  mapEvent(chunk: DeepSeekStreamChunk): ChatChunk[] {
    const choice = chunk.choices?.[0];
    if (!choice) return [];

    const events: ChatChunk[] = [];
    const delta = choice.delta;
    const content = delta?.content ?? "";
    const finishReason = this.#mapFinishReason(choice.finish_reason);

    // 1. 累积工具调用片段
    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        this.#accumulateToolCall(tc);
      }
    }

    // 2. 构建 usage
    let usage: UsageInfo | undefined;
    if (chunk.usage) {
      usage = {
        promptTokens: chunk.usage.prompt_tokens,
        completionTokens: chunk.usage.completion_tokens,
        cachedPromptTokens: chunk.usage.prompt_cache_hit_tokens,
      };
    }

    // 3. finish_reason = "tool_calls" 时，yield 完整工具调用列表
    const shouldYieldToolCalls =
      finishReason === "tool_calls" && this.#toolCallsByIndex.size > 0;

    // 跳过空块（无内容、无工具调用、无 usage、非结束）
    if (
      !content &&
      finishReason === null &&
      !shouldYieldToolCalls &&
      !usage
    ) {
      return [];
    }

    events.push({
      content,
      finishReason,
      ...(shouldYieldToolCalls
        ? { toolCalls: [...this.#toolCallsByIndex.values()] }
        : {}),
      ...(usage ? { usage } : {}),
    });

    // 清理已 yield 的工具调用
    if (shouldYieldToolCalls) {
      this.#toolCallsByIndex.clear();
    }

    return events;
  }

  /** 将 DeepSeek 的 finish_reason 映射为内部类型 */
  #mapFinishReason(
    reason: string | null,
  ): "stop" | "tool_calls" | "length" | null {
    switch (reason) {
      case "stop":
        return "stop";
      case "tool_calls":
        return "tool_calls";
      case "length":
        return "length";
      default:
        return null;
    }
  }

  /** 累积一个工具调用分块 */
  #accumulateToolCall(tc: DeepSeekToolCallChunk): void {
    const idx = tc.index ?? 0;
    const existing = this.#toolCallsByIndex.get(idx);

    if (!existing) {
      this.#toolCallsByIndex.set(idx, {
        id: tc.id ?? "",
        name: tc.function?.name ?? "",
        arguments: tc.function?.arguments ?? "",
      });
    } else {
      if (tc.id) existing.id = tc.id;
      if (tc.function?.name) existing.name = tc.function.name;
      if (tc.function?.arguments) {
        existing.arguments += tc.function.arguments;
      }
    }
  }
}

// ============================================================================
// DeepSeekProvider
// ============================================================================

/** DeepSeek Provider 创建配置 */
export interface DeepSeekProviderConfig extends ClientOptions {
  apiKey: string;
  baseUrl: string;
  model: ModelId;
  /** 流式空闲超时（毫秒），默认 60000 */
  idleTimeoutMs?: number;
}

/**
 * DeepSeek LLM Provider 实现。
 *
 * 集成层：使用协议层的纯函数（streamCompletion / getBalance），
 * 通过 intoDeepSeekMessages 和 DeepSeekEventMapper 做类型转换。
 */
export class DeepSeekProvider implements Provider {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #model: ModelId;
  readonly #client: HttpClient;
  readonly #idleTimeoutMs: number;
  readonly #mapper = new DeepSeekEventMapper();

  readonly name = "deepseek";

  constructor(config: DeepSeekProviderConfig) {
    this.#apiKey = config.apiKey;
    this.#baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.#model = config.model;
    this.#idleTimeoutMs = config.idleTimeoutMs ?? 60_000;
    this.#client = new HttpClient({
      connectTimeoutMs: config.connectTimeoutMs,
      maxRetries: config.maxRetries,
      retryBaseDelayMs: config.retryBaseDelayMs,
      retryMaxDelayMs: config.retryMaxDelayMs,
    });
  }

  model(): string {
    return this.#model;
  }

  countTokens(text: string): number {
    return estimateTokens(text);
  }

  /**
   * 查询账户余额。
   */
  async getBalance(): Promise<import("./types.js").BalanceResult> {
    return protocolBalance(this.#client, this.#baseUrl, this.#apiKey);
  }

  /**
   * 发起聊天补全请求（流式）。
   */
  async *chat(
    messages: ChatMessage[],
    opts?: ChatOptions,
  ): AsyncIterable<ChatChunk> {
    // 1. 构建请求体
    const apiMessages = intoDeepSeekMessages(messages);

    const request: DeepSeekRequest = {
      model: this.#model,
      messages: apiMessages,
      stream: true,
      max_tokens: opts?.maxTokens,
      temperature: opts?.temperature,
      // 从 ChatOptions 映射 thinking / reasoning_effort
      thinking: opts?.thinkingAllowed !== undefined
        ? { type: opts.thinkingAllowed ? "enabled" : "disabled" }
        : undefined,
      reasoning_effort: opts?.thinkingEffort as DeepSeekReasoningEffort | undefined,
      // 从 ChatOptions 映射 response_format
      response_format: opts?.responseFormat
        ? { type: opts.responseFormat }
        : undefined,
      // 从 ChatOptions 映射 tool_choice
      tool_choice: opts?.toolChoice as DeepSeekToolChoice | undefined,
    };

    if (opts?.tools && opts.tools.length > 0) {
      request.tools = opts.tools;
    }

    // 2. 清空事件映射器状态
    this.#mapper.reset();

    // 3. 使用协议层函数发请求，并通过 mapper 映射事件
    const stream = protocolStream(
      this.#client,
      this.#baseUrl,
      this.#apiKey,
      request,
      { signal: opts?.signal, idleTimeoutMs: this.#idleTimeoutMs },
    );

    for await (const rawChunk of stream) {
      const events = this.#mapper.mapEvent(rawChunk);
      for (const event of events) {
        yield event;
      }
    }
  }
}
