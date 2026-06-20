# 给 AI 编程助手装上"账单"：Token 计价与成本追踪系统实现

**TL;DR:** 为 dskcode 实现了三层成本追踪系统 — 会话级、日级、历史级 — 支持 DeepSeek Prefix Cache 半价计费、预算控制、自动持久化。让用户对自己的每一分钱花在哪都心里有数。

---

## 为什么需要成本追踪

dskcode 是一个基于 DeepSeek API 的 AI 编程助手 CLI 工具。每次你问它一个问题，背后都在调用大模型，而大模型是按 token 收费的。

之前的版本里，调用完就完事了，用户完全不知道花了多少钱。这就像打车不看计价器——心里没底。

特别是有两个痛点：

1. **不同模型价格差异大**：Flash 模型输入 ¥1/百万 token，Pro 模型 ¥3/百万 token，输出价格也不同
2. **Prefix Cache 计费复杂**：DeepSeek 对缓存命中的 token 收取极低价格（Flash 只要 ¥0.02/百万），但用户看不到这个优惠

所以我们需要一个成本追踪系统，让用户能随时看到：

- **这次对话**花了多少钱
- **今天总共**花了多少钱
- **按模型**分别花了多少
- **缓存命中**省了多少钱

---

## 系统设计概览

整个系统分为三个层级：

```
┌─────────────────────────────────────┐
│         CostTracker 类               │
├─────────────────────────────────────┤
│  会话级（内存）  ← 当前对话的明细    │
│  日级（内存+磁盘） ← 今日汇总        │
│  历史级（磁盘） ← 近90天数据         │
│  预算控制 ← 金额/Token双重限制       │
└─────────────────────────────────────┘
```

**关键设计决策：**

- 会话级数据只存内存，会话结束即丢弃（或者切换会话时重置）
- 日级数据实时累加并异步刷到磁盘，程序重启也能恢复
- 历史数据存 JSON 文件，保留 90 天自动清理
- 预算检查在每次 `record()` 后触发，支持回调通知

---

## Step 1：模型定价元数据

首先定义每个模型的价格信息。这里用 TypeScript 的 `const` 对象，类型安全又直观：

```typescript
// src/provider/models.ts

export const SUPPORTED_MODELS: Record<ModelId, ModelMeta> = {
  "deepseek-v4-flash": {
    id: "deepseek-v4-flash",
    displayName: "DeepSeek V4 Flash",
    contextWindow: 1_000_000,
    inputPricePerMillion: 1,       // ¥1 / 百万 token
    outputPricePerMillion: 2,      // ¥2 / 百万 token
    cacheHitPricePerMillion: 0.02, // ¥0.02 / 百万 token（半价不到！）
  },
  "deepseek-v4-pro": {
    id: "deepseek-v4-pro",
    displayName: "DeepSeek V4 Pro",
    contextWindow: 1_000_000,
    inputPricePerMillion: 3,
    outputPricePerMillion: 6,
    cacheHitPricePerMillion: 0.025,
  },
};
```

对应的类型定义：

```typescript
// src/provider/types.ts

/** Token 使用统计 */
export interface UsageInfo {
  promptTokens: number;
  completionTokens: number;
  /** DeepSeek Prefix Cache 命中的 token 数 */
  cachedPromptTokens?: number;
}

/** 费用计算结果（单位：元） */
export interface CostInfo {
  inputCost: number;       // 输入费用（缓存未命中部分）
  cacheHitCost: number;    // 缓存命中费用（享受更低单价）
  outputCost: number;      // 输出费用
  totalCost: number;       // 费用合计
}

/** 模型元数据 */
export interface ModelMeta {
  id: ModelId;
  displayName: string;
  contextWindow: number;
  inputPricePerMillion: number;
  outputPricePerMillion: number;
  cacheHitPricePerMillion: number;
}
```

---

## Step 2：费用计算核心逻辑

计费公式其实很简单：

```
输入费用（缓存未命中） = (promptTokens - cachedPromptTokens) × inputPrice / 1,000,000
缓存命中费用           = cachedPromptTokens × cacheHitPrice / 1,000,000
输出费用               = completionTokens × outputPrice / 1,000,000
总费用                 = 输入费用 + 缓存命中费用 + 输出费用
```

实现也就十几行：

