// ---------------------------------------------------------------------------
// 上下文压缩（Compactor）— 长会话的"摘要降级"机制
//
// 设计动机：
// 1. trimMessages 只能"按窗口裁剪",一旦超过模型上下文窗口,会丢消息。
// 2. 长会话希望保留更多"语义"(用户意图、关键决策、改了哪些文件),所以用 LLM
//    把旧的几个回合"摘要"成一段 system 消息,塞到 messages 前面。
// 3. 保留最近 N 个回合的完整内容（保证当下任务上下文不丢）。
//
// 触发方式：
// - 手动：调用 compactContext()（CLI 的 /compact 命令）
// - 自动：每轮 chat 之前检查 shouldAutoCompact(),若超阈值则自动压缩
//
// 函数注释规范见仓库根 AGENTS.md「函数注释规范」一节。
// ---------------------------------------------------------------------------

import type { ChatMessage, Provider } from "../provider/index.js";
import type { ModelId } from "../provider/types.js";
import { estimateTokens, getModelMeta } from "../provider/models.js";
import { groupIntoTurns } from "./message-builder.js";

/** 自动压缩触发阈值（占上下文窗口比例），默认 0.85 */
export const DEFAULT_AUTO_COMPACT_RATIO = 0.85;

/** 压缩时强制保留的最近回合数，默认 6 */
export const DEFAULT_PRESERVE_ROUNDS = 6;

/** 触发压缩所需的最小回合数（少于此回合数不压缩），默认 8 */
export const DEFAULT_MIN_TURNS_TO_COMPACT = 8;

/** 摘要消息的固定前缀（用于持久化时识别"这是一条被注入的摘要"） */
export const SUMMARY_SENTINEL = "[history-summary]";

/** 摘要生成时的 system prompt（要求 LLM 保留意图/决策/文件路径/错误/未完成项） */
const SUMMARY_SYSTEM_PROMPT = `你是一个专业的对话摘要助手。你的任务是把多轮对话历史压缩成结构化中文摘要。

摘要必须保留以下信息（按重要性排序）：
1. 用户的核心目标与最终意图
2. 已完成的关键决策（如选了哪个方案、改了哪些文件、为什么这么改）
3. 涉及的具体文件路径（绝对/相对路径都要保留）
4. 出现过的错误信息与解决方案
5. 尚未完成的工作 / 待办事项
6. 重要的技术约束（如"不能用 XX 库"）

格式要求：
- 用纯文本，不要 markdown 标题分级
- 每条信息独立成行，方便后续按行解析
- 总长度控制在 2000 字以内
- 不需要客套话、不需要"以下是摘要"等开头
`;

/** 单条消息送入 LLM 摘要时，content 截断长度（防 prompt 爆炸） */
const PER_MESSAGE_TEXT_LIMIT = 500;

/** 兜底摘要里每条 user 消息保留的字符数 */
const FALLBACK_USER_PREVIEW = 60;

/**
 * 当前会话上下文的统计信息。
 *
 * @field messageCount — 消息条数（不含 system）
 * @field estimatedTokens — 估算的 token 数（不含 system prompt）
 * @field contextWindow — 当前模型的上下文窗口
 * @field ratio — estimatedTokens / contextWindow（占用比例）
 * @field headroom — contextWindow - estimatedTokens（剩余空间；负数表示已超限）
 */
export interface ContextStats {
  messageCount: number;
  estimatedTokens: number;
  contextWindow: number;
  ratio: number;
  headroom: number;
}

/**
 * 压缩进度事件。
 *
 * @field type — "start"：压缩开始（会在调 LLM 前发出）
 * @field type — "summary_delta"：调 LLM 生成摘要时每收到一个 chunk 都发出
 * @field type — "fallback"：LLM 失败走兑底时发出
 * @field type — "done"：压缩完成（会在改写 #messages 前发出，携带 before/after token）
 */
export type CompactionProgress =
  | { type: "start"; droppedTurns: number; beforeTokens: number }
  | { type: "summary_delta"; delta: string; totalSoFar: string }
  | { type: "fallback"; reason: string; fallbackSummary: string }
  | { type: "done"; droppedTurns: number; keptTurns: number; beforeTokens: number; afterTokens: number };

