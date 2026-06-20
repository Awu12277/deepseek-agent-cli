// ---------------------------------------------------------------------------
// 成本追踪器 — 会话级 / 日级 / 历史级三层成本统计与持久化
// ---------------------------------------------------------------------------

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { UsageInfo, CostInfo, ModelId } from "./types.js";
import { calculateCost } from "./models.js";

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

/** 单次 API 调用的成本记录 */
export interface CostRecord {
  /** 记录时间戳（ISO 8601） */
  timestamp: string;
  /** 使用的模型 */
  model: ModelId;
  /** Token 使用量 */
  usage: UsageInfo;
  /** 费用明细（单位：元） */
  cost: CostInfo;
}

/** 单个会话的成本汇总 */
export interface SessionCostSummary {
  /** 会话 ID */
  sessionId: string;
  /** 会话开始时间（ISO 8601） */
  startedAt: string;
  /** 总输入 token 数 */
  totalPromptTokens: number;
  /** 总输出 token 数 */
  totalCompletionTokens: number;
  /** 总缓存命中 token 数 */
  totalCachedTokens: number;
  /** 总费用（元） */
  totalCost: number;
  /** 每次调用的详细记录 */
  records: CostRecord[];
}

/** 一天的成本汇总 */
export interface DailyCostSummary {
  /** 日期（YYYY-MM-DD 格式） */
  date: string;
  /** 当日总输入 token 数 */
  totalPromptTokens: number;
  /** 当日总输出 token 数 */
  totalCompletionTokens: number;
  /** 当日总缓存命中 token 数 */
  totalCachedTokens: number;
  /** 当日总费用（元） */
  totalCost: number;
  /** 当日 API 调用次数 */
  totalCalls: number;
  /** 按模型分类的明细 */
  byModel: Record<string, ModelCostSummary>;
}

/** 按模型分类的成本汇总 */
export interface ModelCostSummary {
  /** 模型标识 */
  model: ModelId;
  /** 该模型的总输入 token 数 */
  totalPromptTokens: number;
  /** 该模型的总输出 token 数 */
  totalCompletionTokens: number;
  /** 该模型的总缓存命中 token 数 */
  totalCachedTokens: number;
  /** 该模型的总费用（元） */
  totalCost: number;
  /** 该模型的 API 调用次数 */
  totalCalls: number;
}

/** 持久化文件格式 */
export interface CostStore {
  /** 版本号，便于未来格式迁移 */
  version: 1;
  /** 按日期索引的汇总数据 */
  daily: Record<string, DailyCostSummary>;
}

// ---------------------------------------------------------------------------
// CostTracker 配置
// ---------------------------------------------------------------------------

export interface CostTrackerOptions {
  /** 成本持久化目录，默认 ~/.dskcode/costs */
  costDir?: string;
  /** 预算上限（元），超过后触发回调，0 表示不限制 */
  budgetLimit?: number;
  /** Token 预算上限，超过后触发回调，0 表示不限制 */
  tokenBudgetLimit?: number;
  /** 预算超限回调 */
  onBudgetExceeded?: (tracker: CostTracker) => void;
}

// ---------------------------------------------------------------------------
// CostTracker 类
// ---------------------------------------------------------------------------

/**
 * 成本追踪器 — 管理三层成本统计：
 *
 * 1. **会话级**（内存）：当前会话内的累计 token 与费用
 * 2. **日级**（内存 + 持久化）：按日聚合，支持"今日消耗"查询
 * 3. **历史级**（持久化）：跨日的历史汇总查询
 *
 * 使用方式：
 * ```ts
 * const tracker = new CostTracker({ budgetLimit: 10 });
 * tracker.record(usage, 'deepseek-v4-flash');
 * console.log(tracker.todaySummary());
 * ```
 */
export class CostTracker {
  readonly #costDir: string;
  readonly #budgetLimit: number;
  readonly #tokenBudgetLimit: number;
  readonly #onBudgetExceeded?: (tracker: CostTracker) => void;

  // 会话级统计（内存）
  #sessionId: string;
  #sessionStartedAt: string;
  readonly #sessionRecords: CostRecord[] = [];

  // 日级统计（内存缓存，启动时从磁盘恢复）
  #todayDate: string;
  #todaySummary: DailyCostSummary;

  // 持久化标记
  #dirty = false;
  #flushInProgress = false;