```typescript
// src/provider/models.ts

export function calculateCost(usage: UsageInfo, model: ModelId): CostInfo {
  const meta = SUPPORTED_MODELS[model];
  const cached = usage.cachedPromptTokens ?? 0;
  const nonCached = usage.promptTokens - cached;

  const inputCost = (nonCached * meta.inputPricePerMillion) / 1_000_000;
  const cacheHitCost = (cached * meta.cacheHitPricePerMillion) / 1_000_000;
  const outputCost = (usage.completionTokens * meta.outputPricePerMillion) / 1_000_000;

  return {
    inputCost,
    cacheHitCost,
    outputCost,
    totalCost: inputCost + cacheHitCost + outputCost,
  };
}
```

**来算笔账：**

```
问：Flash 模型，输入 2000 token（其中 1500 缓存命中），输出 1000 token
输入（未命中）: 500 × ¥1 / 1,000,000 = ¥0.0005
缓存命中:       1500 × ¥0.02 / 1,000,000 = ¥0.00003
输出:           1000 × ¥2 / 1,000,000 = ¥0.002
总计:           ¥0.00253
```

也就是一次普通的代码问答，成本大约 **两厘五**。这价格确实香。

---

## Step 3：CostTracker — 三层统计

这是系统的核心。`CostTracker` 类管理三个维度的数据：

### 3.1 类型定义

```typescript
// src/provider/cost-tracker.ts

/** 单次 API 调用的成本记录 */
export interface CostRecord {
  timestamp: string;       // ISO 8601
  model: ModelId;
  usage: UsageInfo;
  cost: CostInfo;
}

/** 单个会话的成本汇总 */
export interface SessionCostSummary {
  sessionId: string;
  startedAt: string;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCachedTokens: number;
  totalCost: number;
  records: CostRecord[];
}

/** 一天的成本汇总 */
export interface DailyCostSummary {
  date: string;            // YYYY-MM-DD
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCachedTokens: number;
  totalCost: number;
  totalCalls: number;
  byModel: Record<string, ModelCostSummary>;
}
```

### 3.2 核心 record 方法

每次 API 调用返回后，调用 `tracker.record(usage, model)` 即可：

```typescript
export class CostTracker {
  readonly #sessionRecords: CostRecord[] = [];
  #todayDate: string;
  #todaySummary: DailyCostSummary;
  #dirty = false;

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

    // 2. 日级累加（自动处理跨日）
    this.#ensureTodayBucket();
    this.#addToDaily(record);

    // 3. 标记脏数据
    this.#dirty = true;

    // 4. 预算检查
    this.#checkBudget();

    return cost;
  }
```

**会话与日级数据的关系：**

- 会话级：记录每次调用的明细，重置会话时清空
- 日级：累加到今日汇总，重置会话不影响日级数据

这个设计让用户既能看"这次对话花了多少"，又能看"今天总共花了多少"。

### 3.3 跨日处理

如果用户用着用着过了零点，需要自动切换到新的一天：

```typescript
#ensureTodayBucket(): void {
  const today = getTodayStr();
  if (today !== this.#todayDate) {
    // 日期变更：旧日数据已经在磁盘上，切换到新日
    this.#todayDate = today;
    this.#todaySummary = createEmptyDailySummary(today);
    this.#dirty = true;
  }
}
```

### 3.4 预算控制

支持金额和 Token 双重预算限制，超限自动触发回调：

```typescript
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

get remainingBudget(): number {
  if (this.#budgetLimit <= 0) return Infinity;
  return Math.max(0, this.#budgetLimit - this.todayTotalCost);
}
```

用的时候：

```typescript
const tracker = new CostTracker({
  budgetLimit: 10,  // 每天上限 ¥10
  onBudgetExceeded: (t) => {
    console.log("💸 今日预算已超限！");
    process.exit(1);
  },
});
```

---

## Step 4：持久化 — 数据不丢

成本数据必须持久化，不然程序重启今天的数据就没了。

### 存储格式

```typescript
export interface CostStore {
  version: 1;
  daily: Record<string, DailyCostSummary>;
}
```

磁盘上就是一个 JSON 文件，每天一条汇总。

### Load & Flush

```typescript
async load(): Promise<void> {
  const store = await this.#loadStore();
  const today = getTodayStr();
  if (store.daily[today]) {
    this.#todaySummary = store.daily[today];
    this.#todayDate = today;
  }
}

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
```

### 90 天自动清理

成本数据不能无限膨胀。保存时清理 90 天前的旧数据：

