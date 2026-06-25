import { Command } from "commander";
import { loadConfigMiddleware } from "./middleware.js";
import type { DskcodeContext } from "./middleware.js";
import { customHelp } from "./help.js";
import { hasApiKey, promptForApiKey } from "./api-key-setup.js";
import { promptImportClaudeSkills, countDskcodeSkills, countProjectLocalSkills, getAllSkills } from "./skill-import.js";
import { saveApiKey, loadAndValidate, saveStockConfig } from "../config/index.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { renderApp, ChatSession } from "../ui/index.js";
import { initGames } from "../game/registry.js";
import { listGames, getGame } from "../game/index.js";
import type { Game } from "../game/index.js";
import { GamePicker } from "../ui/GamePicker.js";
import { render } from "ink";
import chalk from "chalk";
import { StockList } from "../stock/index.js";
import { CostTracker } from "../provider/cost-tracker.js";
import { scanProjectFiles } from "../utils/scan-files.js";

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
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
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

      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      let ctx = (this as unknown as Record<string, unknown>).dskcodeCtx as DskcodeContext | undefined;

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

      // API Key 检查之后：检测项目本地 skill 和 Claude Code skill
      // 如果 .dskcode/skill 下有 skill，则跳过导入 Claude Code skill
      await promptImportClaudeSkills(process.cwd());

    // 从配置创建 CostTracker
    const costTracker = new CostTracker({
      budgetLimit: ctx?.config.budgetLimit ?? 0,
      tokenBudgetLimit: ctx?.config.tokenBudgetLimit ?? 0,
    });

    void startChat(ctx, costTracker);
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
    "stock:查看自选股实时行情"
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
    .argument("[codes...]", "股票代码（空格分隔），如 513090 600519")
    .action(async function (codes: string[]) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      const _ctx = (this as unknown as Record<string, unknown>).dskcodeCtx as DskcodeContext | undefined;

      // 检查用户全局配置文件是否已有自选股配置；没有则自动创建
      const home = process.env.HOME ?? process.env.USERPROFILE ?? "~";
      const globalConfigPath = join(home, ".dskcode", "settings.json");
      let globalConfigHasStock = false;
      try {
        const raw = await readFile(globalConfigPath, "utf-8");
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        const stock = parsed.stock as Record<string, unknown> | undefined;
        globalConfigHasStock = Array.isArray(stock?.symbols) && (stock.symbols as unknown[]).length > 0;
      } catch {
        // 文件不存在 — 需要创建
      }

      if (!globalConfigHasStock) {
        const defaultSymbols = [
          { code: "sh000001" },
          { code: "sz399300" },
          { code: "sh601899" },
        ];
        const savedPath = await saveStockConfig(defaultSymbols);
        console.log(`${chalk.green("✔")} 已生成自选股配置: ${chalk.dim(savedPath)}`);
        console.log(`${chalk.dim("  提示: 可编辑上述文件自定义自选股列表")}\n`);
      }

      // 加载配置（包含可能刚写入的自选股）
      const freshResult = await loadAndValidate();
      const codeList = codes && codes.length > 0
        ? codes
        : freshResult.config.stock?.symbols?.map((s) => s.code)
          ?? ["sh000001", "sz399006", "sh601688"];

      const app = renderApp(
        <StockList
          codes={codeList}
          onExit={() => process.exit(0)}
        />,
      );

      await app.waitUntilExit;
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
            { exitOnCtrlC: false },
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

async function startChat(
  ctx: DskcodeContext | undefined,
  costTracker: CostTracker,
) {
  // 统计 skill 数量并获取详情列表，以及扫描项目文件
  const [globalSkillCount, localSkillCount, skills, files] = await Promise.all([
    countDskcodeSkills(),
    countProjectLocalSkills(process.cwd()),
    getAllSkills(process.cwd()),
    scanProjectFiles(process.cwd()),
  ]);
  const skillCount = globalSkillCount + localSkillCount;
  // 从配置中提取默认 Provider 的 apiKey 和 baseUrl
  const defaultProvider = ctx?.config.providers.find(
    (p) => p.name === (ctx?.config.defaultProvider ?? "deepseek"),
  );
  const model = defaultProvider?.model ?? "deepseek-v4-flash";
  const chatApp = renderApp(
    <ChatSession
      skillCount={skillCount}
      skills={skills}
      files={files}
      toolCount={ctx?.config.tools.length ?? 0}
      verbose={ctx?.verbose ?? false}
      apiKey={defaultProvider?.apiKey}
      baseUrl={defaultProvider?.baseUrl ?? "https://api.deepseek.com"}
      costTracker={costTracker}
      model={model}
      onLaunchGame={() => {
        chatApp.unmount();
        setImmediate(() => {
          initGames();
          const games = listGames();
          const { unmount } = render(
            <GamePicker
              games={games}
              onSelect={async (game: Game) => {
                unmount();
                await game.play();
                // 游戏结束后返回对话
                void startChat(ctx, costTracker);
              }}
              onBackToChat={() => {
                unmount();
                setImmediate(() => startChat(ctx, costTracker));
              }}
            />,
            { exitOnCtrlC: false },
          );
        });
      }}
      onLaunchStock={() => {
        chatApp.unmount();
        setImmediate(() => {
          // 使用配置中的自选股列表或兜底默认值
          const defaultStockCodes = ctx?.config.stock?.symbols?.map((s) => s.code)
            ?? ["sh000001", "sz399006", "sh601688"];
          const stockApp = renderApp(
            <StockList
              codes={defaultStockCodes}
              onBackToChat={() => {
                stockApp.unmount();
                setImmediate(() => startChat(ctx, costTracker));
              }}
              onExit={() => process.exit(0)}
            />,
          );
        });
      }}
    />,
  );
}
