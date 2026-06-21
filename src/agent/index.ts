// ---------------------------------------------------------------------------
// Agent 会话 — 消息编排、流式 LLM 调用、工具执行循环、成本追踪
// ---------------------------------------------------------------------------

import type {
  ChatMessage,
  Provider,
  ProviderToolCall,
  UsageInfo,
  ModelId,
  ToolDefinition,
} from "../provider/index.js";
import { CostTracker } from "../provider/index.js";
import type { Tool } from "../tool/index.js";
import type { ToolContext } from "../tool/index.js";
import type { AgentEvent, SystemPromptOptions } from "./types.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { trimMessages, buildApiMessages } from "./message-builder.js";
import { ToolRegistry } from "../tool/registry.js";

/** Session 构造选项 */
export interface SessionOptions {
  /** 当前工作目录（注入到 system prompt） */
  cwd?: string;
  /** 最大工具调用轮次（防止无限循环），默认 20 */
  maxToolRounds?: number;
  /** 为模型输出预留的 token 数，默认 4096 */
  reservedForOutput?: number;
  /** 强制保留最近 N 轮对话（不参与上下文裁剪），默认 10 */
  preserveRecentRounds?: number;
  /** 项目上下文（AGENTS.md 内容），可选 */
  projectContext?: string;
}

/**
 * Session 表示一个 Agent 会话 — 与 LLM 的一次完整对话，
 * 包含消息历史、流式输出、工具执行、成本追踪。
 */
export class Session {
  readonly #messages: ChatMessage[] = [];
  readonly #provider: Provider;
  readonly #toolRegistry: ToolRegistry;
  readonly #costTracker: CostTracker;
  readonly #options: Required<Pick<SessionOptions, "cwd" | "maxToolRounds" | "reservedForOutput" | "preserveRecentRounds">> & { projectContext?: string };
  readonly #abortController = new AbortController();

