// ---------------------------------------------------------------------------
// Agent 会话 — 协调者（Coordinator）
//
// 职责（瘦身后）：
//   1. 编排 chat() 主循环（用户输入 → LLM → 工具 → 持久化）
//   2. 协调三个纯职责子模块：
//      - ToolExecutor   — 纯执行（tool-executor.ts）
//      - StormDetector  — 纯判断（storm-detector.ts）
//      - buildToolDefinitions / trimMessages — 纯计算（tool-definitions.ts / message-builder.ts）
//   3. 维护会话级状态：消息历史、checkpoints、模式、成本追踪、日志
//   4. 持久化与恢复
//
// 函数注释规范见仓库根 AGENTS.md「函数注释规范」一节。
// ---------------------------------------------------------------------------

import type {
  ChatMessage,
  ChatOptions,
  Provider,
  ProviderToolCall,
  UsageInfo,
  ModelId,
} from "../provider/index.js";
import { CostTracker, calculateCost } from "../provider/index.js";
import type { AnyAgentTool } from "../tool/index.js";
import type { Gate, ToolCallRecord } from "../tool/types.js";
import { AlwaysAllowGate } from "../tool/types.js";
import type { AgentEvent, SessionMode, SystemPromptOptions } from "./types.js";
import { buildSystemPrompt, buildPlanSystemPrompt } from "./system-prompt.js";
import { trimMessages, buildApiMessages } from "./message-builder.js";
import { ToolRegistry } from "../tool/registry.js";
import { ToolExecutor } from "./tool-executor.js";
import { StormDetector } from "./storm-detector.js";
import { buildToolDefinitions } from "./tool-definitions.js";
import {
  createCheckpoint,
  restoreCheckpointForce,
  restoreToClean,
  discardCheckpoint,
  type Checkpoint,
} from "../checkpoint/index.js";
import { SessionStore, type StoredSession } from "../session-store/index.js";
import { ConversationLogger } from "../logger/index.js";

/**
 * Session 构造选项。
 *
 * @field cwd — 当前工作目录，决定 checkpoint/工具路径解析的根
 * @field maxToolRounds — 单次 chat() 内允许的最大工具调用轮数（防无限循环）
 * @field reservedForOutput — 上下文裁剪时为模型输出预留的 token 数
 * @field preserveRecentRounds — 上下文裁剪时强制保留的最近回合数
 * @field projectContext — 项目级背景（如 AGENTS.md 内容），注入到 system prompt
 * @field gate — 工具权限门；不传则使用 AlwaysAllowGate（全部放行）
 * @field writeRoots — 写工具允许的根目录列表（绝对路径）
 * @field sessionId — 复用会话 ID；不传则生成新 UUID
 * @field store — 会话存储实例；传 false 禁用持久化（用于测试）
 * @field enableCheckpoint — 是否启用 git 检查点（/rewind 需要），默认 true
 * @field enableLog — 是否启用对话日志（写入 .dskcode/logs/），默认 true
 */
export interface SessionOptions {
  cwd?: string;
  maxToolRounds?: number;
  reservedForOutput?: number;
  preserveRecentRounds?: number;
  projectContext?: string;
  gate?: Gate;
  writeRoots?: string[];
  /**
   * 会话 ID。传入则复用，不传则生成新 UUID。
   * 使用 Session.resume() 恢复会话时必须传。
   */
  sessionId?: string;
  /**
   * 会话存储实例。不传则使用默认 ~/.dskcode/sessions/。
   * 传 false 禁用持久化（用于测试和不需要保存的场景）。
   */
  store?: SessionStore | false;
  /** 是否启用 checkpoint（/rewind 需要），默认 true */
  enableCheckpoint?: boolean;
  /** 是否启用对话日志记录（写入 .dskcode/logs/），默认 true */
  enableLog?: boolean;
}

/**
 * 消息检查点信息（对外暴露给 UI 展示 /rewind 列表用）。
 *
 * @field index — 该 user 消息在 messages 数组中的索引
 * @field preview — 用户消息前 80 字
 * @field timestamp — checkpoint 创建时间（毫秒）
 * @field isGitRepo — 该检查点对应的工作区是否为 git 仓库（决定能否文件回退）
 */
