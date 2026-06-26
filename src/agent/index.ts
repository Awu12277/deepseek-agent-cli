// ---------------------------------------------------------------------------
// Agent 会话 — 消息编排、流式 LLM 调用、工具执行循环、成本追踪、检查点、持久化
// ---------------------------------------------------------------------------

import type {
  ChatMessage,
  ChatOptions,
  Provider,
  ProviderToolCall,
  UsageInfo,
  ModelId,
  ToolDefinition,
} from "../provider/index.js";
import { CostTracker } from "../provider/index.js";
import type { ToolContext, AnyAgentTool } from "../tool/index.js";
import { isReadOnly } from "../tool/types.js";
import type { AgentEvent, SessionMode, SystemPromptOptions } from "./types.js";
import { buildSystemPrompt, buildPlanSystemPrompt } from "./system-prompt.js";
import { trimMessages, buildApiMessages } from "./message-builder.js";
import { ToolRegistry } from "../tool/registry.js";
import type { Gate, ToolCallRecord, ToolResult } from "../tool/types.js";
import { AlwaysAllowGate } from "../tool/types.js";
import {
  createCheckpoint,
  restoreCheckpointForce,
  restoreToClean,
  discardCheckpoint,
  type Checkpoint,
} from "../checkpoint/index.js";
import { SessionStore, type StoredSession } from "../session-store/index.js";

/** Session 构造选项 */
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
}

/** 消息检查点信息（对外暴露） */
export interface MessageCheckpointInfo {
  index: number;
  preview: string;
  timestamp: number;
  isGitRepo: boolean;
}

/** rewind 操作结果 */
export type RewindResult =
  | { ok: true; fileRestored: boolean }
  | { ok: false; error: string };

export class Session {
  readonly #messages: ChatMessage[] = [];
  readonly #provider: Provider;
  readonly #toolRegistry: ToolRegistry;
  readonly #costTracker: CostTracker;
  readonly #options: Required<
    Pick<SessionOptions, "cwd" | "maxToolRounds" | "reservedForOutput" | "preserveRecentRounds">
  > & { projectContext?: string; gate: Gate; writeRoots: string[]; enableCheckpoint: boolean };
  readonly #abortController = new AbortController();

  readonly #sessionId: string;
  readonly #store: SessionStore | null;
  #createdAt: number;
  #persistTimer: NodeJS.Timeout | null = null;

