import { Command } from "commander";

/**
 * 创建并配置根 CLI 程序。
 *
 * 设置顶层命令名、全局选项和子命令。
 * 后续章节会逐步添加各子命令的完整实现。
 */
export function createCli(): Command {
  // exitOverride 阻止 process.exit()，方便测试 --help / --version
  const program = new Command();
  program.exitOverride();

  program
    .name("dsk")
    .description("基于 DeepSeek 的 AI 编程助手终端工具")
    .version("0.0.0", "-V, --version", "输出版本号")
    .option("--verbose", "开启详细日志输出")
    .hook("preAction", (_thisCommand, _actionCommand) => {
      // TODO(第14章): 加载配置、鉴权检查、初始化日志
    });

  // ── 子命令: chat ─────────────────────────────────────────────
  program
    .command("chat")
    .description("启动交互式对话会话")
    .action(async () => {
      console.log("dsk chat — 待实现（第07章）");
    });

  // ── 子命令: run ──────────────────────────────────────────────
  program
    .command("run")
    .description("执行一次性任务")
    .argument("[prompt...]", "任务描述")
    .option("--model <name>", "指定使用的模型")
    .action(async (_prompt: string[]) => {
      console.log("dsk run — 待实现（第07章）");
    });

  // ── 子命令: setup ────────────────────────────────────────────
  program
    .command("setup")
    .description("运行配置向导")
    .option("--export", "以 JSON 格式导出配置")
    .option("--test", "测试 API Key 连通性")
    .action(async () => {
      console.log("dsk setup — 待实现（第14章）");
    });

  return program;
}
