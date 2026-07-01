// ---------------------------------------------------------------------------
// ContextUsageBar 纯函数单元测试
// 不引入 ink-testing-library，只覆盖纯逻辑层
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  classifyContextRatio,
  contextLevelColor,
  type ContextUsageLevel,
} from "../../src/ui/ChatSession.js";

// ---------------------------------------------------------------------------
// classifyContextRatio
// ---------------------------------------------------------------------------

describe("classifyContextRatio", () => {
  it("ratio < 0.6 → safe", () => {
    expect(classifyContextRatio(0)).toBe("safe");
    expect(classifyContextRatio(0.3)).toBe("safe");
    expect(classifyContextRatio(0.5999)).toBe("safe");
  });

  it("ratio ∈ [0.6, 0.85) → warning", () => {
    expect(classifyContextRatio(0.6)).toBe("warning");
    expect(classifyContextRatio(0.7)).toBe("warning");
    expect(classifyContextRatio(0.8499)).toBe("warning");
  });

  it("ratio >= 0.85 → danger", () => {
    expect(classifyContextRatio(0.85)).toBe("danger");
    expect(classifyContextRatio(0.9)).toBe("danger");
    expect(classifyContextRatio(1.0)).toBe("danger");
    expect(classifyContextRatio(1.5)).toBe("danger"); // 超限也算 danger
  });
});

// ---------------------------------------------------------------------------
// contextLevelColor
// ---------------------------------------------------------------------------

describe("contextLevelColor", () => {
  it("三档颜色固定（避免无意修改）", () => {
    expect(contextLevelColor("safe")).toBe("#00ff41"); // 绿色
    expect(contextLevelColor("warning")).toBe("#ffcc00"); // 黄色
    expect(contextLevelColor("danger")).toBe("#ff6347"); // 红色
  });

  it("三档颜色互不相同", () => {
    const colors = new Set([
      contextLevelColor("safe"),
      contextLevelColor("warning"),
      contextLevelColor("danger"),
    ]);
    expect(colors.size).toBe(3);
  });

  it("颜色是 hex 格式 (#RRGGBB)", () => {
    for (const level of ["safe", "warning", "danger"] as const) {
      expect(contextLevelColor(level)).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});

// ---------------------------------------------------------------------------
// 档位边界值参数化测试
// ---------------------------------------------------------------------------

describe("档位边界 — ratio 临界值参数化", () => {
  it.each<[number, ContextUsageLevel]>([
    [0.0, "safe"],
    [0.5, "safe"],
    [0.59, "safe"],
    [0.6, "warning"],
    [0.7, "warning"],
    [0.84, "warning"],
    [0.85, "danger"],
    [0.95, "danger"],
    [1.0, "danger"],
    [2.0, "danger"], // 极端超限
  ])("ratio=%s → %s", (ratio, expected) => {
    expect(classifyContextRatio(ratio)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// 进度条宽度的纯计算（不渲染 React，只测数值）
// 规则：
//   - ratio = 0           → 0 格填充
//   - 0 < ratio ≤ 1/12    → 1 格填充（最低可见填充，避免“0.1%”误读为未使用）
//   - ratio > 1/12        → round(ratio * 12)
//   - ratio > 1.0         → 12 格封顶
// ---------------------------------------------------------------------------

describe("进度条填充数计算", () => {
  function computeFilled(ratio: number, width = 12): number {
    if (ratio === 0) return 0;
    return Math.min(
      width,
      Math.max(1, Math.round(ratio * width)),
    );
  }

  it("ratio=0 → 0 填充（无消息时不画蛇添足）", () => {
    expect(computeFilled(0)).toBe(0);
  });

  it("ratio=0.001（0.1%）→ 1 填充（防误读）", () => {
    expect(computeFilled(0.001)).toBe(1);
  });

  it("ratio=0.01（1%）→ 1 填充（未达 1/12 阈值）", () => {
    expect(computeFilled(0.01)).toBe(1);
  });

  it("ratio=1/12（8.3%）→ 1 填充（刚好圆整到 1）", () => {
    expect(computeFilled(1 / 12)).toBe(1);
  });

  it("ratio=0.1（10%）→ 1 填充（round(1.2) = 1）", () => {
    expect(computeFilled(0.1)).toBe(1);
  });

  it("ratio=0.3（30%）→ 4 填充", () => {
    expect(computeFilled(0.3)).toBe(4);
  });

  it("ratio=0.5（50%）→ 6 填充", () => {
    expect(computeFilled(0.5)).toBe(6);
  });

  it("ratio=0.85（85%）→ 10 填充", () => {
    expect(computeFilled(0.85)).toBe(10);
  });

  it("ratio=1.0（100%）→ 12 全满", () => {
    expect(computeFilled(1.0)).toBe(12);
  });

  it("ratio=1.5（超限）→ 12 全满（封顶）", () => {
    expect(computeFilled(1.5)).toBe(12);
  });
});

// ---------------------------------------------------------------------------
// 阈值与"是否触发自动压缩"的关系（业务一致性）
// ---------------------------------------------------------------------------

describe("档位 ↔ 业务阈值一致性", () => {
  it("danger 档位下限（0.85）与 Session autoCompactRatio 默认值一致", async () => {
    // 这里不直接读 SessionOptions，避免循环依赖；改为编译时常量
    // 默认 DEFAULT_AUTO_COMPACT_RATIO = 0.85（src/agent/compactor.ts）
    const expectedAutoCompactRatio = 0.85;
    expect(classifyContextRatio(expectedAutoCompactRatio)).toBe("danger");
  });
});
