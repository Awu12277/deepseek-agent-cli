// ---------------------------------------------------------------------------
// CompactionProgress 组件的纯函数单元测试
// (不引入 ink-testing-library；仅测试组件内可导出的纯逻辑)
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  estimateProgress,
  phaseLabel,
  wrapByWidth,
  type CompactionState,
} from "../../src/ui/CompactionProgress.js";

function makeState(overrides: Partial<CompactionState> = {}): CompactionState {
  return {
    phase: "idle",
    progress: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// estimateProgress
// ---------------------------------------------------------------------------

describe("estimateProgress", () => {
  it("idle 状态返回 0", () => {
    expect(estimateProgress(makeState({ phase: "idle" }))).toBe(0);
  });

  it("running 无 progress 返回 5 (起步前)", () => {
    expect(estimateProgress(makeState({ phase: "running" }))).toBe(5);
  });

  it("running + start 事件返回 10", () => {
    const state = makeState({
      phase: "running",
      progress: { type: "start", droppedTurns: 14, beforeTokens: 1000 },
    });
    expect(estimateProgress(state)).toBe(10);
  });

  it("running + summary_delta 短摘要按字符数增长", () => {
    const state = makeState({
      phase: "running",
      progress: { type: "summary_delta", delta: "x".repeat(400), totalSoFar: "x".repeat(400) },
    });
    // 400 / 800 = 0.5 → 10 + 0.5 * 80 = 50
    expect(estimateProgress(state)).toBe(50);
  });

  it("running + summary_delta 超过 800 字符封顶 90", () => {
    const state = makeState({
      phase: "running",
      progress: { type: "summary_delta", delta: "x", totalSoFar: "x".repeat(2000) },
    });
    expect(estimateProgress(state)).toBe(90);
  });

  it("running + fallback 事件返回 95", () => {
    const state = makeState({
      phase: "running",
      progress: {
        type: "fallback",
        reason: "err",
        fallbackSummary: "本地摘要",
      },
    });
    expect(estimateProgress(state)).toBe(95);
  });

  it("done 状态返回 100", () => {
    expect(estimateProgress(makeState({ phase: "done" }))).toBe(100);
  });

  it("error 状态返回 100 (已经到底)", () => {
    expect(estimateProgress(makeState({ phase: "error" }))).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// phaseLabel
// ---------------------------------------------------------------------------

describe("phaseLabel", () => {
  it("idle: 返回 '准备压缩' 之类文本", () => {
    const label = phaseLabel(makeState({ phase: "idle" }));
    expect(label.color).toBeTruthy();
    expect(label.text.length).toBeGreaterThan(0);
  });

  it("running 无 progress: 准备压缩...", () => {
    const label = phaseLabel(makeState({ phase: "running" }));
    expect(label.text).toContain("准备");
  });

  it("running + start 事件: 包含回合数", () => {
    const state = makeState({
      phase: "running",
      progress: { type: "start", droppedTurns: 14, beforeTokens: 1000 },
    });
    const label = phaseLabel(state);
    expect(label.text).toContain("14");
    expect(label.text).toContain("回合");
  });

  it("running + summary_delta: 显示 LLM 摘要中", () => {
    const state = makeState({
      phase: "running",
      progress: { type: "summary_delta", delta: "x", totalSoFar: "x" },
    });
    const label = phaseLabel(state);
    expect(label.text).toContain("LLM");
    expect(label.text).toContain("摘要");
  });

  it("running + fallback: 包含 reason 文本", () => {
    const state = makeState({
      phase: "running",
      progress: { type: "fallback", reason: "网络断了", fallbackSummary: "x" },
    });
    const label = phaseLabel(state);
    expect(label.text).toContain("网络断了");
    expect(label.text).toContain("兜底");
  });

  it("done + summary 策略: 绿色 '压缩完成'", () => {
    const label = phaseLabel(makeState({ phase: "done", strategy: "summary" }));
    expect(label.text).toContain("压缩完成");
    expect(label.text).not.toContain("兜底");
    expect(label.color).toBe("#00ff41");
  });

  it("done + fallback 策略: 橙色 '本地兜底'", () => {
    const label = phaseLabel(makeState({ phase: "done", strategy: "fallback" }));
    expect(label.text).toContain("兜底");
    expect(label.color).toBe("#ff9800");
  });

  it("error: 红色 '压缩出错'", () => {
    const label = phaseLabel(makeState({ phase: "error" }));
    expect(label.text).toContain("出错");
    expect(label.color).toBe("#ff6347");
  });
});

// ---------------------------------------------------------------------------
// wrapByWidth
// ---------------------------------------------------------------------------

describe("wrapByWidth", () => {
  it("空字符串返回空数组", () => {
    expect(wrapByWidth("", 20)).toEqual([]);
  });

  it("单行长度小于 maxWidth 不切", () => {
    expect(wrapByWidth("hello", 20)).toEqual(["hello"]);
  });

  it("单行长度大于 maxWidth 时切行", () => {
    const result = wrapByWidth("abcdefghij", 5);
    expect(result).toEqual(["abcde", "fghij"]);
  });

  it("保留显式 \\n", () => {
    const result = wrapByWidth("abc\ndef", 20);
    expect(result).toEqual(["abc", "def"]);
  });

  it("多个显式 \\n 之间保留空行", () => {
    const result = wrapByWidth("a\n\nb", 20);
    expect(result).toEqual(["a", "", "b"]);
  });

  it("CJK 字符按宽度算(每个占 2)", () => {
    // 5 个汉字 → 宽度 10，刚好等于 maxWidth=10，不切
    expect(wrapByWidth("你好世界你", 10)).toEqual(["你好世界你"]);
  });

  it("CJK 超长时按宽度切", () => {
    // 8 个汉字 → 宽度 16，超 maxWidth=10
    const result = wrapByWidth("一二三四五六七八", 10);
    // 第一行 "一二三四五" (宽 10)，第二行 "六七八" (宽 6)
    expect(result).toEqual(["一二三四五", "六七八"]);
  });
});

// ---------------------------------------------------------------------------
// CompactionState 形状校验（保证组件与 ChatSession 之间的契约稳定）
// ---------------------------------------------------------------------------

describe("CompactionState 契约", () => {
  it("done 状态下必须有 droppedTurns / keptTurns / beforeTokens / afterTokens / strategy", () => {
    // 这是约定：ChatSession 在收到 done 事件后必须填齐这些字段
    const state: CompactionState = {
      phase: "done",
      progress: { type: "done", droppedTurns: 14, keptTurns: 6, beforeTokens: 5000, afterTokens: 800 },
      droppedTurns: 14,
      keptTurns: 6,
      beforeTokens: 5000,
      afterTokens: 800,
      strategy: "summary",
    };
    expect(state.phase).toBe("done");
    expect(state.droppedTurns).toBe(14);
    expect(state.keptTurns).toBe(6);
    expect(state.strategy).toBe("summary");
  });
});