  constructor(options: CostTrackerOptions = {}) {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "~";
    this.#costDir = options.costDir ?? join(home, ".dskcode", "costs");
    this.#budgetLimit = options.budgetLimit ?? 0;
    this.#tokenBudgetLimit = options.tokenBudgetLimit ?? 0;
    this.#onBudgetExceeded = options.onBudgetExceeded;

    // 初始化会话
    this.#sessionId = generateSessionId();
    this.#sessionStartedAt = new Date().toISOString();

    // 初始化日级统计
    const today = getTodayStr();
    this.#todayDate = today;
    this.#todaySummary = createEmptyDailySummary(today);
  }

  // -----------------------------------------------------------------------
  // 核心方法
  // -----------------------------------------------------------------------

  /**
   * 记录一次 API 调用的 Token 使用量和成本。
   * 自动计算费用，累加到会话级和日级统计。
   */
  record(usage: UsageInfo, model: ModelId): CostInfo {
    const cost = calculateCost(usage, model);
    const record: CostRecord = {
      timestamp: new Date().toISOString(),
      model,
      usage: { ...usage },
      cost: { ...cost },
    };

    // 1. 会话级累加
    this.#sessionRecords.push(record);

    // 2. 日级累加（自动处理日期变更）
    this.#ensureTodayBucket();
    this.#addToDaily(record);

    // 3. 标记需要持久化
    this.#dirty = true;

    // 4. 预算检查
    this.#checkBudget();

    return cost;
  }

  // -----------------------------------------------------------------------
  // 会话级查询
  // -----------------------------------------------------------------------

  /** 当前会话 ID */
  get sessionId(): string {
    return this.#sessionId;
  }

  /** 当前会话的所有成本记录 */
  get records(): readonly CostRecord[] {
    return this.#sessionRecords;
  }

