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
 * 裁剪消息历史以适应上下文窗口。
 *
 * 策略：
 * 1. 系统提示词始终保留，不计入裁剪范围
 * 2. 最近的 `preserveRecentRounds` 轮对话（1 轮 = 1 user + 1 assistant）强制保留
 * 3. 较早的消息从最老的开始裁剪，直到总 token 数不超出窗口
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

  // 保留最近 N 轮（每轮 = user + assistant，或含 tool 消息的轮次）
  const preserved: ChatMessage[] = [];
  let roundsPreserved = 0;
  for (let i = messages.length - 1; i >= 0 && roundsPreserved < opts.preserveRecentRounds; i--) {
    preserved.unshift(messages[i]!);
    if (messages[i]!.role === "user") {
      roundsPreserved++;
    }
  }

  // 保证保留的消息不超限
  for (const msg of preserved) {
    remaining -= estimateMessageTokens(msg);
  }

  // 如果保留区本身已超限，从前面继续裁剪
  if (remaining < 0) {
    while (preserved.length > 1 && remaining < 0) {
      const removed = preserved.shift()!;
      remaining += estimateMessageTokens(removed);
    }
    return [preserved, true];
  }

  // 尝试填入更早的消息
  const olderMessages = messages.slice(0, messages.length - preserved.length);
  const kept: ChatMessage[] = [];

  for (let i = olderMessages.length - 1; i >= 0; i--) {
    const cost = estimateMessageTokens(olderMessages[i]!);
    if (remaining - cost < 0) break;
    remaining -= cost;
    kept.unshift(olderMessages[i]!);
  }

  const result = [...kept, ...preserved];
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