/**
 * 压缩配置。
 *
 * @field contextWindow — 模型上下文窗口（来自 getModelMeta）
 * @field autoCompactRatio — 自动压缩阈值比例（0~1），默认 0.85
 * @field preserveRecentRounds — 压缩时保留的最近回合数，默认 6
 * @field minTurnsToCompact — 触发压缩的最小回合数（少于此不压缩），默认 8
 * @field provider — 用于调 LLM 生成摘要
 * @field signal — 中止信号（可选；传给 provider.chat）
 * @field onProgress — 进度回调（可选；UI 可用此实时展示压缩进度）
 */
export interface CompactionOptions {
  contextWindow: number;
  autoCompactRatio?: number;
  preserveRecentRounds?: number;
  minTurnsToCompact?: number;
  provider: Provider;
  signal?: AbortSignal;
  /**
   * 进度回调。可选；调用方传入后可实时看到压缩进度。
   * - "start"：压缩开始
   * - "summary_delta"：LLM 生成摘要时每收到一个 chunk（实时流式）
   * - "fallback"：LLM 失败走兑底
   * - "done"：压缩完成
   * 错误不会从回调抛出（以免中断压缩流程）。
   */
  onProgress?: (event: CompactionProgress) => void;
}

/**
 * 压缩结果。
 *
 * @field messages — 压缩后的消息数组（system prompt 不含在内，由调用方拼接）
 * @field summary — 摘要文本（同时已注入到 messages[0] 的 content 里）
 * @field droppedTurns — 被压缩掉的回合数
 * @field keptTurns — 保留的完整回合数
 * @field beforeTokens — 压缩前 token 估算
 * @field afterTokens — 压缩后 token 估算
 */
export interface CompactionResult {
  messages: ChatMessage[];
  summary: string;
  droppedTurns: number;
  keptTurns: number;
  beforeTokens: number;
  afterTokens: number;
}

/**
 * 估算单条消息的 token 数。
 * 算法与 message-builder.ts 中的 estimateMessageTokens 保持一致：
 *   content 文本按 CJK 0.6 / 其它 0.3 加权 + 10 token 角色开销
 *   tool_calls 的 name + arguments 也算进文本
 *
 * @param msg — 单条消息
 * @returns 估算的 token 数（≥ 11）
 *
 * @pure 不修改入参
 */
function estimateMessageTokens(msg: ChatMessage): number {
  let text = msg.content;
  if (msg.toolCalls) {
    for (const tc of msg.toolCalls) {
      text += tc.name + tc.arguments;
    }
  }
  return estimateTokens(text) + 10;
}

/**
 * 估算一组消息的总 token 数。
 * system prompt 角色也算（按其他 message 同样算法），调用方一般只关心"messages 部分"即可。
 *
 * @param messages — 消息数组（不含外部 system prompt；调用方自行加）
 * @returns 估算总 token 数
 *
 * @pure 不修改入参
 */
export function estimateMessagesTokens(
  messages: ReadonlyArray<ChatMessage>,
): number {
  let sum = 0;
  for (const m of messages) sum += estimateMessageTokens(m);
  return sum;
}

/**
 * 计算当前上下文的统计信息（消息数 / token 估算 / 占窗口比例）。
 *
 * @param messages — 不含 system prompt 的消息历史
 * @param contextWindow — 模型上下文窗口大小
 * @returns 统计信息
 *
 * @pure 不修改入参
 */
export function getContextStats(
  messages: ReadonlyArray<ChatMessage>,
  contextWindow: number,
): ContextStats {
  const estimatedTokens = estimateMessagesTokens(messages);
  const ratio = contextWindow > 0 ? estimatedTokens / contextWindow : 0;
  return {
    messageCount: messages.length,
    estimatedTokens,
    contextWindow,
    ratio,
    headroom: contextWindow - estimatedTokens,
  };
}

/**
 * 判断是否应自动触发压缩。
 * 条件（全部满足）：
 * 1. 回合数 >= minTurnsToCompact（避免太短时无意义压缩）
 * 2. ratio >= autoCompactRatio（已用满 85%）
 *
 * @param messages — 不含 system prompt 的消息历史
 * @param opts — 压缩配置
 * @returns true=应压缩, false=暂不压缩
 *
 * @pure 不修改入参
 */
export function shouldAutoCompact(
  messages: ReadonlyArray<ChatMessage>,
  opts: CompactionOptions,
): boolean {
  const turns = groupIntoTurns(messages);
  const minTurns = opts.minTurnsToCompact ?? DEFAULT_MIN_TURNS_TO_COMPACT;
  if (turns.length < minTurns) return false;
  const ratio = opts.autoCompactRatio ?? DEFAULT_AUTO_COMPACT_RATIO;
  const stats = getContextStats(messages, opts.contextWindow);
  return stats.ratio >= ratio;
}

