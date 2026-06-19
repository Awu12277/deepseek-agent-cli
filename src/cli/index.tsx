import { Command } from "commander";
import { loadConfigMiddleware } from "./middleware.js";
import { customHelp } from "./help.js";
import { hasApiKey, promptForApiKey } from "./api-key-setup.js";
import { saveApiKey, loadAndValidate } from "../config/index.js";
import { renderApp, ChatSession } from "../ui/index.js";
import { initGames } from "../game/registry.js";
import { listGames, getGame } from "../game/index.js";
import type { Game } from "../game/index.js";
import { GamePicker } from "../ui/GamePicker.js";
import { render } from "ink";
import chalk from "chalk";
import { fetchQuotes, printQuotes } from "../stock/index.js";
import type { StockSymbol } from "../config/types.js";

const SUBCOMMANDS = ["chat", "run", "setup", "init", "completion", "game", "stock"];

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

  program.hook("preAction", async (thisCommand, actionCommand) => {
    const ctx = await loadConfigMiddleware.call(thisCommand);
    (actionCommand as unknown as Record<string, unknown>).dskcodeCtx = ctx;
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

      let ctx = (this as unknown as Record<string, unknown>).dskcodeCtx as
        | { verbose: boolean; config: { providers: Array<{ apiKey?: string }>; tools: unknown[] } }
        | undefined;

      // 检查 API Key，如果没有则交互式输入
      if (ctx && !hasApiKey(ctx.config.providers)) {
        const key = await promptForApiKey();
        if (!key) process.exit(1);

        // 保存到全局配置
        const savedPath = await saveApiKey(key);
        console.log(`  ${chalk.green("✔")} API Key 已保存到 ${chalk.dim(savedPath)}\n`);

        // 重新加载配置，使新 Key 生效
        const result = await loadAndValidate();
        ctx = { ...ctx, config: result.config };
      }

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

  // stock — 股票行情
  program
    .command("stock")
    .description("查看自选股实时行情")
    .argument("[codes...]", "股票代码（空格分隔），如 sh513090 sz000001。不指定则读取配置中的自选股")
    .option("--watch", "每5秒自动刷新行情")
    .action(async function (codes: string[]) {
      const opts = this.opts() as { watch?: boolean };
      const ctx = (this as unknown as Record<string, unknown>).dskcodeCtx as
        | { config: { stock?: { symbols: StockSymbol[] } } }
        | undefined;

      const resolveSymbols = (): StockSymbol[] => {
        if (codes && codes.length > 0) {
          return codes.map((c) => ({ code: c }));
        }
        if (ctx?.config.stock?.symbols && ctx.config.stock.symbols.length > 0) {
          return ctx.config.stock.symbols;
        }
        return [];
      };

      const allSymbols = resolveSymbols();
      if (allSymbols.length > 10) {
        console.log(chalk.yellow(`⚠ 自选股超过10只，仅显示前10只（共${allSymbols.length}只）`) + "\n");
      }
      const symbols = allSymbols.slice(0, 10);
      if (symbols.length === 0) {
        console.log(
          chalk.yellow("未配置自选股。请通过以下方式使用：") +
          "\n\n  " + chalk.cyan("dskcode stock sh513090 sz000001") +
          "\n\n或在配置文件中添加 stock.symbols 字段" +
          "\n  " + chalk.dim("~/.dskcode/settings.json"),
        );
        return;
      }

      if (opts.watch) {
        console.clear();
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const quotes = await fetchQuotes(symbols);
          printQuotes(quotes);
          console.log(chalk.dim("  按 Ctrl+C 退出  |  每5秒自动刷新\n"));
          await new Promise((resolve) => setTimeout(resolve, 5000));
          console.clear();
        }
      } else {
        const quotes = await fetchQuotes(symbols);
        printQuotes(quotes);
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
