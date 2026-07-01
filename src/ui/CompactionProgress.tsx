// ---------------------------------------------------------------------------
// 上下文压缩进度条组件
//
// 实时显示压缩各阶段：启动 → LLM 摘要流式生成 → 应用压缩 → 完成/兜底
// 渲染风格：左右两条竖线 + 顶/底横线包一个 Box（与 AssistantMessage 风格一致）
// ---------------------------------------------------------------------------

import { Box, Text } from "ink";
import InkSpinner from "ink-spinner";
import { useMemo } from "react";
import type { CompactionProgress } from "../agent/compactor.js";

/** 压缩的整体状态（由 ChatSession 控制） */
export type CompactionPhase =
  | "idle"
  | "running"
  | "done"
  | "error";

export interface CompactionState {
  phase: CompactionPhase;
  /** 当前累积的进度事件（最近一条） */
  progress: CompactionProgress | null;
  /** 压缩前的总 token（用于显示压缩前/后对比） */
  beforeTokens?: number;
  /** 压缩后的总 token（done 时才有） */
  afterTokens?: number;
  /** 压缩的回合数（done 时才有） */
  droppedTurns?: number;
  /** 保留的回合数（done 时才有） */
  keptTurns?: number;
  /** 错误信息（error 状态时） */
  errorMessage?: string;
  /** 实际使用的策略（done 时才有）："summary"=LLM 摘要；"fallback"=本地兜底 */
  strategy?: "summary" | "fallback";
}

interface CompactionProgressProps {
  state: CompactionState;
  /** 终端宽度（用于限制 LLM 摘要预览的换行） */
  contentWidth: number;
}

/**
 * 把"已收到字符数 / 估计目标字符数"映射成 0-100 的进度百分比。
 * 由于不知道 LLM 实际会输出多长，按 800 字符作为"典型摘要长度"做归一化。
 * 超过 800 视为 95%，剩余 5% 留给"应用压缩"阶段。
 */
export function estimateProgress(state: CompactionState): number {
  if (state.phase === "idle") return 0;
  if (state.phase === "done") return 100;
  if (state.phase === "error") return 100;

  const p = state.progress;
  if (!p) return 5;

  if (p.type === "start") {
    return 10;
  }
  if (p.type === "summary_delta") {
    // 假设摘要最终约 800 字符，按字符数估算（封顶 90%，留 5% 给 applying）
    const ratio = Math.min(p.totalSoFar.length / 800, 1);
    return Math.min(10 + ratio * 80, 90);
  }
  if (p.type === "fallback") {
    // 兜底是本地操作，瞬时完成
    return 95;
  }
  return 5;
}

/** 阶段文本（用于显示"当前在做什么"） */
export function phaseLabel(
  state: CompactionState,
): { icon: string; text: string; color: string } {
  if (state.phase === "error") {
    return { icon: "✗", text: "压缩出错", color: "#ff6347" };
  }
  if (state.phase === "done") {
    if (state.strategy === "fallback") {
      return { icon: "✔", text: "压缩完成（本地兜底）", color: "#ff9800" };
    }
    return { icon: "✔", text: "压缩完成", color: "#00ff41" };
  }
  // running
  const p = state.progress;
  if (!p) {
    return { icon: "⠋", text: "准备压缩...", color: "#00ffff" };
  }
  if (p.type === "start") {
    return { icon: "⠋", text: `准备摘要 ${p.droppedTurns} 个旧回合...`, color: "#00ffff" };
  }
  if (p.type === "summary_delta") {
    return { icon: "⠋", text: "调用 LLM 生成摘要...", color: "#00ffff" };
  }
  if (p.type === "fallback") {
    return { icon: "⚠", text: `LLM 摘要失败，使用本地兜底：${p.reason}`, color: "#ff9800" };
  }
  return { icon: "⠋", text: "压缩中...", color: "#00ffff" };
}

/**
 * 进度条渲染：固定 24 字符宽，filled + empty。
 * 颜色随阶段变化：running 青色 / done 绿色 / error 红色。
 */
