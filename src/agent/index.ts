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
import type { ToolContext, AnyAgentTool } from "../tool/index.js";
import { isReadOnly } from "../tool/types.js";
import type { AgentEvent, SystemPromptOptions } from "./types.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { trimMessages, buildApiMessages } from "./message-builder.js";
import { ToolRegistry } from "../tool/registry.js";
import type { Gate, ToolCallRecord, ToolResult } from "../tool/types.js";
import { AlwaysAllowGate } from "../tool/types.js";

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
  /** Gate 权限门 — 控制工具执行前的审批，默认 AlwaysAllowGate */
  gate?: Gate;
  /** 写目录的白名单（用于 confine 路径安全），默认 [cwd] */
  writeRoots?: string[];
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
  readonly #options: Required<
    Pick<SessionOptions, "cwd" | "maxToolRounds" | "reservedForOutput" | "preserveRecentRounds">
  > & { projectContext?: string; gate: Gate; writeRoots: string[] };
  readonly #abortController = new AbortController();

  // 风暴检测：记录每轮的工具调用错误
  #stormRecords: ToolCallRecord[] = [];

  constructor(
    provider: Provider,
    tools: AnyAgentTool[] | ToolRegistry = [],
    costTracker?: CostTracker,
    options?: SessionOptions,
  ) {
    this.#provider = provider;
    // 兼容 AnyAgentTool[] 和 ToolRegistry 两种入参
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
      gate: options?.gate ?? new AlwaysAllowGate(),
      writeRoots: options?.writeRoots ?? [options?.cwd ?? process.cwd()],
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
   */
  async *chat(userInput: string, opts?: import("../provider/types.js").ChatOptions): AsyncGenerator<AgentEvent> {
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
        // 合并内部选项与用户传入的设置
        const stream = this.#provider.chat(apiMessages, {
          signal: this.#abortController.signal,
          tools: toolDefs.length > 0 ? toolDefs : undefined,
          thinkingAllowed: opts?.thinkingAllowed,
          thinkingEffort: opts?.thinkingEffort,
          responseFormat: opts?.responseFormat,
          toolChoice: opts?.toolChoice,
        });

        // c. 逐步解析流式响应
        let accumulatedText = "";
        let lastUsage: UsageInfo | undefined;
        let lastToolCalls: ProviderToolCall[] | undefined;
        let lastFinishReason: string | null = null;

        for await (const chunk of stream) {
          if (chunk.content) {
            accumulatedText += chunk.content;
            yield { type: "text_delta", content: chunk.content };
          }

          if (chunk.toolCalls && chunk.toolCalls.length > 0) {
            lastToolCalls = chunk.toolCalls;
          }

          if (chunk.usage) {
            lastUsage = chunk.usage;
          }

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

          // 风暴检测：检查上一个回合是否同一工具同一错误重复
          const stormBroken = this.#checkStormBreak(lastToolCalls);
          if (stormBroken) {
            const stormMsg = "\n⚠️ 同一工具重复出错，已强制切换策略\n";
            yield { type: "text_delta", content: stormMsg };
            // 清除 assistant 消息中的 toolCalls，风暴中断不再执行这些调用
            assistantMsg.toolCalls = undefined;
            // 将风暴信息追加到助手消息文本中
            assistantMsg.content += stormMsg;
            // 重置风暴计数
            this.#stormRecords = [];
            toolRounds++;
            continue;
          }

          // 执行工具调用批次
          const results = await this.#executeBatch(lastToolCalls);
          this.#stormRecords = results.records;

          for (const item of results.items) {
            yield { type: "tool_result", name: item.name, result: item.result };

            // 构建 tool 消息内容
            let toolContent = item.result.data;
            if (item.result.diff && item.result.diff.patch) {
              toolContent += `\n\n${item.result.diff.patch}`;
            }

            this.#messages.push({
              role: "tool",
              content: toolContent,
              toolCallId: item.callId,
              name: item.name,
            });
          }

          toolRounds++;
          continue;
        }

        // 没有工具调用，退出循环
        break;
      }
    } catch (err: unknown) {
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

    const elapsed = Date.now() - startTime;
    yield { type: "done", elapsed };
  }

  // -------------------------------------------------------------------------
  // 工具执行 — 批量、并行/串行、Gate、风暴检测
  // -------------------------------------------------------------------------

  /**
   * 执行一批工具调用。
   *
   * 并行策略：
   * - 如果这批工具全部是 ReadOnly 的，并行执行（最多 8 并发）
   * - 否则按顺序串行执行，保证写/读顺序
   */
  async #executeBatch(calls: ProviderToolCall[]): Promise<{ items: Array<{ name: string; callId: string; result: ToolResult }>; records: ToolCallRecord[] }> {
    const toolCtx: ToolContext = {
      cwd: this.#options.cwd,
      signal: this.#abortController.signal,
      writeRoots: this.#options.writeRoots,
    };

    // 判断是否能并行：全部 ReadOnly（使用 ToolKind 语义分类）
    const allReadOnly = calls.every((tc) => {
      const tool = this.#toolRegistry.get(tc.name);
      return tool ? isReadOnly(tool.kind) : true;
    });

    if (allReadOnly && calls.length > 1) {
      // 并行执行 ReadOnly 工具
      const MAX_PARALLEL = 8;
      const items: Array<{ name: string; callId: string; result: ToolResult }> = [];
      const records: ToolCallRecord[] = [];

      // 分批并行，每批最多 MAX_PARALLEL 个
      for (let i = 0; i < calls.length; i += MAX_PARALLEL) {
        const batch = calls.slice(i, i + MAX_PARALLEL);
        const promises = batch.map((tc) => this.#executeOne(tc, toolCtx));
        const batchResults = await Promise.all(promises);
        for (const r of batchResults) {
          items.push(r.item);
          records.push(r.record);
        }
      }

      return { items, records };
    }

    // 串行执行
    const items: Array<{ name: string; callId: string; result: ToolResult }> = [];
    const records: ToolCallRecord[] = [];
    for (const tc of calls) {
      const r = await this.#executeOne(tc, toolCtx);
      items.push(r.item);
      records.push(r.record);
    }

    return { items, records };
  }

  /**
   * 执行单个工具调用，包含 Gate 检查和预览。
   */
  async #executeOne(
    tc: ProviderToolCall,
    ctx: ToolContext,
  ): Promise<{ item: { name: string; callId: string; result: ToolResult }; record: ToolCallRecord }> {
    const toolName = tc.name;
    const timestamp = Date.now();

    // 1. 查找工具
    const tool = this.#toolRegistry.get(toolName);
    if (!tool) {
      const errMsg = `工具 "${toolName}" 不存在或已被禁用`;
      return {
        item: { name: toolName, callId: tc.id, result: { success: false, data: errMsg, error: "TOOL_NOT_FOUND" } },
        record: { name: toolName, success: false, error: "TOOL_NOT_FOUND", timestamp },
      };
    }

    // 2. 解析参数
    let toolArgs: unknown;
    try {
      toolArgs = tc.arguments ? JSON.parse(tc.arguments) : {};
    } catch {
      toolArgs = {};
    }

    // 3. Gate 检查（权限门）
    const gateResult = await this.#options.gate.check(toolName, toolArgs);
    if (!gateResult) {
      const errMsg = `工具 "${toolName}" 被权限门拒绝`;
      return {
        item: { name: toolName, callId: tc.id, result: { success: false, data: errMsg, error: "GATE_DENIED" } },
        record: { name: toolName, success: false, error: "GATE_DENIED", timestamp },
      };
    }

    // 4. 非只读工具有预览（可选）
    if (!isReadOnly(tool.kind)) {
      const maybePreview = (tool as { preview?: (args: unknown, ctx: ToolContext) => Promise<unknown> }).preview;
      if (typeof maybePreview === "function") {
        try {
          await maybePreview(toolArgs, ctx);
        } catch {
          // 预览失败不影响执行
        }
      }
    }

    // 5. 执行工具
    try {
      const result = await tool.execute(toolArgs, ctx);
      return {
        item: { name: toolName, callId: tc.id, result },
        record: {
          name: toolName,
          success: result.success,
          error: result.error,
          timestamp,
        },
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const errorResult = { success: false, data: `工具 "${toolName}" 执行异常：${message}`, error: "EXECUTION_ERROR" };
      return {
        item: { name: toolName, callId: tc.id, result: errorResult },
        record: { name: toolName, success: false, error: "EXECUTION_ERROR", timestamp },
      };
    }
  }

  // -------------------------------------------------------------------------
  // 风暴检测 — 同一工具同一错误连续 3 次 → 强制换策略
  // -------------------------------------------------------------------------

  /**
   * 连续 3 次同一工具同一错误 → 触发风暴中断。
   */
  #checkStormBreak(currentCalls: ProviderToolCall[]): boolean {
    if (this.#stormRecords.length < 3) return false;

    // 检查当前调用中是否有工具名与最近 3 次错误记录匹配
    const recentErrors = this.#stormRecords.slice(-3);
    if (recentErrors.length < 3) return false;

    // 检查最近 3 次是否同一工具同一错误
    const first = recentErrors[0] as ToolCallRecord;
    const allSame = recentErrors.every(
      (r) => r.name === first.name && r.error === first.error && !r.success,
    );

    if (!allSame) return false;

    // 检查当前调用是否还包含这个工具
    return currentCalls.some((tc) => tc.name === first.name);
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
    this.#stormRecords = [];
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
