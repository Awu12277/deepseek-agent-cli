#!/usr/bin/env node

import { createCli } from "./cli/index.js";
import { ExitCode } from "./cli/exit-codes.js";
import { CostTracker } from "./provider/cost-tracker.js";

/**
 * 双击 Ctrl+C 退出：
 * 第一次 SIGINT → 提示用户再按一次
 * 第二次 SIGINT（1.5 秒内）→ 立即退出
 *
 * 在 ink 交互模式下，Ctrl+C 由 useInput 捕获处理，
 * 此处只处理 ink 未运行时的 SIGINT（如启动阶段）。
 */
let sigintCount = 0;
// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
let sigintTimer: NodeJS.Timeout | null = null;

/**
 * 全局兜底 SIGINT 处理：双击退出。
 * ink 交互模式下 Ctrl+C 由 useDoubleCtrlC hook 处理，
 * 此处仅处理 ink 未运行时的场景（如启动阶段、异常退出后）。
 *
 * 第二次 SIGINT / 任意 SIGTERM / 正常退出前都会统一 flush 所有
 * CostTracker 实例，确保今日用量数据落盘。
 */
async function gracefulExit(code: number): Promise<never> {
  try {
    await CostTracker.flushAll();
  } catch {
    // 兜底路径，flush 失败不影响退出码
  }
  process.exit(code);
}

process.on("SIGINT", () => {
  sigintCount++;
  if (sigintCount >= 2) {
    void gracefulExit(ExitCode.SIGINT);
    return;
  }
  process.stdout.write("\n  ⚠ 再按一次 Ctrl+C 退出 dskcode\n");
  if (sigintTimer) clearTimeout(sigintTimer);
  sigintTimer = setTimeout(() => {
    sigintCount = 0;
  }, 1500);
});

process.on("SIGTERM", () => {
  void gracefulExit(ExitCode.SIGINT);
});

const program = createCli();

try {
  await program.parseAsync(process.argv);
  // 正常执行完毕后也兜底 flush（一般 record() 内部已 fire-and-forget，
  // 这里保证若本次没有任何 record 调用也不漏盘）
  await CostTracker.flushAll();
} catch (err: unknown) {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const error = err as { exitCode?: number; code?: string };

  if (error.code === "commander.helpDisplayed" || error.code === "commander.version") {
    await CostTracker.flushAll();
    process.exit(error.exitCode ?? ExitCode.SUCCESS);
  }

  if (typeof error.exitCode === "number") {
    await CostTracker.flushAll();
    process.exit(error.exitCode);
  }

  console.error(String(err));
  await CostTracker.flushAll();
  process.exit(ExitCode.GENERAL_ERROR);
}
