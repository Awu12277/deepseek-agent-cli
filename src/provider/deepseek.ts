// ---------------------------------------------------------------------------
// DeepSeek Provider — 适配 DeepSeek Chat Completions API
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
import { mapHttpError } from "./errors.js";
import { HttpClient, type RequestOptions } from "./client.js";
import { parseSSE } from "./sse.js";

// ---------------------------------------------------------------------------
// DeepSeek API 响应类型
// ---------------------------------------------------------------------------

/** SSE 流中的 delta 块 */
interface StreamDelta {
  content?: string;
  tool_calls?: Array<{
    index?: number;
    id?: string;
    function?: {
      name?: string;
      arguments?: string;
    };
  }>;
}

/** SSE 流中的单个数据块 */
interface StreamChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: StreamDelta;
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    /** DeepSeek Prefix Cache 命中的 token 数 */
    prompt_cache_hit_tokens?: number;
  };
}

/** 被累积的工具调用（跨多个 SSE 块拼接） */
interface AccumulatedToolCall {
  id: string;
  name: string;
  arguments: string;
}

// ---------------------------------------------------------------------------
// DeepSeekProvider
// ---------------------------------------------------------------------------

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
 * 适配 DeepSeek Chat Completions API（兼容 OpenAI 格式），支持：
 * - 流式响应（SSE）
 * - Prefix Cache（DeepSeek 特色，缓存命中 token 半价）
 * - 仅 deepseek-v4-flash / deepseek-v4-pro 两个模型
 * - 连接超时、流式空闲超时、指数退避重试（由 HttpClient 提供）
 */
export class DeepSeekProvider implements Provider {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #model: ModelId;
  readonly #client: HttpClient;
  readonly #idleTimeoutMs: number;

  readonly name = "deepseek";

  constructor(config: DeepSeekProviderConfig) {
    this.#apiKey = config.apiKey;
    this.#baseUrl = config.baseUrl.replace(/\/+$/, ""); // 去掉末尾斜杠
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
   *
   * 调用 DeepSeek /user/balance 接口，返回各币种的余额信息。
   * 可用于在启动前检查 API Key 有效性和余额状态。
   */
  async getBalance(): Promise<import("./types.js").BalanceResult> {
    const url = `${this.#baseUrl}/user/balance`;

    // HttpClient 已封装超时与 4xx/5xx 映射，抛出的错误可直接上拋
    const response = await this.#client.request(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${this.#apiKey}` },
    });

    const data = await response.json() as {
      is_available: boolean;
      balance_infos: Array<{
        currency: string;
        total_balance: string;
        granted_balance: string;
        topped_up_balance: string;
      }>;
    };

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

  /**
   * 发起聊天补全请求（流式）。
   *
   * 通过 HttpClient 发起请求（自动连接超时 + 429/5xx 指数退避重试），
   * 用 parseSSE 解析事件流，逐块映射为 ChatChunk 并 yield。
   */
  async *chat(
    messages: ChatMessage[],
    opts?: ChatOptions,
  ): AsyncIterable<ChatChunk> {
    const url = `${this.#baseUrl}/chat/completions`;
    const meta = getModelMeta(this.#model);

    // 将内部消息格式映射为 DeepSeek API 的请求格式
    const apiMessages = this.#mapMessages(messages);

    const body: Record<string, unknown> = {
      model: this.#model,
      messages: apiMessages,
      stream: true,
      max_tokens: opts?.maxTokens,
      temperature: opts?.temperature,
    };

    // 移除 undefined 字段（DeepSeek API 不接受 undefined 值）
    for (const key of Object.keys(body) as Array<keyof typeof body>) {
      if (body[key] === undefined) {
        delete body[key];
      }
    }

    const requestOptions: RequestOptions = {};
    if (opts?.signal) requestOptions.signal = opts.signal;

    const response = await this.#client.requestWithRetry(
      url,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${this.#apiKey}` },
        body: JSON.stringify(body),
      },
      requestOptions,
    );

    // 解析 SSE 流（含工具调用累积）
    yield* this.#parseStream(response, opts?.signal);
  }

