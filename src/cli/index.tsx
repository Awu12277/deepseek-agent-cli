import { Command } from "commander";
import { loadConfigMiddleware } from "./middleware.js";
import { customHelp } from "./help.js";
import { renderApp, ChatSession } from "../ui/index.js";
import { initGames } from "../game/registry.js";
import { listGames, getGame } from "../game/index.js";
import type { Game } from "../game/index.js";
import { GamePicker } from "../ui/GamePicker.js";
import { render } from "ink";
import chalk from "chalk";

const SUBCOMMANDS = ["chat", "run", "setup", "init", "completion", "game"];

export function createCli(): Command {
  const program = new Command();
  program.exitOverride();

  program
    .name("dskcode")
    .description("基于 DeepSeek 的 AI 编程助手终端工具")
    .version("0.0.0", "-V, --version", "显示版本号")
    .option("--verbose", "开启详细日志输出")
    .option("--config <path>", "指定配置文件路径");

  program.helpInformation = () => customHelp(program);

  program.hook("preAction", async (thisCommand) => {
    const ctx = await loadConfigMiddleware.call(thisCommand);
    (thisCommand as unknown as Record<string, unknown>).dskcodeCtx = ctx;
  });

  // chat — 交互式对话
  program
    .command("chat")
    .description("启动交互式对话会话")
    .action(async function () {
      if (!process.stdin.isTTY) {
        console.error("dskcode chat 需要交互式终端。如需执行一次性任务，请使用 dskcode run。");
        process.exit(1);
      }

      const ctx = (this as unknown as Record<string, unknown>).dskcodeCtx as
        | { verbose: boolean; config: { providers: unknown[]; tools: unknown[] } }
        | undefined;

      const app = renderApp(
        <ChatSession
          providerCount={ctx?.config.providers.length ?? 1}
          toolCount={ctx?.config.tools.length ?? 0}
          verbose={ctx?.verbose ?? false}
        />,
      );

      await app.waitUntilExit;
    });

  // run
  program
    .command("run")
    .description("执行一次性任务")
    .argument("[prompt...]", "任务描述")
    .option("--model <name>", "指定使用的模型")
    .action(async function (_prompt: string[]) {
      console.log("dskcode run — 待实现（第07章）");
    });

  // setup
  program
    .command("setup")
    .description("运行配置向导")
    .option("--export", "以 JSON 格式导出配置")
    .option("--test", "测试 API Key 连通性")
    .action(async function () {
      console.log("dskcode setup — 待实现（第14章）");
    });

  // init
  program
    .command("init")
    .description("在当前项目下生成项目记忆文件（AGENTS.md）")
    .action(async function () {
      console.log("dskcode init — 待实现（第11章）");
    });

  // completion
  program
    .command("completion")
    .description("输出 shell 自动补全配置说明（bash/zsh）")
    .argument("[shell]", "shell 类型", /^(bash|zsh)$/i)
    .action(async function (shell?: string) {
      if (!shell) {
        console.log("请指定 shell 类型：dskcode completion bash 或 dskcode completion zsh");
        return;
      }
      if (shell === "bash") {
        console.log(`# dskcode bash 自动补全
_dskcode_completion() {
  local cur=\${COMP_WORDS[COMP_CWORD]}
  if [[ \${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "${SUBCOMMANDS.join(" ")}" -- "\${cur}") )
    return 0
  fi
  COMPREPLY=( $(compgen -W "--verbose --config --model" -- "\${cur}") )
}
complete -F _dskcode_completion dskcode`);
      } else {
        console.log(`# dskcode zsh 自动补全
_dskcode_completion() {
  local -a commands
  commands=(
    "chat:启动交互式对话会话"
    "run:执行一次性任务"
    "setup:运行配置向导"
    "init:生成项目记忆文件"
    "completion:输出 shell 自动补全说明"
    "game:内置小游戏"
  )
  _describe 'dskcode commands' commands
}
compdef _dskcode_completion dskcode`);
      }
    });

  // game — 游戏模式
  initGames();

  program
    .command("game")
    .description("启动内置小游戏")
    .argument("[name]", "游戏名称，不指定则显示交互式游戏列表")
    .action(async function (name?: string) {
      if (name) {
        const game = getGame(name);
        if (!game) {
          console.error(`未找到游戏 "${name}"。使用 dskcode game 查看可用游戏列表。`);
          process.exit(1);
        }
        console.log(`正在启动: ${game.name} — ${game.description}\n`);
        await game.play();
      } else {
        const games = listGames();
        if (games.length === 0) {
          console.log("暂无可用游戏。");
          return;
        }

        const selectedGame = await new Promise<Game | null>((resolve) => {
          const { unmount } = render(
            <GamePicker
              games={games}
              onSelect={(game) => {
                unmount();
                resolve(game);
              }}
              onExit={() => {
                unmount();
                resolve(null);
              }}
            />,
          );
        });

        if (selectedGame) {
          console.log(`\n  启动游戏: ${chalk.green(selectedGame.name)}\n`);
          await selectedGame.play();
        }
      }
    });

  return program;
}