```typescript
async #saveStore(): Promise<void> {
  const store = await this.#loadStore();
  store.daily[this.#todayDate] = this.#todaySummary;

  // 保留最近 90 天
  const cutoffDate = getDateNDaysAgo(90);
  const datesToRemove = Object.keys(store.daily).filter(
    (date) => date < cutoffDate,
  );
  for (const date of datesToRemove) {
    delete store.daily[date];
  }

  await mkdir(this.#costDir, { recursive: true });
  const filePath = join(this.#costDir, "history.json");
  await writeFile(filePath, JSON.stringify(store, null, 2), "utf-8");
}
```

### 在 Agent 中的集成

`Session` 类注入 `CostTracker` 实例，贯穿整个对话生命周期：

```typescript
// src/agent/index.ts
export class Session {
  readonly #costTracker: CostTracker;

  constructor(
    readonly provider: Provider,
    readonly tools: Tool[],
    costTracker?: CostTracker,
  ) {
    this.#costTracker = costTracker ?? new CostTracker();
  }

  get accumulatedCost(): number {
    return this.#costTracker.sessionTotalCost;
  }

  get costTracker(): CostTracker {
    return this.#costTracker;
  }

  reset(): void {
    this.#messages.length = 0;
    this.#costTracker.resetSession();
  }
}
```

---

## Step 5：终端友好输出

光有数据不够，还要让用户在终端里一目了然。

### 格式化金额

```typescript
export function formatMoney(yuan: number): string {
  if (yuan === 0) return "¥0.00";
  if (yuan < 0.01) return `¥${yuan.toFixed(6)}`;  // 极小金额
  if (yuan < 1) return `¥${yuan.toFixed(4)}`;     // 毫级金额
  return `¥${yuan.toFixed(2)}`;                   // 正常金额
}
```

**自适应精度：**

| 金额范围 | 显示 | 例子 |
|---------|------|------|
| 0 | ¥0.00 | 0 |
| < ¥0.01 | 6 位小数 | ¥0.000032 |
| < ¥1 | 4 位小数 | ¥0.1234 |
| ≥ ¥1 | 2 位小数 | ¥12.30 |

### 今日消耗报告

```typescript
export function formatTodayReport(summary: DailyCostSummary): string {
  const lines: string[] = [];

  lines.push(`📊 今日消耗报告 (${summary.date})`);
  lines.push("─".repeat(40));
  lines.push(`  💰 总费用:     ${formatMoney(summary.totalCost)}`);
  lines.push(`  📞 调用次数:   ${summary.totalCalls} 次`);
  lines.push(`  📥 输入 Token:  ${formatTokens(summary.totalPromptTokens)}`);
  lines.push(`  📤 输出 Token:  ${formatTokens(summary.totalCompletionTokens)}`);
  lines.push(
    `  🗄️ 缓存命中:   ${formatTokens(summary.totalCachedTokens)} (${formatCacheHitRate(...)})`,
  );

  // 按模型分类
  const models = Object.values(summary.byModel);
  if (models.length > 0) {
    lines.push("📈 按模型分类:");
    for (const m of models) {
      lines.push(`  ─ ${m.model} ─`);
      lines.push(`    费用: ${formatMoney(m.totalCost)} | 调用: ${m.totalCalls} 次`);
      // ...
    }
  }

  return lines.join("\n");
}
```

终端输出效果：

```
📊 今日消耗报告 (2025-06-20)
────────────────────────────────────────
  💰 总费用:     ¥0.1234
  📞 调用次数:   24 次
  📥 输入 Token:  45,678
  📤 输出 Token:  12,345
  🗄️ 缓存命中:   23,456 (51.4%)

📈 按模型分类:
  ─ deepseek-v4-flash ─
    费用: ¥0.0890 | 调用: 20 次
    输入: 35,000 | 输出: 10,000
    缓存命中: 20,000 (57.1%)
  ─ deepseek-v4-pro ─
    费用: ¥0.0344 | 调用: 4 次
    输入: 10,678 | 输出: 2,345
    缓存命中: 3,456 (32.4%)
```

---

## 测试覆盖

整个系统写了两百多行测试，覆盖所有核心场景：

