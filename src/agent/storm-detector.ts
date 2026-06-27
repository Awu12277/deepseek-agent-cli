// ---------------------------------------------------------------------------
// StormDetector — 纯判断层：检测「同一工具连续失败」风暴
//
// 设计原则：
// - 纯函数 / 纯类：输入历史 records + 当前 calls → boolean
// - 不持有 Session 状态，不写 messages
// - 触发条件：最近 N 条失败记录「工具名 + 错误码」完全相同 且 当前轮仍调用该工具
//
// 函数注释规范见仓库根 AGENTS.md「函数注释规范」一节。
// ---------------------------------------------------------------------------

import type { ProviderToolCall } from "../provider/index.js";
import type { ToolCallRecord } from "../tool/types.js";

/**
 * 风暴判定选项。
 *
 * @field threshold — 触发风暴需要的最少连续失败次数（默认 3）
 */
export interface StormDetectorOptions {
  /** 触发风暴需要的最少连续失败次数（默认 3） */
  threshold?: number;
}

/**
 * StormDetector：纯判断「本轮是否应该中断风暴」。
 *
 * 判定规则（按顺序检查，任一不满足则返回 false）：
 * 1. 历史失败记录数 ≥ threshold
 * 2. 取最后 threshold 条记录，必须全部失败，且工具名 / 错误码完全一致
 * 3. 当前轮至少有 1 个工具名匹配那个失败工具
 *
 * 用途：当 LLM 在同一工具上反复撞同一错误时，强制提示"切换策略"，
 *       避免无限循环。
 */
export class StormDetector {
  /** 触发风暴需要的最少连续失败次数（默认 3） */
  readonly #threshold: number;

  /**
   * 构造一个 StormDetector。
   *
   * @param opts — 判定选项（threshold）
   * @pure 仅保存配置
   */
  constructor(opts: StormDetectorOptions = {}) {
    this.#threshold = opts.threshold ?? 3;
  }

  /**
   * 判定本轮是否应该中断风暴。
   *
   * @param recentRecords — 历史的失败记录（不含成功的；通常来自 ToolExecutor 的 records）
   * @param currentCalls — 本轮 LLM 决定调用的工具
   * @returns true 表示触发风暴，调用方应放弃本轮工具执行并提示切换策略
   *
   * @pure 不修改任何状态，仅做比较判断
   */
  shouldBreak(recentRecords: readonly ToolCallRecord[], currentCalls: readonly ProviderToolCall[]): boolean {
    if (recentRecords.length < this.#threshold) return false;
    const lastN = recentRecords.slice(-this.#threshold);
    if (lastN.length < this.#threshold) return false;

    const first = lastN[0]!;
    const allSame = lastN.every((r) => r.name === first.name && r.error === first.error && !r.success);
    if (!allSame) return false;

    return currentCalls.some((tc) => tc.name === first.name);
  }
}