function ProgressBar({ percent, color }: { percent: number; color: string }) {
  const WIDTH = 24;
  const filled = Math.round((percent / 100) * WIDTH);
  const empty = WIDTH - filled;
  return (
    <Text>
      <Text color={color}>{"█".repeat(filled)}</Text>
      <Text color="#444444">{"░".repeat(empty)}</Text>
      <Text color={color}> {percent.toFixed(0)}%</Text>
    </Text>
  );
}

/**
 * 阶段指示器：3 个小方块标识当前到哪一步。
 * [✓ 启动] → [▸ 摘要] → [· 应用]
 */
function PhaseSteps({ state }: { state: CompactionState }) {
  // 推断当前到了哪一步
  const step: 0 | 1 | 2 | 3 = (() => {
    if (state.phase === "idle") return 0;
    if (state.phase === "error") {
      const p = state.progress;
      if (p?.type === "summary_delta" || p?.type === "start") return 1;
      return 2;
    }
    if (state.phase === "done") return 3;
    // running
    const p = state.progress;
    if (!p || p.type === "start") return 0;
    if (p.type === "summary_delta") return 1;
    if (p.type === "fallback") return 2;
    return 2;
  })();

  const labels = ["启动", "LLM 摘要", "应用压缩", "完成"];
  return (
    <Box>
      {labels.map((label, i) => {
        const isCurrent = i === step;
        const isDone = i < step;
        const marker = isDone ? "✓" : isCurrent ? "▸" : "·";
        const color = isDone ? "#00ff41" : isCurrent ? "#00ffff" : "#444444";
        return (
          <Box key={label} marginRight={1}>
            <Text color={color}>
              {marker} {label}
            </Text>
            {i < labels.length - 1 && <Text color="#444444"> → </Text>}
          </Box>
        );
      })}
    </Box>
  );
}

/**
 * LLM 摘要预览：从总摘要文本中取最后 N 行（最近流式到达的内容最有信息量）。
 * 限制最大行数与每行宽度，避免在窄终端撑爆。
 */
function SummaryPreview({ text, contentWidth }: { text: string; contentWidth: number }) {
  const MAX_LINES = 4;
  const MAX_LINE_WIDTH = Math.max(contentWidth - 6, 20);
  if (!text) {
    return <Text dimColor>{"  (等待 LLM 输出...)"}</Text>;
  }
  // 按宽度硬切（仅在空白处切，保留中文）
  const lines = wrapByWidth(text, MAX_LINE_WIDTH);
  const kept = lines.slice(-MAX_LINES);
  return (
    <Box flexDirection="column">
      {kept.map((line, i) => (
        <Text key={i} dimColor>
          {"  "}
          {line}
        </Text>
      ))}
    </Box>
  );
}

/**
 * 简易按宽度折行：中文按宽度 2、其他按 1 计算。
 * 先按显式 \n 拆分；每段内如果超出 maxWidth 就折行。
 */
export function wrapByWidth(text: string, maxWidth: number): string[] {
  if (text === "") return [];
  if (maxWidth <= 0) return [text];
  const result: string[] = [];
  for (const para of text.split("\n")) {
    if (para.length === 0) {
      result.push("");
      continue;
    }
    let buf = "";
    let bufWidth = 0;
    for (const ch of para) {
      // CJK 字符按宽度 2 计：Unicode 范围覆盖汉字 / 平假名 / 全角
      const cp = ch.codePointAt(0)!;
      const w = cp > 0x2E80 ? 2 : 1;
      if (bufWidth + w > maxWidth && buf.length > 0) {
        result.push(buf);
        buf = ch;
        bufWidth = w;
      } else {
        buf += ch;
        bufWidth += w;
      }
    }
    if (buf.length > 0) result.push(buf);
  }
  return result;
}

/** 数字千分位 */
function fmtNum(n: number): string {
  return n.toLocaleString();
}

/**
 * CompactionProgress — 压缩过程实时可视化组件。
 *
 * 受控组件：ChatSession 持有 CompactionState，调用 compactor 的 onProgress 回调
 * 把事件累积进 state，组件根据 state 直接渲染。
 *
 * 渲染时机：当 state.phase !== "idle" 时才显示（由 ChatSession 包裹条件渲染）。
 */