  /** 当前会话累计成本汇总 */
  get sessionSummary(): SessionCostSummary {
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let totalCachedTokens = 0;
    let totalCost = 0;

    for (const r of this.#sessionRecords) {
      totalPromptTokens += r.usage.promptTokens;
      totalCompletionTokens += r.usage.completionTokens;
      totalCachedTokens += r.usage.cachedPromptTokens ?? 0;
      totalCost += r.cost.totalCost;
    }

    return {
      sessionId: this.#sessionId,
      startedAt: this.#sessionStartedAt,
      totalPromptTokens,
      totalCompletionTokens,
      totalCachedTokens,
      totalCost,
      records: [...this.#sessionRecords],
    };
  }

  /** 当前会话总费用（元） */
  get sessionTotalCost(): number {
    return this.#sessionRecords.reduce((sum, r) => sum + r.cost.totalCost, 0);
  }

  /** 当前会话总 prompt token 数 */
  get sessionPromptTokens(): number {
    return this.#sessionRecords.reduce((sum, r) => sum + r.usage.promptTokens, 0);
  }

  /** 当前会话总 completion token 数 */
  get sessionCompletionTokens(): number {
    return this.#sessionRecords.reduce((sum, r) => sum + r.usage.completionTokens, 0);
  }

  /** 当前会话 API 调用次数 */
  get sessionCallCount(): number {
    return this.#sessionRecords.length;
  }

  // -----------------------------------------------------------------------
  // 日级查询
  // -----------------------------------------------------------------------

  /** 今日成本汇总 */
  get todaySummary(): DailyCostSummary {
    this.#ensureTodayBucket();
    return { ...this.#todaySummary };
  }

  /** 今日总费用（元） */
  get todayTotalCost(): number {
    this.#ensureTodayBucket();
    return this.#todaySummary.totalCost;
  }

  /** 今日 API 调用次数 */
  get todayCallCount(): number {
    this.#ensureTodayBucket();
    return this.#todaySummary.totalCalls;
  }

  // -----------------------------------------------------------------------
  // 预算检查
  // -----------------------------------------------------------------------

  /** 是否已超出预算 */
  get isBudgetExceeded(): boolean {
    if (this.#budgetLimit > 0 && this.todayTotalCost >= this.#budgetLimit) {
      return true;
    }
    if (this.#tokenBudgetLimit > 0) {
      const totalTokens =
        this.#todaySummary.totalPromptTokens +
        this.#todaySummary.totalCompletionTokens;
      if (totalTokens >= this.#tokenBudgetLimit) return true;
    }
    return false;
  }

  /** 剩余预算（元），无限制时返回 Infinity */
  get remainingBudget(): number {
    if (this.#budgetLimit <= 0) return Infinity;
    return Math.max(0, this.#budgetLimit - this.todayTotalCost);
  }

  // -----------------------------------------------------------------------
  // 持久化
  // -----------------------------------------------------------------------

  /**
   * 从磁盘加载历史成本数据。
   * 启动时调用，用于恢复今日和历史数据。
   */
  async load(): Promise<void> {
    const store = await this.#loadStore();
    const today = getTodayStr();

    if (store.daily[today]) {
      this.#todaySummary = store.daily[today];
      this.#todayDate = today;
    }
  }

  /**
   * 将脏数据持久化到磁盘。
   * 通常在每次 record() 后异步调用，或在会话结束时主动调用。
   */
  async flush(): Promise<void> {
    if (!this.#dirty || this.#flushInProgress) return;
    this.#flushInProgress = true;
    this.#dirty = false;

    try {
      await this.#saveStore();
    } finally {
      this.#flushInProgress = false;
    }
  }

  /**
   * 查询指定日期范围的成本汇总。
   * @param startDate 起始日期（YYYY-MM-DD），包含
   * @param endDate   截止日期（YYYY-MM-DD），包含，默认同 startDate
   */
  async queryRange(
    startDate: string,
    endDate?: string,
  ): Promise<DailyCostSummary[]> {
    const store = await this.#loadStore();
    const end = endDate ?? startDate;
    const result: DailyCostSummary[] = [];

    for (const [date, summary] of Object.entries(store.daily)) {
      if (date >= startDate && date <= end) {
        result.push(summary);
      }
    }

    result.sort((a, b) => a.date.localeCompare(b.date));
    return result;
  }

  /** 重置会话（开始新会话，不影响日级累计） */
  resetSession(): void {
    this.#sessionId = generateSessionId();
    this.#sessionStartedAt = new Date().toISOString();
    this.#sessionRecords.length = 0;
  }

  // -----------------------------------------------------------------------
  // 内部方法
  // -----------------------------------------------------------------------

  /** 确保今日的统计桶存在（处理跨日情况） */
  #ensureTodayBucket(): void {
    const today = getTodayStr();
    if (today !== this.#todayDate) {
      // 日期变更：将旧日数据持久化后切换到新日
      this.#todayDate = today;
      this.#todaySummary = createEmptyDailySummary(today);
      this.#dirty = true;
    }
  }

  /** 将一条记录累加到日级汇总 */
  #addToDaily(record: CostRecord): void {
    this.#todaySummary.totalPromptTokens += record.usage.promptTokens;
    this.#todaySummary.totalCompletionTokens += record.usage.completionTokens;
    this.#todaySummary.totalCachedTokens += record.usage.cachedPromptTokens ?? 0;
    this.#todaySummary.totalCost += record.cost.totalCost;
    this.#todaySummary.totalCalls += 1;

    // 按模型分类累加
    const modelKey = record.model;
    if (!this.#todaySummary.byModel[modelKey]) {
      this.#todaySummary.byModel[modelKey] = {
        model: record.model,
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        totalCachedTokens: 0,
        totalCost: 0,
        totalCalls: 0,
      };
    }

    const modelSummary = this.#todaySummary.byModel[modelKey];
    modelSummary.totalPromptTokens += record.usage.promptTokens;
    modelSummary.totalCompletionTokens += record.usage.completionTokens;
    modelSummary.totalCachedTokens += record.usage.cachedPromptTokens ?? 0;
    modelSummary.totalCost += record.cost.totalCost;
    modelSummary.totalCalls += 1;
  }

  /** 预算超限检查 */
  #checkBudget(): void {
    if (!this.isBudgetExceeded) return;
    this.#onBudgetExceeded?.(this);
  }

  /** 从磁盘加载成本存储 */
  async #loadStore(): Promise<CostStore> {
    const filePath = join(this.#costDir, "history.json");
    try {
      const raw = await readFile(filePath, "utf-8");
      return JSON.parse(raw) as CostStore;
    } catch {
      return { version: 1, daily: {} };
    }
  }

  /** 保存成本存储到磁盘 */
  async #saveStore(): Promise<void> {
    const store = await this.#loadStore();

    // 合并今日数据到存储中
    store.daily[this.#todayDate] = this.#todaySummary;

    // 保留最近 90 天的数据（避免文件过大）
    const cutoffDate = getDateNDaysAgo(90);
    const datesToRemove = Object.keys(store.daily).filter(
      (date) => date < cutoffDate,
    );
    for (const date of datesToRemove) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete store.daily[date];
    }

    // 确保目录存在
    await mkdir(this.#costDir, { recursive: true });

    const filePath = join(this.#costDir, "history.json");
    await writeFile(filePath, JSON.stringify(store, null, 2), "utf-8");
  }
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/** 生成会话 ID：时间戳 + 随机后缀 */
function generateSessionId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts}-${rand}`;
}

/** 获取今日日期字符串（YYYY-MM-DD） */
function getTodayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

/** 获取 N 天前的日期字符串 */
function getDateNDaysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

/** 创建空的日级成本汇总 */
function createEmptyDailySummary(date: string): DailyCostSummary {
  return {
    date,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalCachedTokens: 0,
    totalCost: 0,
    totalCalls: 0,
    byModel: {},
  };
}

// ---------------------------------------------------------------------------
// 格式化工具
// ---------------------------------------------------------------------------

/** 格式化费用金额 */
export function formatMoney(yuan: number): string {
  if (yuan === 0) return "¥0.00";
  if (yuan < 0.01) return `¥${yuan.toFixed(6)}`;
  if (yuan < 1) return `¥${yuan.toFixed(4)}`;
  return `¥${yuan.toFixed(2)}`;
}

/** 格式化 token 数量（带千分位） */
export function formatTokens(tokens: number): string {
  return tokens.toLocaleString("en-US");
}

/** 格式化缓存命中率百分比 */
export function formatCacheHitRate(cached: number, total: number): string {
  if (total === 0) return "0.0%";
  return `${((cached / total) * 100).toFixed(1)}%`;
}

/** 生成今日消耗报告的终端友好文本 */
export function formatTodayReport(summary: DailyCostSummary): string {
  const lines: string[] = [];

  lines.push(`📊 今日消耗报告 (${summary.date})`);
  lines.push("─".repeat(40));
  lines.push(`  💰 总费用:     ${formatMoney(summary.totalCost)}`);
  lines.push(`  📞 调用次数:   ${String(summary.totalCalls)} 次`);
  lines.push(`  📥 输入 Token:  ${formatTokens(summary.totalPromptTokens)}`);
  lines.push(`  📤 输出 Token:  ${formatTokens(summary.totalCompletionTokens)}`);
  lines.push(
    `  🗄️ 缓存命中:   ${formatTokens(summary.totalCachedTokens)} (${formatCacheHitRate(summary.totalCachedTokens, summary.totalPromptTokens)})`,
  );
  lines.push("");

  // 按模型分类明细
  const models = Object.values(summary.byModel);
  if (models.length > 0) {
    lines.push("📈 按模型分类:");
    for (const m of models) {
      lines.push(`  ─ ${m.model} ─`);
      lines.push(`    费用: ${formatMoney(m.totalCost)} | 调用: ${String(m.totalCalls)} 次`);
      lines.push(
        `    输入: ${formatTokens(m.totalPromptTokens)} | 输出: ${formatTokens(m.totalCompletionTokens)}`,
      );
      lines.push(
        `    缓存命中: ${formatTokens(m.totalCachedTokens)} (${formatCacheHitRate(m.totalCachedTokens, m.totalPromptTokens)})`,
      );
    }
  }

  return lines.join("\n");
}

/** 生成会话成本摘要的单行文本 */
export function formatSessionCostLine(summary: SessionCostSummary): string {
  const cacheRate = formatCacheHitRate(
    summary.totalCachedTokens,
    summary.totalPromptTokens,
  );
  return (
    `💰 ¥${summary.totalCost.toFixed(4)} | ` +
    `📥${formatTokens(summary.totalPromptTokens)} ` +
    `📤${formatTokens(summary.totalCompletionTokens)} ` +
    `🗄️${cacheRate} | ` +
    `📞${String(summary.records.length)}次`
  );
}

/** 生成单次调用的成本单行文本 */
export function formatCallCostLine(record: CostRecord): string {
  const cacheRate = formatCacheHitRate(
    record.usage.cachedPromptTokens ?? 0,
    record.usage.promptTokens,
  );
  return (
    `≈¥${record.cost.totalCost.toFixed(6)} ` +
    `(📥${String(record.usage.promptTokens)} 📤${String(record.usage.completionTokens)} 🗄️${cacheRate})`
  );
}