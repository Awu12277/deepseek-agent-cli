import type { Command } from "commander";

export function customHelp(program: Command): string {
  const lines: string[] = [];

  lines.push("");
  lines.push("用法:");
  lines.push("  dsk [global-options] <command> [options]");
  lines.push("");

  const globalOpts = program.options.filter(
    (o) => o.long !== "--help" && o.long !== "--version" && o.long !== "--config",
  );
  if (globalOpts.length > 0) {
    lines.push("全局选项:");
    for (const opt of globalOpts) {
      const flags = [opt.short, opt.long].filter(Boolean).join(", ");
      lines.push(`  ${flags.padEnd(24)} ${opt.description ?? ""}`);
    }
    lines.push("");
  }

  lines.push("内置选项:");
  for (const flag of ["-h, --help", "-V, --version"]) {
    const opt = program.options.find(
      (o) => o.long === (flag.includes("help") ? "--help" : "--version"),
    );
    if (opt) {
      lines.push(`  ${flag.padEnd(24)} ${opt.description ?? ""}`);
    }
  }
  lines.push("");

  const cmds = program.commands.filter((c) => !c.name().startsWith("help"));
  if (cmds.length > 0) {
    lines.push("命令:");
    for (const cmd of cmds) {
      lines.push(`  ${cmd.name().padEnd(24)} ${cmd.description()}`);
    }
    lines.push("");
  }

  lines.push("示例:");
  lines.push("  # 启动交互式对话");
  lines.push("  dsk chat");
  lines.push("  # 让 AI 执行一个任务");
  lines.push("  dsk run 修改所有 TODO 注释");
  lines.push("  # 运行配置向导");
  lines.push("  dsk setup");
  lines.push("  # 生成 shell 自动补全");
  lines.push("  dsk completion");
  lines.push("");

  return lines.join("\n");
}
