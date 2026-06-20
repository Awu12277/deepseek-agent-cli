// ---------------------------------------------------------------------------
// Agent 会话 — 消息编排、流式 LLM 调用、成本追踪
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
import type { AgentEvent, SystemPromptOptions } from "./types.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { trimMessages, buildApiMessages } from "./message-builder.js";

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
 * 包含消息历史、流式输出、成本追踪。
 */
export class Session {
  readonly #messages: ChatMessage[] = [];
  readonly #provider: Provider;
  readonly #tools: Tool[];
  readonly #costTracker: CostTracker;
  readonly #options: Required<Pick<SessionOptions, "cwd" | "maxToolRounds" | "reservedForOutput" | "preserveRecentRounds">> & { projectContext?: string };
  readonly #abortController = new AbortController();

  constructor(
    provider: Provider,
    tools: Tool[] = [],
    costTracker?: CostTracker,
    options?: SessionOptions,
  ) {
    this.#provider = provider;
    this.#tools = tools;
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

  // -------------------------------------------------------------------------
  // 流式对话 — Agent 主循环
  // -------------------------------------------------------------------------

  /**
   * 执行一轮对话，以 AsyncGenerator 形式逐步 yield 事件。
   *
   * 调用方式：
   * ```ts
   * for await (const event of session.chat("你好")) {
   *   switch (event.type) {
   *     case "text_delta": // 追加文本
   *     case "tool_calls":  // 展示工具调用
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

    // 2. 构建系统提示词
    const systemPrompt = this.#buildSystemPrompt();

    // 3. 裁剪消息历史以适应上下文窗口
    const [trimmed, wasTrimmed] = trimMessages(
      [...this.#messages],
      {
        model: this.#provider.model() as ModelId,
        reservedForOutput: this.#options.reservedForOutput,
        systemPrompt,
        preserveRecentRounds: this.#options.preserveRecentRounds,
      },
    );

    if (wasTrimmed) {
      // 静默裁剪——后续可以在 verbose 模式下输出提示
    }

    // 4. 组装 API 请求
    const apiMessages = buildApiMessages(systemPrompt, trimmed);
    const toolDefs = this.#buildToolDefinitions();

    const startTime = Date.now();

    try {
      // 5. 调用 Provider 流式接口
      const stream = this.#provider.chat(apiMessages, {
        signal: this.#abortController.signal,
        // 将工具定义传给 provider（如支持 function calling）
        // 注意：当前 chat() 签名不含 tools 参数，
        // 工具定义在 system prompt 中描述，由模型通过文本方式请求
      });

      // 6. 逐步解析流式响应
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

        // 工具调用（累积方式，在 finishReason=tool_calls 时完整发出）
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

      // 7. 发送工具调用事件
      if (lastToolCalls && lastToolCalls.length > 0) {
        yield { type: "tool_calls", calls: lastToolCalls };
      }

      // 8. 记录使用量与成本
      if (lastUsage) {
        const modelId = this.#provider.model() as ModelId;
        const costInfo = this.#costTracker.record(lastUsage, modelId);

        yield { type: "usage", usage: lastUsage, model: modelId };
      }

      // 9. 追加助手消息到历史
      const assistantMsg: ChatMessage = {
        role: "assistant",
        content: accumulatedText,
      };
      if (lastToolCalls && lastToolCalls.length > 0) {
        assistantMsg.toolCalls = lastToolCalls;
      }
      this.#messages.push(assistantMsg);

      // 10. 如果有工具调用，追加占位的工具结果
      //     （第08章将改为实际执行工具后追加）
      if (lastToolCalls && lastToolCalls.length > 0) {
        for (const tc of lastToolCalls) {
          this.#messages.push({
            role: "tool",
            content: `⚠ 工具 "${tc.name}" 等待执行（工具系统将在第08章实现）`,
            toolCallId: tc.id,
            name: tc.name,
          });
        }
      }

      // 11. 本轮完成
      const elapsed = Date.now() - startTime;
      yield { type: "done", elapsed };
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
    }
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
    const toolDescs = this.#tools.map((t) => ({
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
    return this.#tools.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters as unknown as Record<string, unknown>,
      },
    }));
  }
}