  // -----------------------------------------------------------------------
  // 内部方法
  // -----------------------------------------------------------------------

  /**
   * 将内部 ChatMessage 数组映射为 DeepSeek API 的请求消息格式。
   */
  #mapMessages(messages: ChatMessage[]): Record<string, unknown>[] {
    return messages.map((msg) => {
      const mapped: Record<string, unknown> = {
        role: msg.role,
        content: msg.content || null,
      };

      if (msg.name) {
        mapped.name = msg.name;
      }

      if (msg.toolCallId) {
        mapped.tool_call_id = msg.toolCallId;
      }

      if (msg.toolCalls && msg.toolCalls.length > 0) {
        mapped.tool_calls = msg.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: {
            name: tc.name,
            arguments: tc.arguments,
          },
        }));
      }

      return mapped;
    });
  }

  /**
   * 解析 SSE 事件流并映射为 ChatChunk。
   *
   * 策略：
   * - 文本内容增量立即 yield（支持实时流式渲染）
   * - 工具调用在多个 SSE 块中逐步到达，内部累积拼接
   * - 当 finishReason 为 "tool_calls" 时，yield 完整的工具调用列表
   * - 最后一个块通常包含 usage 统计信息
   */
  async *#parseStream(
    response: Response,
    signal?: AbortSignal,
  ): AsyncIterable<ChatChunk> {
    // 工具调用累积器：key = index（流中用 index 标识不同的 tool call）
    const toolCallAccumulator = new Map<number, AccumulatedToolCall>();

    for await (const evt of parseSSE(response, {
      idleTimeoutMs: this.#idleTimeoutMs,
      signal,
    })) {
      // [DONE] 标记流结束
      if (evt.data === "[DONE]") return;

      let chunk: StreamChunk;
      try {
        chunk = JSON.parse(evt.data) as StreamChunk;
      } catch {
        // 无法解析的 JSON 行，跳过
        continue;
      }

      const choice = chunk.choices?.[0];
      if (!choice) continue;

      const delta = choice.delta;
      const content = delta?.content ?? "";
      const finishReason = choice.finish_reason;

      // 累积工具调用片段
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          const existing = toolCallAccumulator.get(idx);

          if (!existing) {
            // 新的工具调用开始
            toolCallAccumulator.set(idx, {
              id: tc.id ?? "",
              name: tc.function?.name ?? "",
              arguments: tc.function?.arguments ?? "",
            });
          } else {
            // 追加参数片段
            if (tc.id) existing.id = tc.id;
            if (tc.function?.name) existing.name = tc.function.name;
            if (tc.function?.arguments) {
              existing.arguments += tc.function.arguments;
            }
          }
        }
      }

      // 构建 usage 信息
      let usage: UsageInfo | undefined;
      if (chunk.usage) {
        usage = {
          promptTokens: chunk.usage.prompt_tokens,
          completionTokens: chunk.usage.completion_tokens,
          cachedPromptTokens: chunk.usage.prompt_cache_hit_tokens,
        };
      }

      // 确定完成原因
      const mappedFinishReason = this.#mapFinishReason(finishReason);

      // 当 finishReason 为 "tool_calls" 时，yield 完整的工具调用列表
      const shouldYieldToolCalls =
        mappedFinishReason === "tool_calls" && toolCallAccumulator.size > 0;

      // 不包含有效数据的块，跳过
      if (
        !content &&
        mappedFinishReason === null &&
        !shouldYieldToolCalls &&
        !usage
      ) {
        continue;
      }

      yield {
        content,
        finishReason: mappedFinishReason,
        ...(shouldYieldToolCalls
          ? {
              toolCalls: [...toolCallAccumulator.values()],
            }
          : {}),
        ...(usage ? { usage } : {}),
      };

      // 清理已 yield 的工具调用累积器
      if (shouldYieldToolCalls) {
        toolCallAccumulator.clear();
      }
    }
  }

  /**
   * 将 DeepSeek API 的 finish_reason 映射为内部类型。
   */
  #mapFinishReason(
    reason: string | null | undefined,
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
}