  #checkpoints = new Map<number, Checkpoint>();
  #stormRecords: ToolCallRecord[] = [];
  #mode: SessionMode = "code";

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
    };
    this.#sessionId = options?.sessionId ?? SessionStore.newId();
    this.#store = options?.store === false ? null : (options?.store ?? new SessionStore());
    this.#createdAt = Date.now();
  }

  get messages(): readonly ChatMessage[] { return this.#messages; }
  get accumulatedCost(): number { return this.#costTracker.sessionTotalCost; }
  get costTracker(): CostTracker { return this.#costTracker; }
  get model(): string { return this.#provider.model(); }
  get toolRegistry(): ToolRegistry { return this.#toolRegistry; }
  get mode(): SessionMode { return this.#mode; }
  get id(): string { return this.#sessionId; }
  get store(): SessionStore | null { return this.#store; }
  get createdAt(): number { return this.#createdAt; }

  setMode(mode: SessionMode): SessionMode { this.#mode = mode; return this.#mode; }

  async *chat(userInput: string, opts?: ChatOptions): AsyncGenerator<AgentEvent> {
    this.#messages.push({ role: "user", content: userInput });
    const userMsgIndex = this.#messages.length - 1;
    if (this.#options.enableCheckpoint) {
      try {
        const checkpoint = await createCheckpoint(this.#options.cwd);
        this.#checkpoints.set(userMsgIndex, checkpoint);
      } catch { /* swallow */ }
    }

    const startTime = Date.now();
    let toolRounds = 0;

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

        const toolDefs = this.#buildToolDefinitions();
        const stream = this.#provider.chat(apiMessages, {
          signal: this.#abortController.signal,
          tools: toolDefs.length > 0 ? toolDefs : undefined,
          thinkingAllowed: opts?.thinkingAllowed,
          thinkingEffort: opts?.thinkingEffort,
          responseFormat: opts?.responseFormat,
          toolChoice: opts?.toolChoice,
        });

        let accumulatedText = "";
        let lastUsage: UsageInfo | undefined;
        let lastToolCalls: ProviderToolCall[] | undefined;
        let _lastFinishReason: string | null = null;

        for await (const chunk of stream) {
          if (chunk.content) {
            accumulatedText += chunk.content;
            yield { type: "text_delta", content: chunk.content };
          }
          if (chunk.toolCalls && chunk.toolCalls.length > 0) lastToolCalls = chunk.toolCalls;
          if (chunk.usage) lastUsage = chunk.usage;
          if (chunk.finishReason) _lastFinishReason = chunk.finishReason;
        }

        if (lastUsage) {
          const modelId = this.#provider.model() as unknown as ModelId;
          this.#costTracker.record(lastUsage, modelId);
          yield { type: "usage", usage: lastUsage, model: modelId };
        }

        const assistantMsg: ChatMessage = { role: "assistant", content: accumulatedText };
        if (lastToolCalls && lastToolCalls.length > 0) assistantMsg.toolCalls = lastToolCalls;
        this.#messages.push(assistantMsg);

        if (lastToolCalls && lastToolCalls.length > 0) {
          yield { type: "tool_calls", calls: lastToolCalls };

          const stormBroken = this.#checkStormBreak(lastToolCalls);
          if (stormBroken) {
            const stormMsg = "\n⚠️ 同一工具重复出错，已强制切换策略\n";
            yield { type: "text_delta", content: stormMsg };
            assistantMsg.toolCalls = undefined;
            assistantMsg.content += stormMsg;
            this.#stormRecords = [];
            toolRounds++;
            continue;
          }

          const results = await this.#executeBatch(lastToolCalls);
          this.#stormRecords = results.records;

          for (const item of results.items) {
            yield { type: "tool_result", name: item.name, result: item.result };
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
      yield { type: "error", error: err instanceof Error ? err : new Error(String(err)) };
      return;
    }

    const elapsed = Date.now() - startTime;
    void this.#persist();
    // 持久化今日成本数据，确保进程退出后重开不会丢失
    await this.#costTracker.flush().catch(() => {});
    yield { type: "done", elapsed };
  }

  async #executeBatch(calls: ProviderToolCall[]): Promise<{ items: Array<{ name: string; callId: string; result: ToolResult }>; records: ToolCallRecord[] }> {
    const toolCtx: ToolContext = {
      cwd: this.#options.cwd,
      signal: this.#abortController.signal,
      writeRoots: this.#options.writeRoots,
    };

    const allReadOnly = calls.every((tc) => {
      const tool = this.#toolRegistry.get(tc.name);
      return tool ? isReadOnly(tool.kind) : true;
    });

    if (allReadOnly && calls.length > 1) {
      const MAX_PARALLEL = 8;
      const items: Array<{ name: string; callId: string; result: ToolResult }> = [];
      const records: ToolCallRecord[] = [];
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

    const items: Array<{ name: string; callId: string; result: ToolResult }> = [];
    const records: ToolCallRecord[] = [];
    for (const tc of calls) {
      const r = await this.#executeOne(tc, toolCtx);
      items.push(r.item);
      records.push(r.record);
    }
    return { items, records };
  }

  async #executeOne(
    tc: ProviderToolCall,
    ctx: ToolContext,
  ): Promise<{ item: { name: string; callId: string; result: ToolResult }; record: ToolCallRecord }> {
    const toolName = tc.name;
    const timestamp = Date.now();
    const tool = this.#toolRegistry.get(toolName);
    if (!tool) {
      const errMsg = `工具 "${toolName}" 不存在或已被禁用`;
      return {
        item: { name: toolName, callId: tc.id, result: { success: false, data: errMsg, error: "TOOL_NOT_FOUND" } },
        record: { name: toolName, success: false, error: "TOOL_NOT_FOUND", timestamp },
      };
    }

    let toolArgs: unknown;
    try { toolArgs = tc.arguments ? JSON.parse(tc.arguments) : {}; } catch { toolArgs = {}; }

    const gateResult = await this.#options.gate.check(toolName, toolArgs);
    if (!gateResult) {
      const errMsg = `工具 "${toolName}" 被权限门拒绝`;
      return {
        item: { name: toolName, callId: tc.id, result: { success: false, data: errMsg, error: "GATE_DENIED" } },
        record: { name: toolName, success: false, error: "GATE_DENIED", timestamp },
      };
    }

    if (!isReadOnly(tool.kind)) {
      const maybePreview = (tool as { preview?: (args: unknown, ctx: ToolContext) => Promise<unknown> }).preview;
      if (typeof maybePreview === "function") {
        try { await maybePreview(toolArgs, ctx); } catch { /* ignore */ }
      }
    }

    try {
      const result = await tool.execute(toolArgs, ctx);
      return {
        item: { name: toolName, callId: tc.id, result },
        record: { name: toolName, success: result.success, error: result.error, timestamp },
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

  #checkStormBreak(currentCalls: ProviderToolCall[]): boolean {
    if (this.#stormRecords.length < 3) return false;
    const recentErrors = this.#stormRecords.slice(-3);
    if (recentErrors.length < 3) return false;
    const first = recentErrors[0]!;
    const allSame = recentErrors.every((r) => r.name === first.name && r.error === first.error && !r.success);
    if (!allSame) return false;
    return currentCalls.some((tc) => tc.name === first.name);
  }

  abort(): void {
    this.#abortController.abort();
    if (this.#persistTimer) { clearTimeout(this.#persistTimer); this.#persistTimer = null; }
  }

  reset(): void {
    this.#messages.length = 0;
    this.#costTracker.resetSession();
    this.#stormRecords = [];
    this.#checkpoints.clear();
  }

  // -------------------------------------------------------------------------
  // 持久化与恢复
  // -------------------------------------------------------------------------

  async persistNow(): Promise<void> {
    if (this.#persistTimer) { clearTimeout(this.#persistTimer); this.#persistTimer = null; }
    await this.#doPersist();
  }

  #persist(): void {
    if (!this.#store) return;
    if (this.#persistTimer) { this.#persistTimer.refresh(); return; }
    this.#persistTimer = setTimeout(() => {
      this.#persistTimer = null;
      void this.#doPersist();
    }, 500);
    this.#persistTimer.unref();
  }

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

  #deriveTitle(): string {
    for (const m of this.#messages) {
      if (m.role === "user" && m.content.trim()) return m.content.trim().slice(0, 40);
    }
    return "新会话";
  }

  #serializeMessages(): StoredSession["messages"] {
    return this.#messages.map((msg, idx) => {
      const checkpoint = this.#checkpoints.get(idx);
      if (msg.role === "user" && checkpoint) return { ...msg, checkpoint };
      return { ...msg };
    });
  }

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

  listCheckpoints(): MessageCheckpointInfo[] {
    const result: MessageCheckpointInfo[] = [];
    for (const [index, checkpoint] of this.#checkpoints) {
      const msg = this.#messages[index];
      if (!msg || msg.role !== "user") continue;
      result.push({ index, preview: msg.content.slice(0, 80), timestamp: checkpoint.timestamp, isGitRepo: checkpoint.isGitRepo });
    }
    return result.sort((a, b) => a.index - b.index);
  }

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

  hasCheckpoints(): boolean { return this.listCheckpoints().length > 0; }

  async delete(): Promise<void> {
    if (this.#store) await this.#store.delete(this.#sessionId);
    for (const cp of this.#checkpoints.values()) { void discardCheckpoint(cp); }
    this.#checkpoints.clear();
  }

  // -------------------------------------------------------------------------
  // 内部方法
  // -------------------------------------------------------------------------

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

  #buildToolDefinitions(): ToolDefinition[] {
    const tools = this.#mode === "plan" ? this.#toolRegistry.listReadTools() : this.#toolRegistry.list();
    return tools.map((t) => ({
      type: "function" as const,
      function: { name: t.name, description: t.description, parameters: t.parameters as unknown as Record<string, unknown> },
    }));
  }
}
