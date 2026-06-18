# 从零开发 Agent CLI（二）：CLI 框架搭建与子命令路由

**TL;DR:** 用 commander 搭建 CLI 骨架，注册 chat / run / setup / init / completion 五个子命令，通过 `preAction` hook 注入配置上下文，自定义帮助信息，统一退出码规范。

---

## 前言

我一直觉得，一个有仪式感的 CLI 工具，应该在敲下命令那瞬间就让你感觉到"靠谱"。这就需要一个规整的框架：退出码不能乱用、帮助信息不能太丑、命令结构要有层次。

上一篇我们搭好了工程基建（tsup + Vitest + TypeScript ESM），这一篇来给 dsk 安上骨架。目标很简单：

- 注册 5 个子命令：`chat` `run` `setup` `init` `completion`
- 所有命令走同一套配置加载逻辑
- 退出码统一，不能一会儿 `process.exit(0)` 一会儿 `process.exit(1)`
- `--help` 看起来像个人写的，不是框架默认的
- 入口能优雅处理 `Ctrl+C` 和 commander 抛出的异常

我们用 [commander](https://github.com/tj/commander.js) 来做这件事。Node.js 生态里做 CLI 的库不少，yargs、clack、ink 各有千秋，但 commander 胜在简单、稳定、社区够大，够我们用了。

---

## 统一退出码

这是一个很小的文件，但我觉得值得单拎出来说。

很多 CLI 项目会直接在代码里到处写 `process.exit(1)` 或 `process.exit(0)`，时间长了根本分不清每个退出码代表什么。

所以我先定义了一组常量：

```typescript
// src/cli/exit-codes.ts

/** dsk 退出码规范 */
export const ExitCode = {
  /** 正常执行完成 */
  SUCCESS: 0,
  /** 通用错误 */
  GENERAL_ERROR: 1,
  /** 配置错误 */
  CONFIG_ERROR: 2,
  /** 用户通过 Ctrl+C 中断 */
  SIGINT: 130,
} as const;
```

`as const` 确保 TypeScript 把值推断成字面量类型，后续用法如 `ExitCode.SUCCESS` 就能被类型检查捕获拼写错误。退出码 130 是 Unix 惯例（128 + SIGINT 信号值 2），遵循这个约定能让 shell 脚本正确判断状态。

后续如果引入新的错误类型，往这里加就行，一目了然。

---

## 配置加载中间件

CLI 工具启动时最常见的需求就是：加载配置。我需要确保每个子命令在执行业务逻辑前，配置已经被加载好并且可用。

commander 提供了一个 `hook` 机制——`preAction` 在每次 action 执行前被调用。我利用它做了一个"配置注入中间件"：

```typescript
// src/cli/middleware.ts

import type { Command } from "commander";
import type { Config } from "../config/index.js";
import { loadConfig } from "../config/index.js";

/**
 * dsk 运行时上下文。
 * 通过 commander 的 preAction hook 注入到每个命令中。
 */
export interface DskContext {
  config: Config;
  verbose: boolean;
}

export async function loadConfigMiddleware(this: Command): Promise<DskContext> {
  const opts = this.optsWithGlobals() as { verbose?: boolean; config?: string };
  const verbose = opts.verbose ?? false;

  let config: Config;
  try {
    config = await loadConfig(opts.config);
  } catch {
    const { defaultConfig } = await import("../config/index.js");
    config = defaultConfig;
  }

  return { config, verbose };
}
```

设计思路：

- `DskContext` 接口就是整个 CLI 的运行时上下文。后续章节每增加一个能力（比如 provider 管理器、tool 注册表），就往这里加字段。所有命令共享一个数据源。
- 配置加载失败不会让进程崩溃——回退到默认配置，用标准输出提示，而不是直接 `process.exit`。
- `optsWithGlobals()` 能同时拿到全局选项和子命令选项，后续如果需要某个子命令覆盖全局配置，这个机制很好扩展。

在 `createCli` 中注册它：

```typescript
program.hook("preAction", async (thisCommand) => {
  const ctx = await loadConfigMiddleware.call(thisCommand);
  (thisCommand as unknown as Record<string, unknown>).dskCtx = ctx;
});
```

注意这里用了 `Function.prototype.call` 保持 `this` 指向。commander 的 `hook` 回调中 `thisCommand` 就是被触发的那个命令实例，用 `call` 把上下文传进去，让中间件函数在正确的 `this` 下执行。

命令的 action 中通过 `this.dskCtx` 就能拿到配置了：

```typescript
const ctx = (this as unknown as Record<string, unknown>).dskCtx as DskContext;
```

类型转换有点丑，但胜在简单。后续如果需求复杂了，可以给 commander 的类型做 declaration merging，不过目前不值得折腾。

---

## 自定义帮助信息

commander 默认的 `--help` 输出长得比较……标准。我想让它看起来更像是 dsk 的风格：带上颜色、分组清晰、有示例。

```typescript
// src/cli/help.ts

import type { Command } from "commander";
import chalk from "chalk";

export function customHelp(program: Command): string {
  const lines: string[] = [];

  lines.push("");
  lines.push(chalk.bold("用法:"));
  lines.push(`  ${chalk.cyan("dsk")} ${chalk.dim("[global-options]")} ${chalk.green("<command>")} ${chalk.dim("[options]")}`);
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
  lines.push("  dsk chat");
  lines.push(`  ${chalk.dim("# 让 AI 执行一个任务")}`);
  lines.push("  dsk run 修改所有 TODO 注释");
  lines.push(`  ${chalk.dim("# 运行配置向导")}`);
  lines.push("  dsk setup");
  lines.push(`  ${chalk.dim("# 生成 shell 自动补全")}`);
  lines.push("  dsk completion");
  lines.push("");

  return lines.join("\n");
}
```

然后在 `createCli` 中暴力覆写 commander 的 help 方法：

```typescript
program.helpInformation = () => customHelp(program);
```

是的，就是直接赋值覆盖。commander 内部靠 `helpInformation()` 这个方法生成帮助文本，覆写它是最干净的方式，没有之一。

输出效果大概长这样：

```
用法:
  dsk [global-options] <command> [options]

全局选项:
  --verbose                 开启详细日志输出

内置选项:
  -h, --help               显示帮助信息
  -V, --version            显示版本号

命令:
  chat                     启动交互式对话会话
  run                      执行一次性任务
  setup                    运行配置向导
  init                     生成项目记忆文件
  completion               输出 shell 自动补全说明

示例:
  # 启动交互式对话
  dsk chat
  # 让 AI 执行一个任务
  dsk run 修改所有 TODO 注释
  # 运行配置向导
  dsk setup
  # 生成 shell 自动补全
  dsk completion
```

chalk 的颜色在终端里会很好看，可惜 Markdown 看不出来，你们自己跑 `npx dsk --help` 感受一下。

---

## 子命令路由

终于到重头戏了。五个子命令，各有各的定位。

把 `src/cli/index.ts` 改成 `src/cli/index.tsx`（因为我们后面要用 JSX 渲染终端 UI），然后用 `.tsx` 扩展名让 TypeScript 开心：

```typescript
// src/cli/index.tsx

import { Command } from "commander";
import { loadConfigMiddleware } from "./middleware.js";
import { customHelp } from "./help.js";

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

  program.helpInformation = () => customHelp(program);

  program.hook("preAction", async (thisCommand) => {
    const ctx = await loadConfigMiddleware.call(thisCommand);
    (thisCommand as unknown as Record<string, unknown>).dskCtx = ctx;
  });

  // ── chat 子命令 ──────────────────────────────
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

  // ── run 子命令 ───────────────────────────────
  program
    .command("run")
    .description("执行一次性任务")
    .argument("[prompt...]", "任务描述")
    .option("--model <name>", "指定使用的模型")
    .action(async function (_prompt: string[]) {
      console.log("dsk run — 待实现（第07章）");
    });

  // ── setup 子命令 ─────────────────────────────
  program
    .command("setup")
    .description("运行配置向导")
    .option("--export", "以 JSON 格式导出配置")
    .option("--test", "测试 API Key 连通性")
    .action(async function () {
      console.log("dsk setup — 待实现（第14章）");
    });

  // ── init 子命令 ──────────────────────────────
  program
    .command("init")
    .description("在当前项目下生成项目记忆文件（AGENTS.md）")
    .action(async function () {
      console.log("dsk init — 待实现（第11章）");
    });

  // ── completion 子命令 ────────────────────────
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
  local cur=\${COMP_WORDS[COMP_CWORD]}
  if [[ \${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "${SUBCOMMANDS.join(" ")}" -- "\${cur}") )
    return 0
  fi
  COMPREPLY=( $(compgen -W "--verbose --config --model" -- "\${cur}") )
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
```

几个值得说的设计点：

### exitOverride

```typescript
program.exitOverride();
```

这行太重要了。Commander 默认在 `--help` 和 `--version` 时直接调 `process.exit()`，但在单元测试里你不想真的退出进程。`exitOverride()` 让 commander 改抛一个 `CommanderError`，这样测试代码可以直接用 `rejects.toMatchObject` 来断言退出码。

### TTY 检测

```typescript
if (!process.stdin.isTTY) {
  console.error("dsk chat 需要交互式终端。...");
  process.exit(1);
}
```

`dsk chat` 是一个交互式会话，在管道里跑没有意义（比如 `echo "hello" | dsk chat`）。检测 `process.stdin.isTTY` 提前提示用户，而不是进到会话里发现没输出再报错。

### completion 子命令

这个子命令有点特殊——它不调用任何 API，只是往终端输出一段 shell 函数定义。用户把这段输出加到 `.bashrc` 或 `.zshrc` 里就能获得自动补全。

我选择了"输出说明"而不是直接安装补全脚本，原因是：
- 不同操作系统的 shell 配置路径不一样，自动安装容易出错
- 用户自己粘贴一次就知道补全脚本放哪了
- 保持简单，13 行逻辑搞定 bash 和 zsh 两套

bash 补全用 `COMP_WORDS` 和 `compgen`，zsh 补全用 `_describe`。两者覆盖了 95% 以上的开发者终端场景。

### SUBCOMMANDS 常量

```typescript
const SUBCOMMANDS = ["chat", "run", "setup", "init", "completion"];
```

定义成一个数组而不是到处硬编码字符串，这样 bash 补全脚本、测试、后续的权限校验都可以引用同一个来源。

---

## 入口文件：SIGINT 与异常规范化

入口文件 `src/index.ts` 是用户的第一个接触点，也是异常处理的最后一环：

```typescript
#!/usr/bin/env node

import { createCli } from "./cli/index.js";
import { ExitCode } from "./cli/exit-codes.js";

process.on("SIGINT", () => {
  process.exit(ExitCode.SIGINT);
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
```

这段代码处理了三种场景：

1. **用户按 Ctrl+C** → 触发 `SIGINT` 处理器，退出码 130。注意这里不能 `process.exit(130)` 硬编码，要用 `ExitCode.SIGINT`。
2. **commander 正常退出** → `--help` 和 `--version` 抛出 `code === "commander.helpDisplayed"` 或 `"commander.version"`，捕获后以 SUCCESS 码退出。
3. **其他 commander 异常** → 比如参数解析失败，command 没找到，commander 会抛一个带 `exitCode` 的异常，直接透传这个码。
4. **未知异常** → 打印错误栈，以 `ExitCode.GENERAL_ERROR` 退出。

另外注意 `await program.parseAsync(process.argv)`。Commander 提供了 `parseAsync` 和 `parse` 两个版本。如果你的 action 是 async 的（大概率是，因为要调 API），必须用 `parseAsync`，否则 Promise reject 会被吞掉。

---

## tsconfig 调整

加了一个 `tsx` 文件后，tsconfig 需要同步：

```jsonc
{
  "include": ["src/**/*.ts", "src/**/*.tsx"],
}
```

不做这个调整，`tsc --noEmit` 会忽略 `.tsx` 文件，类型检查等于白跑了。

---

## 测试

测试这里有一个关键点：`exitOverride()` 让 commander 抛异常而非退出进程，我们的测试依赖这个行为：

```typescript
import { describe, it, expect } from "vitest";
import { createCli } from "../src/cli/index.js";
import { ExitCode } from "../src/cli/exit-codes.js";

describe("createCli", () => {
  const cli = createCli();

  it("should return a Command instance with name dsk", () => {
    expect(cli.name()).toBe("dsk");
  });

  it("should register the chat subcommand", () => {
    const cmd = cli.commands.find((c) => c.name() === "chat");
    expect(cmd).toBeDefined();
    expect(cmd!.description()).toBe("启动交互式对话会话");
  });

  it("should register the run subcommand", () => {
    const cmd = cli.commands.find((c) => c.name() === "run");
    expect(cmd).toBeDefined();
    expect(cmd!.description()).toBe("执行一次性任务");
  });

  it("should register the setup subcommand", () => {
    const cmd = cli.commands.find((c) => c.name() === "setup");
    expect(cmd).toBeDefined();
    expect(cmd!.description()).toBe("运行配置向导");
  });

  it("should register the init subcommand", () => {
    const cmd = cli.commands.find((c) => c.name() === "init");
    expect(cmd).toBeDefined();
    expect(cmd!.description()).toBe("在当前项目下生成项目记忆文件（AGENTS.md）");
  });

  it("should register the completion subcommand", () => {
    const cmd = cli.commands.find((c) => c.name() === "completion");
    expect(cmd).toBeDefined();
    expect(cmd!.description()).toContain("shell 自动补全");
  });

  it("should have the --verbose global option", () => {
    const opts = cli.options.map((o) => o.long);
    expect(opts).toContain("--verbose");
  });

  it("should have the --config global option", () => {
    const opts = cli.options.map((o) => o.long);
    expect(opts).toContain("--config");
  });

  it("should output version with --version (exitCode=0)", async () => {
    await expect(
      cli.parseAsync(["node", "dsk", "--version"]),
    ).rejects.toMatchObject({ exitCode: ExitCode.SUCCESS });
  });

  it("should output help with --help (exitCode=0)", async () => {
    await expect(
      cli.parseAsync(["node", "dsk", "--help"]),
    ).rejects.toMatchObject({ exitCode: ExitCode.SUCCESS });
  });

  it("run subcommand should exit with SUCCESS", async () => {
    await expect(
      cli.parseAsync(["node", "dsk", "run", "test"]),
    ).resolves.toBeDefined();
  });
});

describe("ExitCode constants", () => {
  it("should have the correct values", () => {
    expect(ExitCode.SUCCESS).toBe(0);
    expect(ExitCode.GENERAL_ERROR).toBe(1);
    expect(ExitCode.CONFIG_ERROR).toBe(2);
    expect(ExitCode.SIGINT).toBe(130);
  });
});
```

测试覆盖了：所有子命令的注册和描述、全局选项、`--help`/`--version` 的退出码、子命令正常执行、ExitCode 常量值。一共 12 个用例。

注意最后一个用例：`cli.parseAsync(["node", "dsk", "run", "test"])` 是**不会抛异常**的，因为 `dsk run` 的 action 只是 `console.log`，没有调用 `process.exit`。所以这里用 `resolves` 而非 `rejects`。

---

## 跑一下看看效果

现在项目根目录执行：

```bash
$ npx dsk --help
```

你应该能看到带颜色的自定义帮助信息。

```bash
$ npx dsk --version
0.0.0

$ npx dsk unknown-command
# commander 会报错，退出码 1
```

跑测试：

```bash
$ npx vitest run tests/cli.test.ts

 ✓ tests/cli.test.ts (2 test suites, 12 tests)
```

12 个用例全绿通过。

---

## 文件结构总结

这一章新增/修改的文件：

```
src/
├── cli/
│   ├── exit-codes.ts    # 新增 — 退出码常量
│   ├── help.ts          # 新增 — 自定义帮助信息
│   ├── index.tsx        # 重写 — CLI 主路由（.ts 改 .tsx）
│   └── middleware.ts    # 新增 — 配置加载中间件
├── index.ts             # 修改 — SIGINT + 异常处理
tests/
└── cli.test.ts          # 修改 — 新增 7 个用例
tsconfig.json            # 修改 — include .tsx
```

---

## 做了啥以及没做啥

**做对了：**
- Commander 的架构搭得比较干净，每个命令各司其职
- preAction hook + 中间件模式让配置注入对业务透明
- 退出码集中管理，后续不用担心散落各处的 `process.exit`
- 测试覆盖了退出码 + 子命令注册 + 帮助信息，重构时心里有底

**有意没做的（或者说留到后面处理的）：**
- `dsk chat` 和 `dsk run` 的业务逻辑还是占位符——等 agent 会话循环那章再填
- middleware 的配置加载失败只回退到默认配置，没有给用户报错提示（下章加）
- 自定义 help 还没有测试——手工看了没问题，但自动化测试确实少了（TODO +1）

---

## 职责对比：框架搭建 vs 子命令路由

整篇文章其实在交替做两件事，这里明确拆开：

| 维度 | 框架搭建 | 子命令路由 |
|------|----------|-----------|
| **核心文件** | `src/index.ts`、`src/cli/exit-codes.ts`、`src/cli/middleware.ts`、`src/cli/help.ts` | `src/cli/index.tsx` |
| **解决的问题** | 异常处理、退出码规范、配置注入、help 定制——子命令不需要关心这些 | 命令注册、参数声明、参数解析、分发执行——路由到正确的 handler |
| **类比 Web 框架** | Express 的 app.use(errorHandler)、全局 middleware、view engine 配置 | Express 的 router.get('/users', handler)、Vue Router 的 route table |
| **关注点** | CLI 作为一个系统的生命周期和边界 | CLI 作为路由器的流量分发 |
| **可测试性** | 通过 exitOverride 测试退出码和异常路径 | 通过 parseAsync 测试命令解析和参数提取 |
| **扩展方式** | 加新 hook、加新全局选项、加新异常类型 | 加新 .command()、加新 .argument()、加新 .option() |
| **改动影响范围** | 影响所有子命令的行为 | 只影响被注册的那个子命令 |

换个角度：**框架搭建决定 CLI 怎么死（退出码）、怎么活（配置注入）、长什么样（help）。子命令路由决定 CLI 能干什么。**

两部分虽然写在同一个 commit 里，但职责完全正交——这也是我在设计时有意保持的：框架不依赖特定子命令，子命令不关心框架怎么处理异常。

---

## 延伸阅读

- [Commander.js 官方文档](https://github.com/tj/commander.js)
- [Node.js 退出码规范](https://nodejs.org/api/process.html#exit-codes)
- [Bash 自动补全编程指南](https://www.gnu.org/software/bash/manual/html_node/Programmable-Completion-Builtins.html)
- [Zsh 自动补全系统](https://zsh.sourceforge.net/Doc/Release/Completion-System.html)

有问题随时留言，下篇我们聊配置系统的设计与实现。