export interface MessageCheckpointInfo {
  index: number;
  preview: string;
  timestamp: number;
  isGitRepo: boolean;
}

/**
 * rewind 操作结果。
 * - `ok: true` 时 `fileRestored` 标明文件工作区是否被回退
 * - `ok: false` 时 `error` 为人类可读的错误描述
 */
export type RewindResult =
  | { ok: true; fileRestored: boolean }
  | { ok: false; error: string };

/**
 * Session — 单个对话会话的协调者。
 *
 * 责任范围（瘦身后）：
 * 1. 编排 chat() 主循环：用户输入 → 构建 prompt → 调 LLM → 工具执行 → 持久化
 * 2. 维护会话级状态：messages、checkpoints、mode、cost、log
 * 3. 不再直接实现工具执行与风暴检测，而是委托给 ToolExecutor / StormDetector
 */
export class Session {
  /** 当前会话的消息历史（含 system/user/assistant/tool），可外部只读 */
  readonly #messages: ChatMessage[] = [];
  /** LLM Provider（DeepSeek 等） */
  readonly #provider: Provider;
  /** 工具注册表（所有可用工具） */
  readonly #toolRegistry: ToolRegistry;
  /** 成本追踪器（今日 + 本会话） */
  readonly #costTracker: CostTracker;
  /** 归一化后的构造选项（带默认值） */
  readonly #options: Required<
    Pick<SessionOptions, "cwd" | "maxToolRounds" | "reservedForOutput" | "preserveRecentRounds">
  > & { projectContext?: string; gate: Gate; writeRoots: string[]; enableCheckpoint: boolean; enableLog: boolean };
  /** 中止信号控制器（abort() 时触发，传递给 LLM 和工具） */
  readonly #abortController = new AbortController();

  /** 会话唯一 ID（UUID） */
  readonly #sessionId: string;
  /** 持久化存储；传 false 时为 null */
  readonly #store: SessionStore | null;
  /** 会话创建时间（毫秒） */
  #createdAt: number;
  /** 节流持久化定时器（500ms debounce） */
  #persistTimer: NodeJS.Timeout | null = null;

  /** user 消息 → Checkpoint 映射（仅给 user 消息建点） */
  #checkpoints = new Map<number, Checkpoint>();
  /** 最近的失败记录（仅失败的，用于风暴检测） */
  #stormRecords: ToolCallRecord[] = [];
  /** 当前会话模式：code（默认）/ plan（只读） */
  #mode: SessionMode = "code";
  /** 对话日志记录器（写入 .dskcode/logs/） */
  readonly #logger: ConversationLogger;
  /** 风暴检测器（连续 3 次同工具同错码失败时中断本轮） */
  readonly #stormDetector: StormDetector;

