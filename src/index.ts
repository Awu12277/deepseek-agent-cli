#!/usr/bin/env node

import { createCli } from "./cli/index.js";
import { ExitCode } from "./cli/exit-codes.js";

/**
 * 双击 Ctrl+C 退出：
 * 第一次 SIGINT → 提示用户再按一次
 * 第二次 SIGINT（1.5 秒内）→ 立即退出
 *
 * 在 ink 交互模式下，Ctrl+C 由 useInput 捕获处理，
 * 此处只处理 ink 未运行时的 SIGINT（如启动阶段）。
 */
let sigintCount = 0;
let sigintTimer: ReturnType<typeof setTimeout> | null = null;

process.on("SIGINT", () => {
  sigintCount++;
  if (sigintCount >= 2) {
    process.exit(ExitCode.SIGINT);
  }
  // 第一次：给出提示
  process.stdout.write("\n  ⚠ 再按一次 Ctrl+C 退出 dskcode\n");
  if (sigintTimer) clearTimeout(sigintTimer);
  sigintTimer = setTimeout(() => {
    sigintCount = 0;
    sigintTimer = null;
  }, 1500);
});

const program = createCli();

try {
  await program.parseAsync(process.argv);
} catch (err: unknown) {
  const error = err as { exitCode?: number; code?: string };

  if (error.code === "commander.helpDisplayed" || error.code === "commander.version") {
    process.exit(error.exitCode ?? ExitCode.SUCCESS);
  }

  if (typeof error.exitCode === "number") {
    process.exit(error.exitCode);
  }

  console.error(String(err));
  process.exit(ExitCode.GENERAL_ERROR);
}