export function CompactionProgress({ state, contentWidth }: CompactionProgressProps) {
  const percent = useMemo(() => estimateProgress(state), [state]);
  const phase = useMemo(() => phaseLabel(state), [state]);

  // 摘要文本来源
  const summaryText =
    state.progress?.type === "summary_delta"
      ? state.progress.totalSoFar
      : state.progress?.type === "fallback"
        ? state.progress.fallbackSummary
        : state.phase === "done" && state.strategy === "summary"
          ? ""
          : "";

  // done 状态时若没有 summary_delta 的累积，用最终结构展示
  const finalSummary =
    state.phase === "done" && state.strategy === "summary"
      ? (state.progress?.type === "summary_delta" ? state.progress.totalSoFar : "")
      : summaryText;

  // 主标题颜色
  const titleColor = state.phase === "error" ? "#ff6347" : "#00ffff";

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row">
        {/* 左侧竖线 — 紫色（与压缩主题匹配） */}
        <Box width={1} backgroundColor="#9b59b6" flexShrink={0} />
        <Box flexGrow={1} paddingLeft={1} flexDirection="column">
          {/* 标题行 */}
          <Box>
            <Text bold color={titleColor}>
              🗜  上下文压缩
            </Text>
            <Box flexGrow={1} />
            {state.phase === "running" && (
              <Text color={phase.color}>
                <InkSpinner type="dots" /> {phase.text}
              </Text>
            )}
            {state.phase === "done" && (
              <Text color={phase.color}>
                {phase.icon} {phase.text}
              </Text>
            )}
            {state.phase === "error" && (
              <Text color={phase.color}>
                {phase.icon} {phase.text}
              </Text>
            )}
          </Box>

          {/* 进度条 */}
          <Box marginTop={1}>
            <Text color="#808080">{"进度: "}</Text>
            <ProgressBar percent={percent} color={state.phase === "error" ? "#ff6347" : phase.color} />
          </Box>

          {/* 阶段指示器 */}
          <Box marginTop={1}>
            <PhaseSteps state={state} />
          </Box>

          {/* 关键指标 */}
          {(state.beforeTokens !== undefined || state.droppedTurns !== undefined) && (
            <Box marginTop={1} flexDirection="column">
              {state.droppedTurns !== undefined && (
                <Text color="#00ff41">
                  {"📊 回合: "}
                  {state.droppedTurns}
                  {" 折叠 → "}
                  {state.keptTurns ?? 0}
                  {" 保留"}
                </Text>
              )}
              {state.beforeTokens !== undefined && (
                <Text color="#ff9800">
                  {"📦 token: "}
                  {fmtNum(state.beforeTokens)}
                  {state.afterTokens !== undefined && (
                    <>
                      {" → "}
                      <Text color="#00ff41" bold>
                        {fmtNum(state.afterTokens)}
                      </Text>
                      <Text color="#808080">
                        {" (节省 "}
                        {(
                          ((state.beforeTokens - state.afterTokens) /
                            Math.max(state.beforeTokens, 1)) *
                          100
                        ).toFixed(1)}
                        {"%)"}
                      </Text>
                    </>
                  )}
                </Text>
              )}
            </Box>
          )}

          {/* LLM 摘要预览 */}
          {(state.phase === "running" || state.phase === "done") &&
            finalSummary && (
              <Box marginTop={1} flexDirection="column">
                <Text color="#808080">{"┄┄┄ LLM 摘要预览 ┄┄┄"}</Text>
                <SummaryPreview text={finalSummary} contentWidth={contentWidth} />
              </Box>
            )}

          {/* 兜底原因（兜底时显示） */}
          {state.phase === "done" && state.strategy === "fallback" && (
            <Box marginTop={1}>
              <Text color="#ff9800">
                {"⚠ LLM 摘要失败，使用本地兜底摘要。压缩已生效但摘要质量较低。"}
              </Text>
            </Box>
          )}

          {/* 错误信息 */}
          {state.phase === "error" && state.errorMessage && (
            <Box marginTop={1}>
              <Text color="#ff6347">{"⚠ "}{state.errorMessage}</Text>
            </Box>
          )}
        </Box>
      </Box>
    </Box>
  );
}
