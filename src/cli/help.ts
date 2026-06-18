import type { Command } from "commander";
import chalk from "chalk";

export function customHelp(program: Command): string {
  const lines: string[] = [];

  lines.push("");
  lines.push(chalk.bold("用法:"));
  lines.push(`  ${chalk.cyan("dskcode")} ${chalk.dim("[global-options]")} ${chalk.green("<command>")} ${chalk.dim("[options]")}`);
  lines.push("");

  const globalOpts = program.options.filter(
    (o) => o.long !== "--help" && o.long !== "--version" && o.long !== "--config",
  );
  if (globalOpts.length > 0) {
    lines.push(chalk.bold("全局选项:"));
    for (const opt of globalOpts) {
      const flags = [opt.short, opt.long].filter(Boolean).join(", ");
      lines.push(`  ${chalk.cyan(flags.padEnd(24))} ${opt.description ?? ""}`);
    }
    lines.push("");
  }

  lines.push(chalk.bold("内置选项:"));
  for (const flag of ["-h, --help", "-V, --version"]) {
    const opt = program.options.find(
      (o) => o.long === (flag.includes("help") ? "--help" : "--version"),
    );
    if (opt) {
      lines.push(`  ${chalk.cyan(flag.padEnd(24))} ${opt.description ?? ""}`);
    }
  }
  lines.push("");

  const cmds = program.commands.filter((c) => !c.name().startsWith("help"));
  if (cmds.length > 0) {
    lines.push(chalk.bold("命令:"));
    for (const cmd of cmds) {
      lines.push(`  ${chalk.green(cmd.name().padEnd(24))} ${cmd.description()}`);
    }
    lines.push("");
  }

  lines.push(chalk.bold("示例:"));
  lines.push(`  ${chalk.dim("# 启动交互式对话")}`);
  lines.push("  dskcode chat");
  lines.push(`  ${chalk.dim("# 让 AI 执行一个任务")}`);
  lines.push("  dskcode run 修改所有 TODO 注释");
  lines.push(`  ${chalk.dim("# 运行配置向导")}`);
  lines.push("  dskcode setup");
  lines.push(`  ${chalk.dim("# 生成 shell 自动补全")}`);
  lines.push("  dskcode completion");
  lines.push("");

  return lines.join("\n");
}