/**
 * 把旧回合转成送入 LLM 的 user 文本。
 * 每条消息标注角色，content 截断到 PER_MESSAGE_TEXT_LIMIT。
 *
 * @pure 不修改入参
 */
function turnsToPromptText(turns: ReadonlyArray<ReadonlyArray<ChatMessage>>): string {
  const lines: string[] = [];
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i]!;
    lines.push(`--- 第 ${i + 1} 回合 ---`);
    for (const msg of turn) {
      const head = `[${msg.role}]`;
      const body = msg.content.length > PER_MESSAGE_TEXT_LIMIT
        ? msg.content.slice(0, PER_MESSAGE_TEXT_LIMIT) + `…(已截断,原长 ${msg.content.length})`
        : msg.content;
      lines.push(`${head} ${body}`);
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          lines.push(`  tool_call: ${tc.name}(${tc.arguments})`);
        }
      }
    }
  }
  return lines.join("\n");
}

/**
 * 兜底摘要：LLM 失败时用，保证至少能压缩出"人也能看懂"的简短记录。
 * 列出每条 user 消息前 N 字 + assistant 调过的工具名。
 *
 * @pure 不修改入参
 */
function fallbackSummary(turns: ReadonlyArray<ReadonlyArray<ChatMessage>>): string {
  const lines: string[] = ["【本地摘要（LLM 调用失败时兜底）】"];
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i]!;
    const userMsg = turn.find((m) => m.role === "user");
    if (userMsg) {
      const preview = userMsg.content.slice(0, FALLBACK_USER_PREVIEW);
      lines.push(`回合${i + 1} 用户: ${preview}`);
    }
    const toolNames = new Set<string>();
    for (const m of turn) {
      if (m.toolCalls) for (const tc of m.toolCalls) toolNames.add(tc.name);
    }
    if (toolNames.size > 0) {
      lines.push(`  调用工具: ${[...toolNames].join(", ")}`);
    }
  }
  return lines.join("\n");
}

/**
 * 调 LLM 把旧回合流式摘要成完整字符串。
 * 失败（provider 抛错、信号中止、收到空字符串）时返回 fallback 摘要，不抛异常。
 *
 * @param oldTurns — 需要被压缩的回合（不含保留区）
 * @param opts — 压缩配置
 * @returns 完整摘要文本
 *
 * @sideEffect 调一次 provider.chat()，可能产生 token 消耗与日志
 */
export async function summarizeOldTurns(
  oldTurns: ReadonlyArray<ReadonlyArray<ChatMessage>>,
  opts: CompactionOptions,
): Promise<string> {
  if (oldTurns.length === 0) return "";
  const promptText = turnsToPromptText(oldTurns);

  try {
    const messages: ChatMessage[] = [
      { role: "system", content: SUMMARY_SYSTEM_PROMPT },
      {
        role: "user",
        content: `请把以下 ${oldTurns.length} 轮对话历史压缩成结构化摘要：\n\n${promptText}`,
      },
    ];
    const stream = opts.provider.chat(messages, {
      ...(opts.signal ? { signal: opts.signal } : {}),
      // 摘要场景压低温度，输出更稳定
      temperature: 0.2,
    });
    let summary = "";
    for await (const chunk of stream) {
      if (chunk.content) {
        summary += chunk.content;
        // 实时把增量推给 UI（错误静默处理 — onProgress 抛错不应影响压缩）
        if (opts.onProgress) {
          try {
            opts.onProgress({
              type: "summary_delta",
              delta: chunk.content,
              totalSoFar: summary,
            });
          } catch {
            /* 回调出错不影响压缩 */
          }
        }
      }
    }
    if (!summary.trim()) {
      const fb = fallbackSummary(oldTurns);
      if (opts.onProgress) {
        try {
          opts.onProgress({
            type: "fallback",
            reason: "LLM 返回空字符串",
            fallbackSummary: fb,
          });
        } catch {
          /* 静默 */
        }
      }
      return fb;
    }
    return summary.trim();
  } catch (err) {
    // LLM 摘要失败不抛错 — 走兑底，压缩流程不被打断
    const errMsg = err instanceof Error ? err.message : String(err);
    const fb = fallbackSummary(oldTurns);
    if (opts.onProgress) {
      try {
        opts.onProgress({
          type: "fallback",
          reason: errMsg,
          fallbackSummary: fb,
        });
      } catch {
        /* 静默 */
      }
    }
    return fb;
  }
}