  constructor(
    provider: Provider,
    tools: Tool[] | ToolRegistry = [],
    costTracker?: CostTracker,
    options?: SessionOptions,
  ) {
    this.#provider = provider;
    // 兼容 Tool[] 和 ToolRegistry 两种入参
    if (tools instanceof ToolRegistry) {
      this.#toolRegistry = tools;
    } else {
      this.#toolRegistry = new ToolRegistry();
      this.#toolRegistry.registerAll(tools);
    }
    this.#costTracker = costTracker ?? new CostTracker();
    this.#options = {
      cwd: options?.cwd ?? process.cwd(),
      maxToolRounds: options?.maxToolRounds ?? 20,
      reservedForOutput: options?.reservedForOutput ?? 4096,
      preserveRecentRounds: options?.preserveRecentRounds ?? 10,
      projectContext: options?.projectContext,
    };
  }

  // -------------------------------------------------------------------------
  // 公共只读属性
  // -------------------------------------------------------------------------

  get messages(): readonly ChatMessage[] {
    return this.#messages;
  }

  get accumulatedCost(): number {
    return this.#costTracker.sessionTotalCost;
  }

  get costTracker(): CostTracker {
    return this.#costTracker;
  }

  get model(): string {
    return this.#provider.model();
  }

  /** 获取工具注册表（只读视图） */
  get toolRegistry(): ToolRegistry {
    return this.#toolRegistry;
  }

  // -------------------------------------------------------------------------
  // 流式对话 — Agent 主循环
  // -------------------------------------------------------------------------

  /**
   * 执行一轮用户对话，以 AsyncGenerator 形式逐步 yield 事件。
   *
   * 主循环流程：
   * 1. 追加用户消息
   * 2. 进入 Agent 循环（最多 maxToolRounds 轮）
   *    a. 构建消息 → 裁剪 → 调用 Provider 流式接口
   *    b. 解析响应：文本增量、工具调用、使用量
   *    c. 如果有工具调用 → 执行工具 → 追加结果 → 继续循环
   *    d. 如果没有工具调用 → 退出循环
   * 3. yield done 事件
   *
   * 调用方式：
   * ```ts
   * for await (const event of session.chat("你好")) {
   *   switch (event.type) {
   *     case "text_delta":  // 追加文本
   *     case "tool_calls":  // 展示工具调用
   *     case "tool_result": // 工具执行结果
   *     case "usage":       // 记录使用量
   *     case "done":        // 本轮完成
   *     case "error":       // 处理错误
   *   }
   * }
   * ```
   */
  async *chat(userInput: string): AsyncGenerator<AgentEvent> {
    // 1. 追加用户消息
    this.#messages.push({ role: "user", content: userInput });

    // 2. 进入 Agent 循环
    const startTime = Date.now();
    let toolRounds = 0;

    try {
      while (toolRounds < this.#options.maxToolRounds) {
        // a. 构建消息
        const systemPrompt = this.#buildSystemPrompt();
        const [trimmed] = trimMessages(
          [...this.#messages],
          {
            model: this.#provider.model() as ModelId,
            reservedForOutput: this.#options.reservedForOutput,
            systemPrompt,
            preserveRecentRounds: this.#options.preserveRecentRounds,
          },
        );
        const apiMessages = buildApiMessages(systemPrompt, trimmed);

        // b. 调用 Provider 流式接口
        const toolDefs = this.#buildToolDefinitions();
        const stream = this.#provider.chat(apiMessages, {
          signal: this.#abortController.signal,
          tools: toolDefs.length > 0 ? toolDefs : undefined,
        });

        // c. 逐步解析流式响应
        let accumulatedText = "";
        let lastUsage: UsageInfo | undefined;
        let lastToolCalls: ProviderToolCall[] | undefined;
        let lastFinishReason: string | null = null;

        for await (const chunk of stream) {
          // 文本增量
          if (chunk.content) {
            accumulatedText += chunk.content;
            yield { type: "text_delta", content: chunk.content };
          }

          // 工具调用（累积方式）
          if (chunk.toolCalls && chunk.toolCalls.length > 0) {
            lastToolCalls = chunk.toolCalls;
          }

          // 使用量统计
          if (chunk.usage) {
            lastUsage = chunk.usage;
          }

          // 完成原因
          if (chunk.finishReason) {
            lastFinishReason = chunk.finishReason;
          }
        }

        // d. 记录使用量与成本
        if (lastUsage) {
          const modelId = this.#provider.model() as ModelId;
          this.#costTracker.record(lastUsage, modelId);
          yield { type: "usage", usage: lastUsage, model: modelId };
        }

        // e. 追加助手消息到历史
        const assistantMsg: ChatMessage = {
          role: "assistant",
          content: accumulatedText,
        };
        if (lastToolCalls && lastToolCalls.length > 0) {
          assistantMsg.toolCalls = lastToolCalls;
        }
        this.#messages.push(assistantMsg);

        // f. 如果有工具调用，执行工具并继续循环
        if (lastToolCalls && lastToolCalls.length > 0) {
          yield { type: "tool_calls", calls: lastToolCalls };

          // 逐个执行工具调用
          const toolCtx: ToolContext = {
            cwd: this.#options.cwd,
            signal: this.#abortController.signal,
          };

          for (const tc of lastToolCalls) {
            // 解析工具参数
            let toolArgs: unknown;
            try {
              toolArgs = tc.arguments ? JSON.parse(tc.arguments) : {};
            } catch {
              toolArgs = {};
            }

            // 通过注册表执行工具
            const result = await this.#toolRegistry.execute(tc.name, toolArgs, toolCtx);

            // 发出工具结果事件
            yield { type: "tool_result", name: tc.name, result };

            // 追加工具结果消息
            this.#messages.push({
              role: "tool",
              content: result.data,
              toolCallId: tc.id,
              name: tc.name,
            });
          }

          // 继续循环，让模型基于工具结果生成回答
          toolRounds++;
          continue;
        }

        // 没有工具调用，退出循环
        break;
      }
    } catch (err: unknown) {
      // 如果是取消信号，正常退出
      if (err instanceof DOMException && err.name === "AbortError") {
        return;
      }
      if (err instanceof Error && err.name === "AbortError") {
        return;
      }

      yield {
        type: "error",
        error: err instanceof Error ? err : new Error(String(err)),
      };
      return;
    }

    // 本轮完成
    const elapsed = Date.now() - startTime;
    yield { type: "done", elapsed };
  }

  // -------------------------------------------------------------------------
  // 会话管理
  // -------------------------------------------------------------------------

  /** 取消正在进行的流式请求 */
  abort(): void {
    this.#abortController.abort();
  }

  /** 重置会话历史（保留 provider/tools 配置，重置成本追踪） */
  reset(): void {
    this.#messages.length = 0;
    this.#costTracker.resetSession();
  }

  // -------------------------------------------------------------------------
  // 内部方法
  // -------------------------------------------------------------------------

  /** 构建系统提示词 */
  #buildSystemPrompt(): string {
    const enabledTools = this.#toolRegistry.list();
    const toolDescs = enabledTools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters as unknown as Record<string, unknown>,
    }));

    const opts: SystemPromptOptions = {
      model: this.#provider.model(),
      tools: toolDescs.length > 0 ? toolDescs : undefined,
      projectContext: this.#options.projectContext ?? undefined,
      cwd: this.#options.cwd,
    };

    return buildSystemPrompt(opts);
  }

  /** 将注册的工具转为 ToolDefinition 格式（预留给 function calling） */
  #buildToolDefinitions(): ToolDefinition[] {
    return this.#toolRegistry.list().map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters as unknown as Record<string, unknown>,
      },
    }));
  }
}