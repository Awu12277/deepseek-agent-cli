import { Command } from "commander";
import { loadConfigMiddleware } from "./middleware.js";

const SUBCOMMANDS = ["chat", "run", "setup", "init", "completion"];

export function createCli(): Command {
  const program = new Command();
  program.exitOverride();

  program
    .name("dsk")
    .description("基于 DeepSeek 的 AI 编程助手终端工具")
    .version("0.0.0", "-V, --version", "显示版本号")
    .option("--verbose", "开启详细日志输出")
    .option("--config <path>", "指定配置文件路径");

  program.hook("preAction", async (thisCommand) => {
    const ctx = await loadConfigMiddleware.call(thisCommand);
    (thisCommand as unknown as Record<string, unknown>).dskCtx = ctx;
  });

  // chat — 交互式对话
  program
    .command("chat")
    .description("启动交互式对话会话")
    .action(async function () {
      if (!process.stdin.isTTY) {
        console.error("dsk chat 需要交互式终端。如需执行一次性任务，请使用 dsk run。");
        process.exit(1);
      }
      console.log("dsk chat — 待实现（第07章）");
    });

  // run
  program
    .command("run")
    .description("执行一次性任务")
    .argument("[prompt...]", "任务描述")
    .option("--model <name>", "指定使用的模型")
    .action(async function (_prompt: string[]) {
      console.log("dsk run — 待实现（第07章）");
    });

  // setup
  program
    .command("setup")
    .description("运行配置向导")
    .option("--export", "以 JSON 格式导出配置")
    .option("--test", "测试 API Key 连通性")
    .action(async function () {
      console.log("dsk setup — 待实现（第14章）");
    });

  // init
  program
    .command("init")
    .description("在当前项目下生成项目记忆文件（AGENTS.md）")
    .action(async function () {
      console.log("dsk init — 待实现（第11章）");
    });

  // completion
  program
    .command("completion")
    .description("输出 shell 自动补全配置说明（bash/zsh）")
    .argument("[shell]", "shell 类型", /^(bash|zsh)$/i)
    .action(async function (shell?: string) {
      if (!shell) {
        console.log("请指定 shell 类型：dsk completion bash 或 dsk completion zsh");
        return;
      }
      if (shell === "bash") {
        console.log(`# dsk bash 自动补全
_dsk_completion() {
  local cur=${COMP_WORDS[COMP_CWORD]}
  if [[ ${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "${SUBCOMMANDS.join(" ")}" -- "${cur}") )
    return 0
  fi
  COMPREPLY=( $(compgen -W "--verbose --config --model" -- "${cur}") )
}
complete -F _dsk_completion dsk`);
      } else {
        console.log(`# dsk zsh 自动补全
_dsk_completion() {
  local -a commands
  commands=(
    "chat:启动交互式对话会话"
    "run:执行一次性任务"
    "setup:运行配置向导"
    "init:生成项目记忆文件"
    "completion:输出 shell 自动补全说明"
  )
  _describe 'dsk commands' commands
}
compdef _dsk_completion dsk`);
      }
    });

  return program;
}
