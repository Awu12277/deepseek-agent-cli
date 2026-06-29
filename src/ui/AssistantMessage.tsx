// ---------------------------------------------------------------------------
// 助手消息组件 — 渲染单条 assistant 回复（流式文本 + 工具调用 + 成本行）
// ---------------------------------------------------------------------------

import { Box, Text } from "ink";
import { useEffect, useRef, useState } from "react";
import type { ProviderToolCall, UsageInfo } from "../provider/index.js";
import { formatMoney } from "../provider/cost-tracker.js";
import { ToolCallBlock } from "./ToolCallBlock.js";
import { formatUsageSummary } from "../agent/message-builder.js";
import { HighlightedText } from "./HighlightedText.js";
import {
  DEFAULT_REASONING_MAX_LINES,
  joinReasoningSegments,
  truncateReasoningLines,
} from "./reasoning-utils.js";

interface AssistantMessageProps {
  /** 助手回复的文本内容 */
  content: string;
  /**
   * 思考链段列表（thinking 模式的 CoT），可选。
   * 一个回合可能包含多段 CoT（多轮“思考→调工具”），每段独立成块展示。
   */
  reasoning?: string[];
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
 * 平滑动画的实时消耗行。
 *
 * props 中的 token/cost 是“目标值”，组件内部以 33ms (~30fps) 步进
 * 用 easeOutCubic 缓动插值，避免上游 300ms 节流推送造成的跳变感。
 * 当 target ≤ displayed 时直接跳到目标（支持估算/真实值互相覆盖）。
 */
function AnimatedUsage({ usage, cost }: { usage?: UsageInfo; cost?: number }) {
  const targetTokens = usage ? usage.promptTokens + usage.completionTokens : 0;
  const targetCost = cost ?? 0;

  // 初次进入时直接定位到首帧，避免从 0 长动画
  const [displayedTokens, setDisplayedTokens] = useState(targetTokens);
  const [displayedCost, setDisplayedCost] = useState(targetCost);

  // 记录“上次起点”，动画以该起点为 0% 位置，趋近 targetTokens / targetCost
  const startRef = useRef<{
    fromTokens: number;
    fromCost: number;
    toTokens: number;
    toCost: number;
    startMs: number;
    durationMs: number;
  } | null>(null);
  const rafRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    // 目标值不变时跳过
    if (
      startRef.current &&
      startRef.current.toTokens === targetTokens &&
      startRef.current.toCost === targetCost
    ) {
      return;
    }

    // 目标值 ≤ 当前显示值（例：真实 usage 覆盖估算值，且可能偏低）
    // 或首次进入 → 直接跳到目标
    if (targetTokens <= displayedTokens && targetCost <= displayedCost) {
      setDisplayedTokens(targetTokens);
      setDisplayedCost(targetCost);
      startRef.current = {
        fromTokens: targetTokens,
        fromCost: targetCost,
        toTokens: targetTokens,
        toCost: targetCost,
        startMs: Date.now(),
        durationMs: 0,
      };
      return;
    }

    // 按变化量粗略估算动画时长：300ms 节流周期 + 少许渐变
    const tokensDelta = targetTokens - displayedTokens;
    const costDelta = targetCost - displayedCost;
    const durationMs = Math.min(600, Math.max(220, Math.max(tokensDelta, 0) * 1.2 + 220));
    startRef.current = {
      fromTokens: displayedTokens,
      fromCost: displayedCost,
      toTokens: targetTokens,
      toCost: targetCost,
      startMs: Date.now(),
      durationMs,
    };

    if (rafRef.current) clearInterval(rafRef.current);
    rafRef.current = setInterval(() => {
      const s = startRef.current;
      if (!s) return;
      const elapsed = Date.now() - s.startMs;
      if (elapsed >= s.durationMs) {
        setDisplayedTokens(s.toTokens);
        setDisplayedCost(s.toCost);
        if (rafRef.current) {
          clearInterval(rafRef.current);
          rafRef.current = null;
        }
        return;
      }
      // easeOutCubic：1 - (1 - t)^3
      const t = elapsed / s.durationMs;
      const eased = 1 - Math.pow(1 - t, 3);
      const tokens = s.fromTokens + (s.toTokens - s.fromTokens) * eased;
      const cost = s.fromCost + (s.toCost - s.fromCost) * eased;
      setDisplayedTokens(tokens);
      setDisplayedCost(cost);
    }, 33);

    return () => {
      if (rafRef.current) {
        clearInterval(rafRef.current);
        rafRef.current = null;
      }
    };
    // 只在目标值变化时重启动画，不依赖 displayedX
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetTokens, targetCost]);

  return (
    <>
      {usage && (
        <Text color="#888888">{Math.round(displayedTokens).toLocaleString()} tokens</Text>
      )}
      {cost !== undefined && cost > 0 && (
        <Text color="#888888">
          {" · "}¥{displayedCost.toFixed(4)}
        </Text>
      )}
    </>
  );
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
  reasoning,
  toolCalls,
  isStreaming = false,
  usage,
  elapsed,
  cost,
  model: _model,
}: AssistantMessageProps) {
  // 内容为空且无工具调用且无思考链时不渲染
  if (
    !content &&
    (!toolCalls || toolCalls.length === 0) &&
    (!reasoning || reasoning.length === 0) &&
    !isStreaming
  ) {
    return null;
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      {/* 思考链：所有段拼接为单文本（段间空行分隔），统一截断到 8 行。
          多 sub-turn 的短段不再各自画框，避免空块堆点屏幕。 */}
      {reasoning &&
        reasoning.length > 0 &&
        (() => {
          const merged = joinReasoningSegments(reasoning);
          if (!merged) return null;
          const { visible, hiddenLines } = truncateReasoningLines(
            merged,
            DEFAULT_REASONING_MAX_LINES,
          );
          return (
            <Box flexDirection="row" marginBottom={1}>
              <Box width={4} flexShrink={0}>
                <Text dimColor>{"🧠"}</Text>
              </Box>
              <Box
                flexGrow={1}
                flexDirection="column"
                borderStyle="single"
                borderColor="#444444"
                paddingLeft={1}
                paddingRight={1}
              >
                <Text dimColor wrap="wrap">
                  {visible}
                </Text>
                {hiddenLines > 0 && (
                  <Text dimColor>
                    {"\n… (共 "}
                    {hiddenLines + DEFAULT_REASONING_MAX_LINES}
                    {" 行，已省略 "}
                    {hiddenLines}
                    {" 行)"}
                  </Text>
                )}
              </Box>
            </Box>
          );
        })()}

      {/* 助手标识 + 内容 */}
      <Box flexDirection="row">
        <Box width={4} flexShrink={0}>
          <Text bold color="#ff00ff">
            {"🤖"}
          </Text>
        </Box>
        <Box flexGrow={1} flexDirection="column">
          {/* 文本内容（带语法高亮） */}
          {content && <HighlightedText>{content}</HighlightedText>}
          {/* 流式输出时的光标 */}
          {isStreaming && !content && (!reasoning || reasoning.length === 0) && (
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

      {/* 流式输出中的实时消耗（带平滑动画） */}
      {isStreaming && (usage || cost !== undefined) && (
        <Box flexDirection="row" marginTop={1} marginLeft={3}>
          <Text color="#666666" dimColor>
            ⏳ 已消耗 <AnimatedUsage usage={usage} cost={cost} />
          </Text>
        </Box>
      )}

      {/* 成本/耗时摘要行（仅在流式结束后显示） */}
      {!isStreaming && (usage || elapsed !== undefined) && (
        <Box flexDirection="column" marginTop={1} marginLeft={3}>
          <Text color="#555555">{"─".repeat(36)}</Text>
          <Box flexDirection="row" gap={2}>
            {cost !== undefined && cost > 0 && (
              <Text color="yellow">💰 本次 {formatMoney(cost)}</Text>
            )}
            {elapsed !== undefined && (
              <Text color="cyan">🕐 {formatElapsed(elapsed)}</Text>
            )}
            {usage && <Text color="#888888">{formatUsageSummary(usage)}</Text>}
          </Box>
        </Box>
      )}
    </Box>
  );
}