```typescript
// tests/cost-tracker.test.ts（节选）

describe("CostTracker", () => {
  it("应正确记录 flash 模型无缓存命中的成本", () => {
    const usage = { promptTokens: 1000, completionTokens: 500 };
    const cost = tracker.record(usage, "deepseek-v4-flash");
    // inputCost = 1000 × 1 / 1,000,000 = 0.001
    // outputCost = 500 × 2 / 1,000,000 = 0.001
    expect(cost.totalCost).toBeCloseTo(0.002, 6);
  });

  it("缓存命中时 cacheHitCost 应正确", () => {
    const usage = {
      promptTokens: 2000,
      completionTokens: 1000,
      cachedPromptTokens: 1500,
    };
    const cost = tracker.record(usage, "deepseek-v4-flash");
    // cacheHitCost = 1500 × 0.02 / 1,000,000 = 0.00003
    expect(cost.cacheHitCost).toBeCloseTo(0.00003, 8);
  });

  it("会话统计应正确累加", () => {
    tracker.record(makeUsage({ promptTokens: 1000, completionTokens: 500 }), "flash");
    tracker.record(makeUsage({ promptTokens: 2000, completionTokens: 1000 }), "flash");
    expect(tracker.sessionSummary.totalPromptTokens).toBe(3000);
    expect(tracker.sessionSummary.totalCompletionTokens).toBe(1500);
    expect(tracker.sessionCallCount).toBe(2);
  });

  it("resetSession 不应重置日级累计", () => {
    tracker.record(makeUsage({ promptTokens: 1000, completionTokens: 500 }), "flash");
    const costBefore = tracker.todayTotalCost;
    tracker.resetSession();
    expect(tracker.todayTotalCost).toBeCloseTo(costBefore, 6);
  });

  it("超出金额预算时 isBudgetExceeded 应为 true", () => {
    const t = new CostTracker({ costDir: tmpDir, budgetLimit: 0.001 });
    t.record(makeUsage({ promptTokens: 1000, completionTokens: 500 }), "flash");
    // 一次调用就要 ¥0.002，预算只有 ¥0.001
    expect(t.isBudgetExceeded).toBe(true);
  });

  it("持久化后应能从磁盘恢复", async () => {
    const t1 = new CostTracker({ costDir: dir });
    t1.record(makeUsage({ promptTokens: 1000, completionTokens: 500 }), "flash");
    await t1.flush();

    const t2 = new CostTracker({ costDir: dir });
    await t2.load();
    expect(t2.todayTotalCost).toBeCloseTo(t1.todayTotalCost, 6);
  });
});
```

---

## Trade-offs 与反思

### 做得对的决定

1. **三层分离**：会话级、日级、历史级各司其职。会话级放内存不持久化，日级异步刷盘——读写在毫秒级完成，不阻塞主流程。

2. **JSON 文件而非 SQLite**：对于每天几十条记录的个人工具，JSON 文件够用且零依赖。不需要 SQLite 的查询能力，`queryRange()` 就是 filter + sort。

3. **90 天自动清理**：一个用户一天最多产生几十 KB 数据，90 天也才几 MB。但如果不清理，十年后可能变成几百 MB——虽然现实不太可能。

### 可以更好的地方

1. **Flush 时机**：目前是每次 `record()` 后标记脏数据，由外部调度 `flush()`。更好的做法是用一个 debounce 定时器自动 flush，减少心智负担。

2. **并发安全**：`#flushInProgress` 防重入，但如果多个 record 并发调用，理论上数据可能丢失。Node.js 单线程特性让这个风险很小。

3. **多 Key 支持**：如果用户轮换多个 API Key，目前的存储会把所有 Key 的成本混在一起。需要的话可以加一层 Key 维度的隔离。

---

## 总结

Token 成本追踪是个"不做也能用，做了就回不去"的功能。这次实现的系统：

- **价格驱动**：模型定价数据驱动计算，新增模型只需加几行配置
- **三层统计**：会话/日/历史，满足不同时间粒度的查询需求
- **缓存感知**：完整支持 DeepSeek Prefix Cache 半价计费
- **预算控制**：金额和 Token 双重限制，超限回调
- **零依赖持久化**：JSON 文件存储，90 天自动清理

完整代码在 [GitHub](https://github.com/DeepSeek-Reasonix/ts-version)，有问题欢迎留言讨论。

---

## 延伸阅读

- [DeepSeek API 官方文档 — 计费说明](https://platform.deepseek.com/api-docs)
- [DeepSeek Prefix Cache 介绍](https://api-docs.deepseek.com/guides/kv_cache)
- [Previous: Provider 抽象层设计](blog-04-provider-abstraction.md)
- [Previous: LLM API Client 实现](blog-05-llm-api-client.md)
