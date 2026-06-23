// ---------------------------------------------------------------------------
// 消息组装 — 将历史消息与系统提示词合并，支持上下文裁剪
// ---------------------------------------------------------------------------

import type { ChatMessage, UsageInfo } from "../provider/index.js";
import type { ModelId } from "../provider/types.js";
import { getModelMeta, estimateTokens } from "../provider/models.js";

/** 上下文裁剪策略 */
export interface TrimOptions {
  /** 模型标识，用于获取上下文窗口大小 */
  model: ModelId;
  /** 为模型输出预留的 token 数 */
  reservedForOutput: number;
  /** 系统提示词（始终保留） */
  systemPrompt: string;
  /** 最近 N 轮对话强制保留（不参与裁剪） */
  preserveRecentRounds: number;
}

/**
 * 估算消息的 token 数。
 * 简单估算：content 长度 × 0.3 + 角色开销 ~10 tokens
 */
function estimateMessageTokens(msg: ChatMessage): number {
  let text = msg.content;
  // 工具调用的参数也算
  if (msg.toolCalls) {
    for (const tc of msg.toolCalls) {
      text += tc.name + tc.arguments;
    }
  }
  return estimateTokens(text) + 10;
}

/**
 * 将消息历史划分为不可分割的「回合」单元。
 *
 * 一个回合的定义：
 * - 以一条 user 消息开头
 * - 后续连续的 assistant / tool 附属属于该回合，直到下一条 user 出现
 * - 特别地，assistant 携带 tool_calls 时，其后紧跟的若干 tool 消息必须与该 assistant 绑定
 *   （DeepSeek/OpenAI 兼容 API 要求 tool_calls 与对应的 tool 结果消息一一配对，
 *   否则返回 400 错误）。因此裁剪时不能把这对拆开。
 *
 * @returns 回合数组；每个回合是一个非空消息数组，原顺序保留
 */
function groupIntoTurns(messages: ChatMessage[]): ChatMessage[][] {
  const turns: ChatMessage[][] = [];
  let current: ChatMessage[] | null = null;

  for (const msg of messages) {
    if (msg.role === "user") {
      // 新回合开始
      if (current) turns.push(current);
      current = [msg];
    } else {
      // assistant / tool：归属当前回合；若无当前回合（历史以非 user 开头）
      // 则单独为保证不丢失而新建一个虚拟回合
      if (!current) current = [];
      current.push(msg);
    }
  }
  if (current && current.length > 0) turns.push(current);
  return turns;
}

/**
 * 估算一个回合内所有消息的总 token 数。
 */
function estimateTurnTokens(turn: ChatMessage[]): number {
  let sum = 0;
  for (const msg of turn) sum += estimateMessageTokens(msg);
  return sum;
}

/**
 * 裁剪消息历史以适应上下文窗口，保证工具调用回合不被拆散。
 *
 * 策略：
 * 1. 系统提示词始终保留，不计入裁剪范围
 * 2. 将历史按「回合」分组（user 起头 → 直到下一个 user 之前的所有 assistant/tool）
 * 3. 最近的 `preserveRecentRounds` 个回合整体强制保留
 * 4. 若保留区超限，从最前的回合整组丢弃，直到不超限
 * 5. 否则，从最近向 earliest 后填更早的整回合，装不下就停
 *
 * 关键不变量：任何含 toolCalls 的 assistant 与其后续的 tool 结果消息
 * 始终在同一回合里，裁剪不会拆开它们。
 *
 * @param messages  原始消息历史（不含 system prompt）
 * @param opts     裁剪选项
 * @returns        [裁剪后的消息数组, 是否发生了裁剪]
 */
export function trimMessages(
  messages: ChatMessage[],
  opts: TrimOptions,
): [ChatMessage[], boolean] {
  const meta = getModelMeta(opts.model);
  const maxInputTokens = meta.contextWindow - opts.reservedForOutput;

  // 系统提示词 token 估算
  const systemTokens = estimateTokens(opts.systemPrompt);
  let remaining = maxInputTokens - systemTokens;

  const turns = groupIntoTurns(messages);

  // 保留最近 N 个回合
  const preservedTurns: ChatMessage[][] = [];
  let roundsPreserved = 0;
  for (let i = turns.length - 1; i >= 0 && roundsPreserved < opts.preserveRecentRounds; i--) {
    preservedTurns.unshift(turns[i]!);
    roundsPreserved++;
  }

  const preserved: ChatMessage[] = preservedTurns.flat();
  for (const msg of preserved) {
    remaining -= estimateMessageTokens(msg);
  }

  // 保留区本身超限：从最前的回合整组丢
  if (remaining < 0) {
    while (preservedTurns.length > 1 && remaining < 0) {
      const dropped = preservedTurns.shift()!;
      remaining += estimateTurnTokens(dropped);
    }
    return [preservedTurns.flat(), true];
  }

  // 向 earliest 填更早的回合
  const olderTurns = turns.slice(0, turns.length - preservedTurns.length);
  const keptTurns: ChatMessage[][] = [];

  for (let i = olderTurns.length - 1; i >= 0; i--) {
    const cost = estimateTurnTokens(olderTurns[i]!);
    if (remaining - cost < 0) break;
    remaining -= cost;
    keptTurns.unshift(olderTurns[i]!);
  }

  const result = [...keptTurns, ...preservedTurns].flat();
  const trimmed = result.length < messages.length;
  return [result, trimmed];
}

/**
 * 构建完整的 API 请求消息数组。
 *
 * 在消息历史前面插入 system prompt，返回可直接传给 provider.chat() 的消息数组。
 */
export function buildApiMessages(
  systemPrompt: string,
  history: ChatMessage[],
): ChatMessage[] {
  return [
    { role: "system", content: systemPrompt },
    ...history,
  ];
}

/**
 * 将 Token 使用量格式化为人类可读的摘要字符串。
 */
export function formatUsageSummary(usage: UsageInfo): string {
  const prompt = usage.promptTokens.toLocaleString();
  const completion = usage.completionTokens.toLocaleString();
  const total = (usage.promptTokens + usage.completionTokens).toLocaleString();

  let summary = `📥 ${prompt} + 📤 ${completion} = 📦 ${total} tokens`;

  if (usage.cachedPromptTokens && usage.cachedPromptTokens > 0) {
    const cacheRate = ((usage.cachedPromptTokens / usage.promptTokens) * 100).toFixed(1);
    summary += ` │ 🗄️ 缓存命中 ${cacheRate}%`;
  }

  return summary;
}