  /**
   * 构造一个 Session。
   *
   * @param provider — LLM Provider 实例（必须）
   * @param tools — 工具列表或已初始化的 ToolRegistry（默认空）
   * @param costTracker — 成本追踪器（默认新建）
   * @param options — 会话选项（详见 SessionOptions）
   *
   * @sideEffect 创建 .dskcode/logs/ 下的日志文件并写入 session_start 事件
   */
  constructor(
    provider: Provider,
    tools: AnyAgentTool[] | ToolRegistry = [],
    costTracker?: CostTracker,
    options?: SessionOptions,
  ) {
    this.#provider = provider;
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
      enableCheckpoint: options?.enableCheckpoint ?? true,
      enableLog: options?.enableLog ?? true,
    };
    this.#sessionId = options?.sessionId ?? SessionStore.newId();
    this.#store = options?.store === false ? null : (options?.store ?? new SessionStore());
    this.#createdAt = Date.now();
    this.#logger = new ConversationLogger(this.#sessionId, this.#options.cwd, {
      enabled: this.#options.enableLog,
    });
    this.#logger.logSessionStart(this.#sessionId, this.#options.cwd, this.#provider.model(), this.#mode);
    this.#stormDetector = new StormDetector({ threshold: 3 });
  }

  /** 当前会话的完整消息历史（只读视图） */
  get messages(): readonly ChatMessage[] { return this.#messages; }
  /** 本次会话累计成本（人民币元） */
  get accumulatedCost(): number { return this.#costTracker.sessionTotalCost; }
  /** 成本追踪器（含今日总成本、会话成本、模型维度统计） */
  get costTracker(): CostTracker { return this.#costTracker; }
  /** 当前模型标识（如 "deepseek-v4-flash"） */
  get model(): string { return this.#provider.model(); }
  /** 工具注册表（可外部读 / 运行时 register） */
  get toolRegistry(): ToolRegistry { return this.#toolRegistry; }
  /** 当前模式："code" | "plan" */
  get mode(): SessionMode { return this.#mode; }
  /** 会话 ID（UUID） */
  get id(): string { return this.#sessionId; }
  /** 持久化存储实例（禁用持久化时为 null） */
  get store(): SessionStore | null { return this.#store; }
  /** 会话创建时间戳（毫秒） */
  get createdAt(): number { return this.#createdAt; }

  /**
   * 切换会话模式。
   *
   * @param mode — "code"：全部工具；"plan"：只暴露只读工具
   * @returns 设置后的模式（便于链式调用）
   */
  setMode(mode: SessionMode): SessionMode { this.#mode = mode; return this.#mode; }

  /**
   * chat() — 接收一轮用户输入，串起 LLM 调用 / 工具执行 / 风暴中断 / 持久化。
   *
   * 主循环每轮做：
   * 1. 构建 system prompt + 裁剪消息 + 拼装 apiMessages
   * 2. 调 provider.chat() 拿流式 chunks，向外 yield text_delta / usage 事件
   * 3. 若本轮有 tool_calls：
   *    a. 先调 StormDetector.shouldBreak 判定是否中断风暴
   *    b. 调 ToolExecutor.executeBatch 执行工具
   *    c. 把工具结果 yield 出去并写入 messages
   * 4. 持续到 LLM 不再调工具 或 达到 maxToolRounds
   *
   * @param userInput — 用户本轮输入
   * @param opts — 透传给 provider.chat() 的 ChatOptions（thinking / tool_choice 等）
   * @yields AgentEvent — text_delta / tool_calls / tool_result / usage / done / error
   *
   * @sideEffect 写入 messages、logger、costTracker、可能触发 checkpoint / persist
   */
  async *chat(userInput: string, opts?: ChatOptions): AsyncGenerator<AgentEvent> {
    this.#messages.push({ role: "user", content: userInput });
    this.#logger.logUserMessage(userInput);
    const userMsgIndex = this.#messages.length - 1;
    if (this.#options.enableCheckpoint) {
      try {
        const checkpoint = await createCheckpoint(this.#options.cwd);
        this.#checkpoints.set(userMsgIndex, checkpoint);
      } catch { /* swallow — checkpoint 失败不应阻塞对话 */ }
    }

    const startTime = Date.now();
    let toolRounds = 0;
    // 工具执行器：本轮内共享同一 signal，避免每次调用都重新构建
    const toolExecutor = this.#buildToolExecutor();

    try {
      while (toolRounds < this.#options.maxToolRounds) {
        const systemPrompt = this.#buildSystemPrompt();
        const [trimmed] = trimMessages(
          [...this.#messages],
          {
            model: this.#provider.model() as unknown as ModelId,
            reservedForOutput: this.#options.reservedForOutput,
            systemPrompt,
            preserveRecentRounds: this.#options.preserveRecentRounds,
          },
        );
        const apiMessages = buildApiMessages(systemPrompt, trimmed);

        const toolDefs = buildToolDefinitions(this.#toolRegistry, this.#mode);
        const stream = this.#provider.chat(apiMessages, {
          signal: this.#abortController.signal,
          tools: toolDefs.length > 0 ? toolDefs : undefined,
          thinkingAllowed: opts?.thinkingAllowed,
          thinkingEffort: opts?.thinkingEffort,
          responseFormat: opts?.responseFormat,
          toolChoice: opts?.toolChoice,
        });

        const modelId = this.#provider.model() as unknown as ModelId;

        let accumulatedText = "";
        let lastUsage: UsageInfo | undefined;
        let lastToolCalls: ProviderToolCall[] | undefined;
        let _lastFinishReason: string | null = null;

        // 本轮输入 token 估算（在流式开始前一次计算；DeepSeek 流式只在最后一个
        // chunk 才返回 usage，中间过程中 UI 无法得知当前消耗，因此客户端本地估算）
        let estimatedInputTokens = 0;
        for (const m of apiMessages) {
          estimatedInputTokens += this.#provider.countTokens(m.content) + 10;
        }
        let lastEmitMs = 0;
        const EST_EMIT_INTERVAL_MS = 300;

        for await (const chunk of stream) {
          if (chunk.content) {
            accumulatedText += chunk.content;
            yield { type: "text_delta", content: chunk.content };

            // 节流推送估算 usage，让 UI 能实时显示"已消耗 X tokens / ¥Y"
            const now = Date.now();
            if (now - lastEmitMs >= EST_EMIT_INTERVAL_MS) {
              lastEmitMs = now;
              const estOutput = this.#provider.countTokens(accumulatedText);
              const estUsage: UsageInfo = {
                promptTokens: estimatedInputTokens,
                completionTokens: estOutput,
              };
              const estCost = calculateCost(estUsage, modelId);
              yield {
                type: "usage",
                usage: estUsage,
                model: modelId,
                cost: estCost.totalCost,
                estimated: true,
              };
            }
          }
          if (chunk.toolCalls && chunk.toolCalls.length > 0) lastToolCalls = chunk.toolCalls;
          if (chunk.usage) {
            lastUsage = chunk.usage;
            // 真实 usage 覆盖估算值
            const realCost = calculateCost(chunk.usage, modelId);
            yield {
              type: "usage",
              usage: chunk.usage,
              model: modelId,
              cost: realCost.totalCost,
              estimated: false,
            };
          }
          if (chunk.finishReason) _lastFinishReason = chunk.finishReason;
        }

        // 流式末尾再发一次最终 usage，作为权威值（此时 setCurrentUsage 会覆盖估算值）
        if (accumulatedText && !lastUsage) {
          const estOutput = this.#provider.countTokens(accumulatedText);
          const estUsage: UsageInfo = {
            promptTokens: estimatedInputTokens,
            completionTokens: estOutput,
          };
          const estCost = calculateCost(estUsage, modelId);
          yield {
            type: "usage",
            usage: estUsage,
            model: modelId,
            cost: estCost.totalCost,
            estimated: true,
          };
        }

        if (lastUsage) {
          this.#costTracker.record(lastUsage, modelId);
          const cost = calculateCost(lastUsage, modelId);
          this.#logger.logUsage(
            modelId, lastUsage.promptTokens, lastUsage.completionTokens,
            lastUsage.cachedPromptTokens, cost.totalCost, toolRounds,
          );
          yield { type: "usage", usage: lastUsage, model: modelId };
        }

        const assistantMsg: ChatMessage = { role: "assistant", content: accumulatedText };
        if (lastToolCalls && lastToolCalls.length > 0) assistantMsg.toolCalls = lastToolCalls;
        this.#messages.push(assistantMsg);
        this.#logger.logAssistantText(accumulatedText, toolRounds);

        if (lastToolCalls && lastToolCalls.length > 0) {
          yield { type: "tool_calls", calls: lastToolCalls };
          for (const tc of lastToolCalls) {
            this.#logger.logToolCall(tc.name, tc.id, tc.arguments, toolRounds);
          }

          const stormBroken = this.#stormDetector.shouldBreak(this.#stormRecords, lastToolCalls);
          if (stormBroken) {
            const stormMsg = "\n⚠️ 同一工具重复出错，已强制切换策略\n";
            yield { type: "text_delta", content: stormMsg };
            assistantMsg.toolCalls = undefined;
            assistantMsg.content += stormMsg;
            this.#stormRecords = [];
            toolRounds++;
            continue;
          }

          const results = await toolExecutor.executeBatch(lastToolCalls);
          this.#stormRecords = results.records;

          for (const item of results.items) {
            yield { type: "tool_result", name: item.name, result: item.result };
            this.#logger.logToolResult(
              item.name, item.callId, item.result.success,
              item.result.data, item.result.error, undefined, toolRounds,
            );
            let toolContent = item.result.data;
            if (item.result.diff && item.result.diff.patch) toolContent += `\n\n${item.result.diff.patch}`;
            this.#messages.push({
              role: "tool", content: toolContent,
              toolCallId: item.callId, name: item.name,
            });
          }

          toolRounds++;
          continue;
        }

        break;
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (err instanceof Error && err.name === "AbortError") return;
      this.#logger.logError(
        err instanceof Error ? err.message : String(err),
        err instanceof Error ? err.stack : undefined,
      );
      yield { type: "error", error: err instanceof Error ? err : new Error(String(err)) };
      return;
    }

    const elapsed = Date.now() - startTime;
    this.#logger.logTurnDone(elapsed, toolRounds);
    void this.#persist();
    // 持久化今日成本数据，确保进程退出后重开不会丢失
    await this.#costTracker.flush().catch(() => {});
    yield { type: "done", elapsed };
  }

  // -------------------------------------------------------------------------
  // 持久化与恢复
  // -------------------------------------------------------------------------

  /**
   * 中止当前会话：触发 AbortController，停止流式 LLM 和正在执行的工具。
   * 同时清掉节流持久化定时器。
   *
   * @sideEffect abort 当前 chat 循环、取消所有 #abortController 监听者
   */
  abort(): void {
    this.#abortController.abort();
    if (this.#persistTimer) { clearTimeout(this.#persistTimer); this.#persistTimer = null; }
  }

  /**
   * 刷新日志缓冲，确保所有已记录的事件落盘。
   * 通常在进程退出前调用，避免日志丢失。
   *
   * @sideEffect 写入 .dskcode/logs/ 下的日志文件
   */
  async flushLog(): Promise<void> {
    await this.#logger.flush();
  }

  /**
   * 清空消息历史、会话成本、风暴记录、checkpoints。
   * 注意：不会清掉磁盘上的会话记录（用 delete() 删除），仅重置内存状态。
   *
   * @sideEffect 抹掉 messages / costTracker / stormRecords / checkpoints
   */
  reset(): void {
    this.#messages.length = 0;
    this.#costTracker.resetSession();
    this.#stormRecords = [];
    this.#checkpoints.clear();
  }

  /**
   * 立即把当前状态写入持久化（不等 500ms debounce）。
   * 用于 UI 上"立即保存"按钮或异常退出前的最后兜底。
   *
   * @sideEffect 调用 #doPersist()，写入磁盘
   */
  async persistNow(): Promise<void> {
    if (this.#persistTimer) { clearTimeout(this.#persistTimer); this.#persistTimer = null; }
    await this.#doPersist();
  }

  /**
   * 节流持久化：500ms 内多次调用只会真正落盘一次。
   * 通过 setTimeout + timer.refresh() 实现 debounce。
   *
   * @sideEffect 调度一个 500ms 后的 #doPersist() 任务
   */
  #persist(): void {
    if (!this.#store) return;
    if (this.#persistTimer) { this.#persistTimer.refresh(); return; }
    this.#persistTimer = setTimeout(() => {
      this.#persistTimer = null;
      void this.#doPersist();
    }, 500);
    this.#persistTimer.unref();
  }

  /**
   * 真正执行持久化：构造 StoredSession 并写入 store。
   * 失败仅 console.error，不抛给调用方（持久化失败不应阻塞对话）。
   *
   * @sideEffect 写磁盘 ~/.dskcode/sessions/<id>.json
   */
  async #doPersist(): Promise<void> {
    if (!this.#store) return;
    const stored: StoredSession = {
      id: this.#sessionId,
      title: this.#deriveTitle(),
      createdAt: this.#createdAt,
      updatedAt: Date.now(),
      cwd: this.#options.cwd,
      model: this.#provider.model(),
      messages: this.#serializeMessages(),
      totalCost: this.#costTracker.sessionTotalCost,
    };
    try { await this.#store.save(stored); }
    catch (err) { console.error("[Session] 持久化失败:", err); }
  }

  /**
   * 从消息历史推导会话标题：取第一条非空 user 消息的前 40 字。
   * 无任何 user 消息时返回 "新会话"。
   *
   * @pure 不修改任何状态
   */
  #deriveTitle(): string {
    for (const m of this.#messages) {
      if (m.role === "user" && m.content.trim()) return m.content.trim().slice(0, 40);
    }
    return "新会话";
  }

  /**
   * 把内存 messages 转成可持久化的 StoredSession["messages"]。
   * 给 user 消息挂上对应 checkpoint（若存在），用于 rewind 时文件回退。
   *
   * @pure 不修改任何状态
   */
  #serializeMessages(): StoredSession["messages"] {
    return this.#messages.map((msg, idx) => {
      const checkpoint = this.#checkpoints.get(idx);
      if (msg.role === "user" && checkpoint) return { ...msg, checkpoint };
      return { ...msg };
    });
  }

  /**
   * 静态方法：从磁盘恢复一个之前保存的 Session。
   *
   * @param id — 之前 SessionStore 保存的会话 ID
   * @param provider — LLM Provider（必须）
   * @param tools — 工具列表/Registry（必须重新提供，因为工具不持久化）
   * @param costTracker — 成本追踪器（可选）
   * @param options — 会话选项（sessionId / store 必须与持久化 ID 对应）
   * @returns 恢复后的 Session 实例
   * @throws 持久化被禁用时、ID 不存在时抛错
   *
   * @sideEffect 从磁盘读 messages + checkpoints
   */
  static async resume(
    id: string,
    provider: Provider,
    tools: AnyAgentTool[] | ToolRegistry = [],
    costTracker?: CostTracker,
    options?: SessionOptions,
  ): Promise<Session> {
    const store = options?.store === false ? null : (options?.store ?? new SessionStore());
    if (!store) throw new Error("resume 需要启用持久化（options.store 不能为 false）");
    const stored = await store.load(id);
    if (!stored) throw new Error(`会话 ${id} 不存在`);

    const session = new Session(provider, tools, costTracker, { ...options, sessionId: id, store });
    for (const m of stored.messages) {
      session.#messages.push({
        role: m.role, content: m.content,
        toolCallId: m.toolCallId, name: m.name, toolCalls: m.toolCalls,
      });
    }
    for (let i = 0; i < stored.messages.length; i++) {
      const cp = stored.messages[i]?.checkpoint;
      if (cp) session.#checkpoints.set(i, cp);
    }
    session.#createdAt = stored.createdAt;
    return session;
  }

  // -------------------------------------------------------------------------
  // 检查点与 Rewind
  // -------------------------------------------------------------------------

  /**
   * 列出所有 user 消息对应的 checkpoint（按 index 升序）。
   * 用于 UI 展示 /rewind 列表。
   *
   * @returns 每个元素的 index = messages 数组索引，可直接传给 rewind()
   * @pure 不修改任何状态
   */
  listCheckpoints(): MessageCheckpointInfo[] {
    const result: MessageCheckpointInfo[] = [];
    for (const [index, checkpoint] of this.#checkpoints) {
      const msg = this.#messages[index];
      if (!msg || msg.role !== "user") continue;
      result.push({ index, preview: msg.content.slice(0, 80), timestamp: checkpoint.timestamp, isGitRepo: checkpoint.isGitRepo });
    }
    return result.sort((a, b) => a.index - b.index);
  }

  /**
   * rewind — 把消息历史截断到 targetIndex 对应的 user 消息，
   * 并尝试把文件工作区也回退到那一刻。
   *
   * @param targetIndex — 要回退到的 user 消息索引（来自 listCheckpoints()）
   * @returns
   *   - `{ ok: true, fileRestored }`：成功；fileRestored 表示工作区是否也被还原
   *   - `{ ok: false, error }`：失败（无效索引 / 非 user / 无 checkpoint / 文件恢复失败）
   *
   * 行为：
   * 1. 截断 messages 数组到 targetIndex + 1
   * 2. 移除并丢弃所有 > targetIndex 的 checkpoints
   * 3. 若目标 checkpoint 是 git 仓库：
   *    - 有 stashSha：恢复该 stash（force）
   *    - 无 stashSha：把工作区 restore 到 HEAD 干净状态
   * 4. 触发 #persist() 把截断后的状态写盘
   *
   * @sideEffect 改写 messages、checkpoints、磁盘
   */
  async rewind(targetIndex: number): Promise<RewindResult> {
    if (targetIndex < 0 || targetIndex >= this.#messages.length) {
      return { ok: false, error: `无效的消息索引 ${targetIndex}` };
    }
    const target = this.#messages[targetIndex];
    if (!target || target.role !== "user") {
      return { ok: false, error: `索引 ${targetIndex} 不是 user 消息` };
    }
    const checkpoint = this.#checkpoints.get(targetIndex);
    if (!checkpoint) return { ok: false, error: "该消息没有检查点" };

    this.#messages.length = targetIndex + 1;
    const toDiscard: Checkpoint[] = [];
    for (const [idx, cp] of this.#checkpoints) {
      if (idx > targetIndex) { toDiscard.push(cp); this.#checkpoints.delete(idx); }
    }

    let fileRestored = false;
    if (checkpoint.isGitRepo) {
      try {
        if (checkpoint.stashSha) {
          // 目标检查点有 stash 快照——恢复该快照
          await restoreCheckpointForce(checkpoint);
        } else {
          // 目标检查点 stashSha 为空，代表「那一刻工作区就是 HEAD 干净状态」。
          // 但后续对话产生的修改可能还积累在工作区，需要丢弃才能真正回退到那一刻。
          await restoreToClean(this.#options.cwd);
        }
        fileRestored = true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: `对话已截断但文件恢复失败：${msg}` };
      }
    }

    // restoreCheckpointForce 内部已 drop 了该 checkpoints 的 stash entry，
    // 所以只需从 Map 中移除即可，无需再 discardCheckpoint。
    this.#checkpoints.delete(targetIndex);
    for (const cp of toDiscard) { void discardCheckpoint(cp); }
    this.#persist();
    return { ok: true, fileRestored };
  }

  /**
   * 是否存在可用的 checkpoint（决定 UI 是否显示 /rewind 入口）。
   *
   * @pure 不修改任何状态
   */
  hasCheckpoints(): boolean { return this.listCheckpoints().length > 0; }

  /**
   * 彻底删除会话：从磁盘移除 SessionStore 条目、丢弃所有 checkpoint、关闭日志。
   * 删除后该 Session 实例不应再被使用。
   *
   * @sideEffect 删磁盘文件、清 checkpoints、flush 并关闭 logger
   */
  async delete(): Promise<void> {
    if (this.#store) await this.#store.delete(this.#sessionId);
    for (const cp of this.#checkpoints.values()) { void discardCheckpoint(cp); }
    this.#checkpoints.clear();
    this.#logger.logSessionEnd(Date.now() - this.#createdAt);
    await this.#logger.flush();
  }

  // -------------------------------------------------------------------------
  // 内部方法
  // -------------------------------------------------------------------------

  /**
   * 构建本轮使用的工具执行器（每次 chat() 调用一次，绑定当前 signal）。
   * 每次新建确保 abort signal 是当下有效的，且 #baseCtx 不会被多次调用共享篡改。
   *
   * @returns 新的 ToolExecutor 实例
   * @pure 仅组装参数，不修改任何状态
   */
  #buildToolExecutor(): ToolExecutor {
    return new ToolExecutor({
      registry: this.#toolRegistry,
      gate: this.#options.gate,
      baseCtx: {
        cwd: this.#options.cwd,
        signal: this.#abortController.signal,
        writeRoots: this.#options.writeRoots,
      },
    });
  }

  /**
   * 构建 system prompt：注入当前模型、cwd、工具清单、项目上下文。
   * plan 模式使用 buildPlanSystemPrompt（只读工具 + 计划输出格式），
   * code 模式使用 buildSystemPrompt。
   *
   * @returns 渲染好的 prompt 字符串
   * @pure 不修改任何状态
   */
  #buildSystemPrompt(): string {
    const enabledTools = this.#toolRegistry.list();
    const toolDescs = enabledTools.map((t) => ({
      name: t.name, description: t.description,
      parameters: t.parameters as unknown as Record<string, unknown>,
    }));
    const opts: SystemPromptOptions = {
      model: this.#provider.model(), maxToolRounds: this.#options.maxToolRounds,
      tools: toolDescs.length > 0 ? toolDescs : undefined,
      projectContext: this.#options.projectContext ?? undefined,
      cwd: this.#options.cwd,
    };
    if (this.#mode === "plan") return buildPlanSystemPrompt(opts);
    return buildSystemPrompt(opts);
  }
}
