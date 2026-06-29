// ---------------------------------------------------------------------------
// 思考链工具函数测试
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  joinReasoningSegments,
  truncateReasoningLines,
  DEFAULT_REASONING_MAX_LINES,
} from "../../src/ui/reasoning-utils.js";

describe("joinReasoningSegments", () => {
  it("多段之间用空行分隔", () => {
    expect(joinReasoningSegments(["第一段", "第二段"])).toBe("第一段\n\n第二段");
  });

  it("过滤掉空白段（防止双空行）", () => {
    expect(joinReasoningSegments(["a", "", "  ", "b"])).toBe("a\n\nb");
  });

  it("trim 每段的首尾空白", () => {
    expect(joinReasoningSegments(["  hello  ", "world  "])).toBe("hello\n\nworld");
  });

  it("空数组返回空串", () => {
    expect(joinReasoningSegments([])).toBe("");
  });

  it("全空白数组返回空串", () => {
    expect(joinReasoningSegments(["", "  ", "\n"])).toBe("");
  });
});

describe("truncateReasoningLines", () => {
  it("行数未超限时原样返回", () => {
    const r = truncateReasoningLines("a\nb\nc", 6);
    expect(r.visible).toBe("a\nb\nc");
    expect(r.hiddenLines).toBe(0);
    expect(r.totalLines).toBe(3);
  });

  it("行数刚好等于上限时也原样返回", () => {
    const text = Array.from({ length: 6 }, (_, i) => `line${i + 1}`).join("\n");
    const r = truncateReasoningLines(text, 6);
    expect(r.visible).toBe(text);
    expect(r.hiddenLines).toBe(0);
  });

  it("行数超过上限时只保留前 N 行", () => {
    const text = Array.from({ length: 12 }, (_, i) => `line${i + 1}`).join("\n");
    const r = truncateReasoningLines(text, 6);
    expect(r.visible).toBe("line1\nline2\nline3\nline4\nline5\nline6");
    expect(r.hiddenLines).toBe(6);
    expect(r.totalLines).toBe(12);
  });

  it("空字符串视为 1 行（不截断）", () => {
    const r = truncateReasoningLines("", 6);
    expect(r.visible).toBe("");
    expect(r.hiddenLines).toBe(0);
    expect(r.totalLines).toBe(1);
  });

  it("默认上限为 8 行", () => {
    expect(DEFAULT_REASONING_MAX_LINES).toBe(8);
  });
});
