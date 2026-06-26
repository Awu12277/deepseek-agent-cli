import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CostTracker,
  formatMoney,
  formatTokens,
  formatCacheHitRate,
  formatTodayReport,
  formatSessionCostLine,
  formatCallCostLine,
} from "../src/provider/cost-tracker.js";
import type { DailyCostSummary, CostRecord } from "../src/provider/cost-tracker.js";
import type { UsageInfo } from "../src/provider/types.js";

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

/** 创建一个简单的 UsageInfo */
function makeUsage(opts: Partial<UsageInfo> = {}): UsageInfo {
  return {
    promptTokens: opts.promptTokens ?? 1000,
    completionTokens: opts.completionTokens ?? 500,
    cachedPromptTokens: opts.cachedPromptTokens,
  };
}



// ---------------------------------------------------------------------------
// CostTracker 核心功能
// ---------------------------------------------------------------------------

describe("CostTracker", () => {
  let tracker: CostTracker;
  let tmpDir: string;

  beforeEach(async () => {
    // 用 os.tmpdir() + 随机后缀，避免硬编码 /tmp（Windows 兼容）也避免跨测试污染
    tmpDir = await mkdtemp(join(tmpdir(), "dskcode-costs-"));
    tracker = new CostTracker({ costDir: tmpDir });
  });

  afterEach(async () => {
    try { await rm(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  describe("record — 记录单次调用成本", () => {
    it("应正确记录 flash 模型无缓存命中的成本", () => {
      const usage = makeUsage({ promptTokens: 1000, completionTokens: 500 });
      const cost = tracker.record(usage, "deepseek-v4-flash");

      // flash: input ¥1/M, output ¥2/M
      // inputCost = 1000 * 1 / 1_000_000 = 0.001
      // outputCost = 500 * 2 / 1_000_000 = 0.001
      // totalCost = 0.002
      expect(cost.inputCost).toBeCloseTo(0.001, 6);
      expect(cost.outputCost).toBeCloseTo(0.001, 6);
      expect(cost.cacheHitCost).toBe(0);
      expect(cost.totalCost).toBeCloseTo(0.002, 6);
    });

    it("应正确记录有缓存命中的成本", () => {
      const usage = makeUsage({
        promptTokens: 2000,
        completionTokens: 1000,
        cachedPromptTokens: 1500,
      });
      const cost = tracker.record(usage, "deepseek-v4-flash");

      // flash: input ¥1/M, cacheHit ¥0.02/M, output ¥2/M
      // nonCached = 2000 - 1500 = 500
      // inputCost = 500 * 1 / 1_000_000 = 0.0005
      // cacheHitCost = 1500 * 0.02 / 1_000_000 = 0.00003
      // outputCost = 1000 * 2 / 1_000_000 = 0.002
      expect(cost.inputCost).toBeCloseTo(0.0005, 8);
      expect(cost.cacheHitCost).toBeCloseTo(0.00003, 8);
      expect(cost.outputCost).toBeCloseTo(0.002, 6);
    });

    it("应正确记录 pro 模型的成本", () => {
      const usage = makeUsage({ promptTokens: 3000, completionTokens: 2000 });
      const cost = tracker.record(usage, "deepseek-v4-pro");

      // pro: input ¥3/M, output ¥6/M
      // inputCost = 3000 * 3 / 1_000_000 = 0.009
      // outputCost = 2000 * 6 / 1_000_000 = 0.012
      expect(cost.inputCost).toBeCloseTo(0.009, 6);
      expect(cost.outputCost).toBeCloseTo(0.012, 6);
      expect(cost.totalCost).toBeCloseTo(0.021, 6);
    });
  });

  describe("会话级统计", () => {
    it("应正确累加多次调用的成本", () => {
      tracker.record(makeUsage({ promptTokens: 1000, completionTokens: 500 }), "deepseek-v4-flash");
      tracker.record(makeUsage({ promptTokens: 2000, completionTokens: 1000 }), "deepseek-v4-flash");
      tracker.record(makeUsage({ promptTokens: 500, completionTokens: 300 }), "deepseek-v4-flash");

      const summary = tracker.sessionSummary;
      expect(summary.totalPromptTokens).toBe(3500);
      expect(summary.totalCompletionTokens).toBe(1800);
      expect(summary.records.length).toBe(3);
    });

    it("should track total cost correctly", () => {
      tracker.record(makeUsage({ promptTokens: 1000, completionTokens: 500 }), "deepseek-v4-flash");
      tracker.record(makeUsage({ promptTokens: 1000, completionTokens: 500 }), "deepseek-v4-flash");

      // 每次 ≈ 0.002，两次 ≈ 0.004
      expect(tracker.sessionTotalCost).toBeCloseTo(0.004, 6);
    });

    it("should track call count", () => {
      expect(tracker.sessionCallCount).toBe(0);
      tracker.record(makeUsage(), "deepseek-v4-flash");
      tracker.record(makeUsage(), "deepseek-v4-flash");
      tracker.record(makeUsage(), "deepseek-v4-flash");
      expect(tracker.sessionCallCount).toBe(3);
    });

    it("resetSession should clear session stats", () => {
      tracker.record(makeUsage(), "deepseek-v4-flash");
      tracker.record(makeUsage(), "deepseek-v4-flash");
      expect(tracker.sessionCallCount).toBe(2);

      tracker.resetSession();
      expect(tracker.sessionCallCount).toBe(0);
      expect(tracker.sessionTotalCost).toBe(0);
    });
  });

  describe("日级统计", () => {
    it("应正确累加今日统计", () => {
      tracker.record(makeUsage({ promptTokens: 1000, completionTokens: 500 }), "deepseek-v4-flash");
      tracker.record(makeUsage({ promptTokens: 2000, completionTokens: 1000 }), "deepseek-v4-pro");

      const today = tracker.todaySummary;
      expect(today.totalPromptTokens).toBe(3000);
      expect(today.totalCompletionTokens).toBe(1500);
      expect(today.totalCalls).toBe(2);
      expect(today.totalCost).toBeGreaterThan(0);
    });

    it("应支持按模型分类统计", () => {
      tracker.record(makeUsage({ promptTokens: 1000, completionTokens: 500 }), "deepseek-v4-flash");
      tracker.record(makeUsage({ promptTokens: 2000, completionTokens: 1000 }), "deepseek-v4-pro");

      const today = tracker.todaySummary;
      expect(today.byModel["deepseek-v4-flash"]).toBeDefined();
      expect(today.byModel["deepseek-v4-pro"]).toBeDefined();
      expect(today.byModel["deepseek-v4-flash"].totalCalls).toBe(1);
      expect(today.byModel["deepseek-v4-pro"].totalCalls).toBe(1);
    });

    it("todayTotalCost 应返回今日总费用", () => {
      tracker.record(makeUsage({ promptTokens: 1000, completionTokens: 500 }), "deepseek-v4-flash");
      tracker.record(makeUsage({ promptTokens: 1000, completionTokens: 500 }), "deepseek-v4-flash");

      expect(tracker.todayTotalCost).toBeCloseTo(0.004, 6);
    });

    it("resetSession 不应重置日级累计", () => {
      tracker.record(makeUsage({ promptTokens: 1000, completionTokens: 500 }), "deepseek-v4-flash");
      const costBefore = tracker.todayTotalCost;

      tracker.resetSession();
      expect(tracker.todayTotalCost).toBeCloseTo(costBefore, 6);
    });
  });

  describe("预算控制", () => {
    it("不应超出预算时 isBudgetExceeded 为 false", () => {
      const t = new CostTracker({ costDir: tmpDir, budgetLimit: 10 });
      t.record(makeUsage({ promptTokens: 1000, completionTokens: 500 }), "deepseek-v4-flash");
      expect(t.isBudgetExceeded).toBe(false);
    });

    it("超出金额预算时 isBudgetExceeded 应为 true", () => {
      const t = new CostTracker({ costDir: tmpDir, budgetLimit: 0.001 });
      // flash: 1K prompt * ¥1/M + 500 completion * ¥2/M = ¥0.002
      t.record(makeUsage({ promptTokens: 1000, completionTokens: 500 }), "deepseek-v4-flash");
      expect(t.isBudgetExceeded).toBe(true);
    });

    it("超出 Token 预算时 isBudgetExceeded 应为 true", () => {
      const t = new CostTracker({ costDir: tmpDir, tokenBudgetLimit: 3000 });
      t.record(makeUsage({ promptTokens: 500, completionTokens: 500 }), "deepseek-v4-flash");
      expect(t.isBudgetExceeded).toBe(false);
      t.record(makeUsage({ promptTokens: 2000, completionTokens: 2000 }), "deepseek-v4-flash");
      expect(t.isBudgetExceeded).toBe(true);
    });

    it("remainingBudget 应正确计算剩余预算", () => {
      const t = new CostTracker({ costDir: tmpDir, budgetLimit: 0.01 });
      t.record(makeUsage({ promptTokens: 1000, completionTokens: 500 }), "deepseek-v4-flash");
      expect(t.remainingBudget).toBeCloseTo(0.01 - 0.002, 6);
    });

    it("预算为 0 时 remainingBudget 应返回 Infinity", () => {
      const t = new CostTracker({ costDir: tmpDir, budgetLimit: 0 });
      expect(t.remainingBudget).toBe(Infinity);
    });

    it("预算超限回调应被触发", () => {
      const cb = vi.fn();
      const t = new CostTracker({ costDir: tmpDir, budgetLimit: 0.001, onBudgetExceeded: cb });
      t.record(makeUsage({ promptTokens: 1000, completionTokens: 500 }), "deepseek-v4-flash");
      expect(cb).toHaveBeenCalledOnce();
      expect(cb).toHaveBeenCalledWith(t);
    });
  });

  describe("持久化", () => {
    it("flush 后应能通过 load 恢复数据", async () => {
      const t1 = new CostTracker({ costDir: tmpDir });
      t1.record(makeUsage({ promptTokens: 1000, completionTokens: 500 }), "deepseek-v4-flash");
      t1.record(makeUsage({ promptTokens: 2000, completionTokens: 1000 }), "deepseek-v4-pro");
      await t1.flush();

      // 创建新的 tracker 并加载
      const t2 = new CostTracker({ costDir: tmpDir });
      await t2.load();

      // 今日数据应该从磁盘恢复
      expect(t2.todayTotalCost).toBeCloseTo(t1.todayTotalCost, 6);
      expect(t2.todaySummary.totalCalls).toBe(2);
    });

    it("queryRange 应返回指定日期范围的数据", async () => {
      const t = new CostTracker({ costDir: tmpDir });
      t.record(makeUsage({ promptTokens: 1000, completionTokens: 500 }), "deepseek-v4-flash");
      await t.flush();

      const today = new Date().toISOString().slice(0, 10);
      const results = await t.queryRange(today);
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].totalCalls).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // 自动落盘（最小可用方案核心）— 验证 record() 后目录与文件被自动创建
  // -------------------------------------------------------------------------
  describe("持久化与目录创建（最小可用方案）", () => {
    it("load() 会在成本目录不存在时自动 mkdir", async () => {
      const dir = await mkdtemp(join(tmpdir(), "dskcode-load-mkdir-"));
      const costDir = join(dir, "nested", "costs");
      // 子目录还不存在
      await expect(stat(costDir)).rejects.toThrow();

      const t = new CostTracker({ costDir });
      await t.load();

      // 目录应被创建
      const st = await stat(costDir);
      expect(st.isDirectory()).toBe(true);

      await rm(dir, { recursive: true, force: true });
    });

    it("flush() 会在目录不存在时自动创建目录与 history.json", async () => {
      const dir = await mkdtemp(join(tmpdir(), "dskcode-flush-dir-"));
      const t = new CostTracker({ costDir: dir });

      t.record(makeUsage({ promptTokens: 1000, completionTokens: 500 }), "deepseek-v4-flash");
      await t.flush();

      // 目录与文件应已存在
      const dirStat = await stat(dir);
      expect(dirStat.isDirectory()).toBe(true);
      const fileStat = await stat(join(dir, "history.json"));
      expect(fileStat.isFile()).toBe(true);

      await rm(dir, { recursive: true, force: true });
    });

    it("flush 后的 history.json 内容应可被新实例 load 还原", async () => {
      const dir = await mkdtemp(join(tmpdir(), "dskcode-restore-"));
      const t1 = new CostTracker({ costDir: dir });
      t1.record(makeUsage({ promptTokens: 1000, completionTokens: 500 }), "deepseek-v4-flash");
      t1.record(makeUsage({ promptTokens: 2000, completionTokens: 1000 }), "deepseek-v4-pro");
      await t1.flush();

      // 验证历史文件内容
      const raw = await readFile(join(dir, "history.json"), "utf-8");
      const parsed = JSON.parse(raw) as { version: number; daily: Record<string, DailyCostSummary> };
      expect(parsed.version).toBe(1);
      const today = new Date().toISOString().slice(0, 10);
      const todaySummary = parsed.daily[today];
      expect(todaySummary).toBeDefined();
      expect(todaySummary.totalCalls).toBe(2);
      expect(todaySummary.totalPromptTokens).toBe(3000);
      expect(todaySummary.totalCompletionTokens).toBe(1500);

      // 新 tracker load 出来，今日累计应一致
      const t2 = new CostTracker({ costDir: dir });
      await t2.load();
      expect(t2.todayTotalCost).toBeCloseTo(t1.todayTotalCost, 6);
      expect(t2.todayCallCount).toBe(2);

      await rm(dir, { recursive: true, force: true });
    });

    it("连续多次 record 后只产生 1 个 history.json，且数据是合并后的最新值", async () => {
      const dir = await mkdtemp(join(tmpdir(), "dskcode-multi-record-"));
      const t = new CostTracker({ costDir: dir });

      for (let i = 0; i < 5; i++) {
        t.record(makeUsage({ promptTokens: 100, completionTokens: 50 }), "deepseek-v4-flash");
      }
      await t.flush();

      const raw = await readFile(join(dir, "history.json"), "utf-8");
      const parsed = JSON.parse(raw) as { daily: Record<string, DailyCostSummary> };
      const today = new Date().toISOString().slice(0, 10);
      expect(parsed.daily[today].totalCalls).toBe(5);
      expect(parsed.daily[today].totalPromptTokens).toBe(500);
      expect(parsed.daily[today].totalCompletionTokens).toBe(250);

      await rm(dir, { recursive: true, force: true });
    });

    it("flush 失败时不应抛错，错误应被 console.error 记录", async () => {
      const dir = await mkdtemp(join(tmpdir(), "dskcode-flush-fail-"));
      const fakeDir = join(dir, "blocked");
      // 把路径变成普通文件，让 mkdir 抛 ENOENT/EEXIST 之外的错误
      const { writeFile } = await import("node:fs/promises");
      await writeFile(fakeDir, "not a directory", "utf-8");

      const t = new CostTracker({ costDir: fakeDir });

      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      t.record(makeUsage({ promptTokens: 200, completionTokens: 100 }), "deepseek-v4-flash");
      await t.flush();

      // flush 失败应被记录，但不应抛
      expect(errSpy).toHaveBeenCalled();
      errSpy.mockRestore();

      await rm(dir, { recursive: true, force: true });
    });
  });

  // -------------------------------------------------------------------------
  // 进程退出兜底：CostTracker.flushAll() 应统一 flush 所有活跃实例
  // -------------------------------------------------------------------------
  describe("CostTracker.flushAll — 进程退出兜底", () => {
    it("flushAll 应统一 flush 所有活跃实例到各自的 costDir", async () => {
      const dirA = await mkdtemp(join(tmpdir(), "dskcode-flushall-a-"));
      const dirB = await mkdtemp(join(tmpdir(), "dskcode-flushall-b-"));

      const tA = new CostTracker({ costDir: dirA });
      const tB = new CostTracker({ costDir: dirB });
      tA.record(makeUsage({ promptTokens: 100, completionTokens: 50 }), "deepseek-v4-flash");
      tB.record(makeUsage({ promptTokens: 200, completionTokens: 100 }), "deepseek-v4-pro");
      // 不显式 await record 内部触发的 flush，直接调 flushAll
      await CostTracker.flushAll();

      // 两个目录都应产生 history.json
      const statA = await stat(join(dirA, "history.json"));
      const statB = await stat(join(dirB, "history.json"));
      expect(statA.isFile()).toBe(true);
      expect(statB.isFile()).toBe(true);

      await rm(dirA, { recursive: true, force: true });
      await rm(dirB, { recursive: true, force: true });
    });

    it("flushAll 在无活跃实例时不应抛错", async () => {
      // 没有 new 任何 CostTracker，直接调
      await expect(CostTracker.flushAll()).resolves.toBeUndefined();
    });

    it("dispose() 应从实例表移除并 flush", async () => {
      const dir = await mkdtemp(join(tmpdir(), "dskcode-dispose-"));
      const t = new CostTracker({ costDir: dir });
      t.record(makeUsage({ promptTokens: 100, completionTokens: 50 }), "deepseek-v4-flash");
      await t.dispose();

      // 文件应存在
      const st = await stat(join(dir, "history.json"));
      expect(st.isFile()).toBe(true);

      await rm(dir, { recursive: true, force: true });
    });
  });
});

// ---------------------------------------------------------------------------
// 格式化工具
// ---------------------------------------------------------------------------

describe("formatMoney", () => {
  it("应格式化 0 元", () => {
    expect(formatMoney(0)).toBe("¥0.0000");
  });

  it("应格式化极小金额（4 位小数）", () => {
    expect(formatMoney(0.000032)).toBe("¥0.0000");
  });

  it("应格式化小于 1 元的金额（4 位小数）", () => {
    expect(formatMoney(0.1234)).toBe("¥0.1234");
  });

  it("应格式化大于等于 1 元的金额（4 位小数）", () => {
    expect(formatMoney(12.3)).toBe("¥12.3000");
  });
});

describe("formatTokens", () => {
  it("应格式化小数字", () => {
    expect(formatTokens(100)).toBe("100");
  });

  it("应格式化大数字（千分位）", () => {
    expect(formatTokens(1234567)).toBe("1,234,567");
  });
});

describe("formatCacheHitRate", () => {
  it("应格式化缓存命中率", () => {
    expect(formatCacheHitRate(500, 1000)).toBe("50.0%");
  });

  it("total 为 0 时应返回 0.0%", () => {
    expect(formatCacheHitRate(0, 0)).toBe("0.0%");
  });

  it("100% 命中时应返回 100.0%", () => {
    expect(formatCacheHitRate(1000, 1000)).toBe("100.0%");
  });
});

describe("formatTodayReport", () => {
  it("应生成包含费用的报告文本", () => {
    const summary: DailyCostSummary = {
      date: "2025-06-20",
      totalPromptTokens: 5000,
      totalCompletionTokens: 2000,
      totalCachedTokens: 1000,
      totalCost: 0.012,
      totalCalls: 5,
      byModel: {
        "deepseek-v4-flash": {
          model: "deepseek-v4-flash",
          totalPromptTokens: 3000,
          totalCompletionTokens: 1200,
          totalCachedTokens: 800,
          totalCost: 0.006,
          totalCalls: 3,
        },
      },
    };

    const report = formatTodayReport(summary);
    expect(report).toContain("今日消耗报告");
    expect(report).toContain("¥0.0120");
    expect(report).toContain("5 次");
    expect(report).toContain("deepseek-v4-flash");
    expect(report).toContain("20.0%");
  });
});

describe("formatSessionCostLine", () => {
  it("应生成会话成本单行文本", () => {
    const summary = {
      sessionId: "test-session",
      startedAt: "2025-06-20T10:00:00Z",
      totalPromptTokens: 5000,
      totalCompletionTokens: 2000,
      totalCachedTokens: 1000,
      totalCost: 0.012,
      records: Array.from<CostRecord>({ length: 3 }),
    };

    const line = formatSessionCostLine(summary);
    expect(line).toContain("¥0.0120");
    expect(line).toContain("5,000");
    expect(line).toContain("2,000");
    expect(line).toContain("3次");
  });
});

describe("formatCallCostLine", () => {
  it("应生成单次调用成本单行文本", () => {
    const record = {
      timestamp: "2025-06-20T10:00:00Z",
      model: "deepseek-v4-flash" as const,
      usage: { promptTokens: 1000, completionTokens: 500, cachedPromptTokens: 400 },
      cost: { inputCost: 0.0006, cacheHitCost: 0.000008, outputCost: 0.001, totalCost: 0.001608 },
    };

    const line = formatCallCostLine(record);
    expect(line).toContain("0.0016");
    expect(line).toContain("1000");
    expect(line).toContain("500");
    expect(line).toContain("40.0%");
  });
});