/**
 * 把摘要文本拼成单条 system 角色的消息。
 * content 以 SUMMARY_SENTINEL 开头，方便持久化时识别。
 *
 * @param summary — 摘要文本
 * @returns 单条 system 消息
 *
 * @pure
 */
export function buildSummaryMessage(summary: string): ChatMessage {
  return {
    role: "system",
    content: `${SUMMARY_SENTINEL}\n${summary}`,
  };
}

/**
 * 主入口：执行一次上下文压缩。
 *
 * 流程：
 * 1. groupIntoTurns 分回合
 * 2. 若回合数 <= minTurnsToCompact：直接返回原 messages（标记 droppedTurns=0）
 * 3. 末 preserveRecentRounds 回合保留完整；其余回合送入 LLM 生成摘要
 * 4. 摘要包装为一条 system 消息（带 [history-summary] 前缀）放在 messages 最前
 * 5. 返回 CompactionResult
 *
 * @param messages — 不含 system prompt 的消息历史（不会被修改）
 * @param opts — 压缩配置
 * @returns 压缩结果
 *
 * @sideEffect 调一次 provider.chat() 走 LLM 摘要（可能失败走 fallback）
 */
export async function compactContext(
  messages: ReadonlyArray<ChatMessage>,
  opts: CompactionOptions,
): Promise<CompactionResult> {
  const beforeTokens = estimateMessagesTokens(messages);
  const turns = groupIntoTurns(messages);
  const minTurns = opts.minTurnsToCompact ?? DEFAULT_MIN_TURNS_TO_COMPACT;
  const preserveRounds = opts.preserveRecentRounds ?? DEFAULT_PRESERVE_ROUNDS;

  // 1) 太短不压缩：原样返回（不复制数组，引用一致便于调用方判等）
  if (turns.length < minTurns) {
    return {
      messages: messages.slice(),
      summary: "",
      droppedTurns: 0,
      keptTurns: turns.length,
      beforeTokens,
      afterTokens: beforeTokens,
    };
  }

  // 2) 没有可压的：所有回合都在保留区内
  if (turns.length <= preserveRounds) {
    return {
      messages: messages.slice(),
      summary: "",
      droppedTurns: 0,
      keptTurns: turns.length,
      beforeTokens,
      afterTokens: beforeTokens,
    };
  }

  // 3) 切分：前段旧回合 + 后段保留回合
  const splitAt = turns.length - preserveRounds;
  const oldTurns = turns.slice(0, splitAt);
  const keptTurns = turns.slice(splitAt);

  // 发出 start 事件（调 LLM 之前）
  if (opts.onProgress) {
    try {
      opts.onProgress({
        type: "start",
        droppedTurns: oldTurns.length,
        beforeTokens,
      });
    } catch {
      /* 静默 */
    }
  }

  // 4) 调 LLM 生成摘要（失败走 fallback）
  const summary = await summarizeOldTurns(oldTurns, opts);

  // 5) 拼装新 messages：summary 消息 + 保留回合
  const newMessages: ChatMessage[] = [buildSummaryMessage(summary)];
  for (const turn of keptTurns) {
    for (const msg of turn) {
      newMessages.push(msg);
    }
  }

  const afterTokens = estimateMessagesTokens(newMessages);

  // 发出 done 事件（改写消息之前）
  if (opts.onProgress) {
    try {
      opts.onProgress({
        type: "done",
        droppedTurns: oldTurns.length,
        keptTurns: keptTurns.length,
        beforeTokens,
        afterTokens,
      });
    } catch {
      /* 静默 */
    }
  }

  return {
    messages: newMessages,
    summary,
    droppedTurns: oldTurns.length,
    keptTurns: keptTurns.length,
    beforeTokens,
    afterTokens,
  };
}

// ---------------------------------------------------------------------------
// 便捷函数：从 ModelId 派生 CompactionOptions
// ---------------------------------------------------------------------------

/**
 * 从模型 ID 派生 CompactionOptions 的 contextWindow 字段（其他字段留空用默认）。
 * 调用方需要自行补 provider / signal。
 *
 * @param model — 模型 ID（如 "deepseek-v4-flash"）
 * @returns 含 contextWindow 的部分 CompactionOptions
 *
 * @pure
 */
export function compactionOptionsFromModel(
  model: ModelId,
  provider: Provider,
  signal?: AbortSignal,
): CompactionOptions {
  const meta = getModelMeta(model);
  return {
    contextWindow: meta.contextWindow,
    provider,
    ...(signal ? { signal } : {}),
  };
}
