// ---------------------------------------------------------------------------
// 助手消息组件 — 渲染单条 assistant 回复（流式文本 + 工具调用 + 成本行）
// ---------------------------------------------------------------------------

import { Box, Text } from "ink";
import type { ProviderToolCall, UsageInfo } from "../provider/index.js";
import { formatMoney, formatCallCostLine } from "../provider/cost-tracker.js";
import { ToolCallBlock } from "./ToolCallBlock.js";
import { formatUsageSummary } from "../agent/message-builder.js";

interface AssistantMessageProps {
  /** 助手回复的文本内容 */
  content: string;
  /** 工具调用列表 */
  toolCalls?: ProviderToolCall[];
  /** 是否正在流式输出中 */
  isStreaming?: boolean;
  /** Token 使用统计 */
  usage?: UsageInfo;
  /** 本次调用耗时（毫秒） */
  elapsed?: number;
  /** 本次调用费用 */
  cost?: number;
  /** 使用的模型标识 */
  model?: string;
}

/** 格式化毫秒为人类可读的时间 */
function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = (ms / 1000).toFixed(1);
  return `${seconds}s`;
}

/**
 * 渲染单条助手回复。
 *
 * 显示结构：
 *   🤖 流式文本内容...
 *     📦 tool_name ────
 *        参数摘要
 *        ⏳ 等待执行
 *   ────────────────────────────
 *   💰 本次 ¥0.0012 │ 🕐 3.2s │ 📦 1.2k tokens
 */
export function AssistantMessage({
  content,
  toolCalls,
  isStreaming = false,
  usage,
  elapsed,
  cost,
  model,
}: AssistantMessageProps) {
  // 内容为空且无工具调用时不渲染
  if (!content && (!toolCalls || toolCalls.length === 0) && !isStreaming) {
    return null;
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      {/* 助手标识 + 内容 */}
      <Box flexDirection="row">
        <Box width={4} flexShrink={0}>
          <Text bold color="#ff00ff">{"🤖"}</Text>
        </Box>
        <Box flexGrow={1} flexDirection="column">
          {/* 文本内容 */}
          {content && (
            <Text wrap="wrap">{content}</Text>
          )}
          {/* 流式输出时的光标 */}
          {isStreaming && !content && (
            <Text color="#888888">...</Text>
          )}
        </Box>
      </Box>

      {/* 工具调用 */}
      {toolCalls && toolCalls.length > 0 && (
        <Box flexDirection="column">
          {toolCalls.map((tc, i) => (
            <ToolCallBlock key={tc.id ?? i} call={tc} />
          ))}
        </Box>
      )}

      {/* 成本/耗时摘要行（仅在流式结束后显示） */}
      {!isStreaming && (usage || elapsed !== undefined) && (
        <Box flexDirection="column" marginTop={1} marginLeft={3}>
          <Text color="#555555">{"─".repeat(36)}</Text>
          <Box flexDirection="row" gap={2}>
            {cost !== undefined && cost > 0 && (
              <Text color="yellow">
                💰 本次 {formatMoney(cost)}
              </Text>
            )}
            {elapsed !== undefined && (
              <Text color="cyan">
                🕐 {formatElapsed(elapsed)}
              </Text>
            )}
            {usage && (
              <Text color="#888888">
                {formatUsageSummary(usage)}
              </Text>
            )}
          </Box>
        </Box>
      )}
    </Box>
  );
}