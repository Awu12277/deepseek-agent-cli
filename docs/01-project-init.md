# 从零开发 Agent CLI（一）：项目初始化与工程基建

> 本系列基于[Reasonix](https://github.com/esengine/DeepSeek-Reasonix)的架构设计，用 TypeScript 从零实现一个生产级的 AI 编程助手 CLI。本章先打好地基——从目录结构、tsconfig、ESLint、测试框架到构建流水线，一步到位。

---

## TL;DR

一个 CLI 项目的基础设施，看起来全是配置，踩坑了才知道疼。本文用实际代码带你搭一套**能直接上生产**的 TypeScript CLI 工程：

- ESM 双格式输出，`npx dsk` 直接跑
- 严格模式 tsconfig，类型安全拉满
- Vitest 测试 + ESLint flat config + Prettier
- tsup 单文件打包，< 2KB 产物
- 21 条测试覆盖，全部通过

最终效果：

```bash
$ node dist/index.js --help

Usage: dsk [options] [command]

基于 DeepSeek 的 AI 编程助手终端工具

Options:
  -V, --version              输出版本号
  --verbose                  开启详细日志输出
  -h, --help                 display help for command

Commands:
  chat                       启动交互式对话会话
  run [options] [prompt...]  执行一次性任务
  setup [options]            运行配置向导
```

## 前置条件

- **Node.js >= 18**（用到了原生 fetch 和 ESM）
- **npm**（或者 pnpm/yarn，本文用 npm）
- 基本的 TypeScript 和 Node.js 知识

## 为什么要有这一章

大部分 CLI 教程上来就写逻辑——`commander` 一把梭，代码全塞一个文件。写到后面你会发现：

- `tsconfig` 配错，CI 上类型校验过不去
- ESLint 配置还是 `.eslintrc` 老格式，跟新版 `typescript-eslint` 不兼容
- 打包出来产物巨大，`npx` 卡半天
- 没人敢重构，因为没测试

这一章就是把这些坑趟平了再开干。后面的每一章都会基于这个地基来加功能。

## 第一步：包管理与项目结构

```bash
mkdir ts-version && cd ts-version
npm init -y
```

然后改 `package.json`。CLI 项目的关键字段：

```json
{
  "name": "dsk",
  "version": "0.0.0",
  "type": "module",
  "bin": {
    "dsk": "./dist/index.js"
  },
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "engines": {
    "node": ">=18.0.0"
  }
}
```

几个设计选择，说说为什么：

**`"type": "module"`** 让 Node 把 `.js` 文件当作 ESM 处理。CLI 项目用 ESM 写 import/export 比 CJS 的 `require` 更清爽，而且 Node 18+ 的 ESM 支持已经很稳了。代价是少部分 CJS-only 的包用不了，但我们的依赖（`commander`、`smol-toml`）都支持 ESM。

**`bin.dsk`** 指向打包后的入口。`npx dsk` 就是执行这个文件。等发布到 npm，用户 `npm install -g dsk` 之后直接在终端敲 `dsk` 就能用。

**`exports`** 是 ESM 包的标配，限制外部只能 import 我们暴露的入口，防止别人 import 内部模块。

目录结构按模块分层：

```
src/
├── index.ts          # 入口，shebang + 异常处理
├── cli/              # commander 命令路由
├── config/           # TOML 配置加载与合并
├── provider/         # LLM Provider 接口
├── tool/             # 内置工具接口
├── plugin/           # MCP 插件管理器
└── agent/            # Agent 会话循环
```

每一层是一个独立的模块，依赖方向是单向的：`cli → {agent, config} → {tool, provider} → plugin`。后面几章会展开讲每个模块。

## 第二步：TypeScript 配置

`tsconfig.json` 是 TypeScript 项目的灵魂。配错了 IDE 不报错，CI 上才炸。这是我的配置：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "resolveJsonModule": true,
    "isolatedModules": true,

    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "forceConsistentCasingInFileNames": true,

    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "./dist",
    "rootDir": "./src",

    "esModuleInterop": true,
    "skipLibCheck": true,
    "verbatimModuleSyntax": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["dist", "node_modules", "tests"]
}
```

几个重点选项：

**`module: "NodeNext"` + `moduleResolution: "NodeNext"`** — 这是 Node 18+ ESM 的标准配置。TypeScript 会按照 Node 的 ESM 规则解析模块，import 必须带 `.js` 后缀。为什么带 `.js` 不是 `.ts`？因为 TypeScript 编译后产出 `.js` 文件，Node 在运行时找的是 `.js`。一开始不习惯，但这是 ESM 的正确姿势。

**`verbatimModuleSyntax: true`** — 强制你区分 type import 和 value import。`import type { Config }` 不会在运行时产生任何代码，纯类型擦除。习惯了这个之后，tsc 编译速度会有提升，因为类型擦除更干净。

**`noUncheckedIndexedAccess: true`** — 数组下标访问返回 `T | undefined`，强制你处理 `undefined` 的情况。CLI 工具最怕运行时突然炸个 `Cannot read properties of undefined`，这个选项能提前规避不少问题。

**`strict: true`** — 一键开启所有严格检查。这是 TypeScript 的卖点之一，不开严格模式不如用 JavaScript。

**`outDir` 和 `rootDir` 分开放** — `rootDir` 是 `src`，`outDir` 是 `dist`，产出的目录结构跟源码保持一致。

## 第三步：安装依赖

```bash
npm install commander smol-toml
```

两个运行时依赖：

- **commander** — Node CLI 框架。选它不选 yargs 的原因：commander 的 API 更直观（链式调用），TypeScript 支持好，社区活跃。yargs 的 `.parse()` 和 `.argv` 的行为在新手看来有点怪。
- **smol-toml** — TOML 解析器。选它不选 `@iarna/toml` 的原因：`smol-toml` 是纯 ESM 实现，跟我们的 `"type": "module"` 无缝兼容，而且体积只有 `@iarna/toml` 的四分之一。

开发依赖：

```bash
npm install -D typescript tsup vitest eslint prettier @types/node
npm install -D @eslint/js typescript-eslint
```

- **tsup** — 基于 esbuild 的打包器。秒级构建，对比 `tsc` 打包快了 10 倍以上。
- **vitest** — 测试框架。跟 Vite 共享配置格式，但独立运行不需要 Vite。
- **eslint + typescript-eslint** — 新版 flat config + 类型感知规则。

## 第四步：ESLint + Prettier

### ESLint flat config

新版 ESLint（v9+）统一用 `eslint.config.mjs`，不再支持 `.eslintrc`。`mjs` 后缀表示这是一个 ESM 模块文件：

```javascript
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/", "coverage/"] },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports" },
      ],
      "@typescript-eslint/no-import-type-side-effects": "error",

      "no-console": "off",
      "prefer-const": "error",
      "no-var": "error",
      eqeqeq: ["error", "always"],
    },
  },
);
```

`typescript-eslint` 的 v8 引入了 `tseslint.config()` 辅助函数，它自动处理了配置的合并逻辑，比 `export default [...]` 数组写法更安全。

`projectService: true` 是 v8 的新模式，ESLint 通过 Language Server 跟 TypeScript 交互。比旧的 `project: "./tsconfig.json"` 方式性能更好，而且不需要重新编译 tsconfig。

规则方面：

- `no-explicit-any` 设 warn 不设 error，因为跟外部 API 交互时偶尔需要 `any`，被阻止了挺烦的
- `no-unused-vars` 加了 `argsIgnorePattern` 忽略 `_` 开头的参数，这在 commander 的 action handler 里很常见
- `consistent-type-imports` 强制使用 `import type`，跟 `tsconfig` 的 `verbatimModuleSyntax` 配合

### Prettier

`.prettierrc`，越简洁越好：

```json
{
  "semi": true,
  "singleQuote": false,
  "trailingComma": "all",
  "printWidth": 90,
  "tabWidth": 2,
  "arrowParens": "always",
  "endOfLine": "lf"
}
```

双引号、分号、尾逗号，这些都是 TypeScript 项目的社区惯例。`printWidth: 90` 比默认的 80 宽一点，TypeScript 类型标注经常比较长，80 列经常换行。`endOfLine: lf` 确保 Windows 和 macOS 上格式一致。

## 第五步：cli 入口与 commander 外壳

先写 `src/cli/index.ts`，这是 CLI 的路由层：

```typescript
import { Command } from "commander";

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

  // 子命令: chat
  program
    .command("chat")
    .description("启动交互式对话会话")
    .action(async () => {
      console.log("dsk chat — 待实现（第07章）");
    });

  // 子命令: run
  program
    .command("run")
    .description("执行一次性任务")
    .argument("[prompt...]", "任务描述")
    .option("--model <name>", "指定使用的模型")
    .action(async (_prompt: string[]) => {
      console.log("dsk run — 待实现（第07章）");
    });

  // 子命令: setup
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
```

**为什么用 `exitOverride()`？**

commander 默认在 `--help` 和 `--version` 时调用 `process.exit(0)`。这在生产环境没问题，但测试时一调 `process.exit()`，vitest 进程就直接退出了，测不了。`exitOverride()` 把 `process.exit()` 替换成抛 `CommanderError`，测试可以 catch 这个 error 来验证。

入口文件 `src/index.ts` 负责处理这个异常：

```typescript
#!/usr/bin/env node

import { createCli } from "./cli/index.js";

const program = createCli();

try {
  await program.parseAsync(process.argv);
} catch (err: unknown) {
  const error = err as { exitCode?: number; code?: string };
  if (error.code === "commander.helpDisplayed" || error.code === "commander.version") {
    process.exit(error.exitCode ?? 0);
  }
  console.error(String(err));
  process.exit(1);
}
```

`#!` shebang 让操作系统知道这是 Node.js 脚本。打包后 `dist/index.js` 的第一行就是这个，所以 `npx dsk` 能直接执行。

## 第六步：接口定义（给后面章节搭架子）

先把核心接口定义好，后面的章节直接 import 来用：

### Provider 接口

```typescript
// src/provider/index.ts

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  name?: string;
}

export interface ChatOptions {
  signal?: AbortSignal;
  maxTokens?: number;
  temperature?: number;
}

export interface ChatChunk {
  content: string;
  finishReason: "stop" | "tool_calls" | "length" | null;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    cachedPromptTokens?: number;
  };
}

export interface Provider {
  readonly name: string;
  chat(
    messages: ChatMessage[],
    opts?: ChatOptions,
  ): AsyncIterable<ChatChunk>;
  model(): string;
}
```

`chat` 返回 `AsyncIterable<ChatChunk>` 而不是 `Promise<string>`，因为 LLM 是流式输出的。调用方可以 `for await (const chunk of provider.chat(...))` 逐块渲染到终端。

### Tool 接口

```typescript
// src/tool/index.ts

export interface JSONSchema {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolContext {
  cwd: string;
  signal?: AbortSignal;
}

export interface ToolResult {
  success: boolean;
  data: string;
  error?: string;
}

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly parameters: JSONSchema;
  execute(args: unknown, ctx: ToolContext): Promise<ToolResult>;
}
```

`parameters` 用 JSONSchema 描述参数，LLM 通过这个 schema 知道怎么调用工具。

### Config 类型

```typescript
// src/config/types.ts

export interface ProviderConfig {
  name: string;
  baseUrl?: string;
  apiKey?: string;
  model: string;
}

export interface ToolConfig {
  name: string;
  enabled: boolean;
}

export interface PluginConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface Config {
  defaultProvider: string;
  providers: ProviderConfig[];
  tools: ToolConfig[];
  plugins: PluginConfig[];
}
```

对应的默认配置加载器：

```typescript
// src/config/loader.ts

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "smol-toml";
import type { Config } from "./types.js";

export const defaultConfig: Config = {
  defaultProvider: "deepseek",
  providers: [
    {
      name: "deepseek",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-chat",
    },
  ],
  tools: [
    { name: "read_file", enabled: true },
    { name: "write_file", enabled: true },
    { name: "edit_file", enabled: true },
    { name: "bash", enabled: true },
    { name: "glob", enabled: true },
    { name: "grep", enabled: true },
    { name: "ls", enabled: true },
    { name: "fetch", enabled: true },
  ],
  plugins: [],
};

export async function loadConfig(configPath?: string): Promise<Config> {
  const candidates: string[] = [];

  if (configPath) {
    candidates.push(configPath);
  } else {
    candidates.push(
      join(process.env.HOME ?? process.env.USERPROFILE ?? "~", ".config", "dsk.toml"),
      join(process.cwd(), ".dsk.toml"),
    );
  }

  let config: Config = structuredClone(defaultConfig);

  for (const candidate of candidates) {
    try {
      const raw = await readFile(candidate, "utf-8");
      const parsed = parse(raw) as unknown as Partial<Config>;
      config = mergeConfig(config, parsed);
    } catch {
      // 文件不存在或无法读取 — 跳过
    }
  }

  return config;
}

function mergeConfig(base: Config, overlay: Partial<Config>): Config {
  return {
    ...base,
    ...(overlay.defaultProvider !== undefined && { defaultProvider: overlay.defaultProvider }),
    ...(overlay.providers !== undefined && { providers: overlay.providers }),
    ...(overlay.tools !== undefined && { tools: overlay.tools }),
    ...(overlay.plugins !== undefined && { plugins: overlay.plugins }),
  };
}
```

配置加载顺序（后加载的覆盖前面的）：
1. 内置默认值
2. 用户全局 `~/.config/dsk.toml`
3. 项目本地 `.dsk.toml`

`structuredClone` 做深拷贝，防止多个 `loadConfig` 调用共享同一个 `defaultConfig` 对象。

## 第七步：构建配置（tsup）

`tsup.config.ts`：

```typescript
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node18",
  clean: true,
  dts: true,
  sourcemap: true,
  minify: process.env.NODE_ENV === "production",
  shims: true,
});
```

**`format: ["esm"]`** — 只产 ESM 格式。既然是 Node 18+，不需要兼容 CJS。

**`dts: true`** — 生成 `.d.ts` 声明文件，方便被其他 ESM 项目 import。

**`clean: true`** — 打包前清空 `dist/`，避免旧文件残留。

**`shims: true`** — tsup 会注入一些 polyfill，比如 `__dirname`、`__filename` 的 ESM 兼容实现。虽然我们尽量不用这些 CommonJS 遗留变量，但 commander 等依赖可能用到。

**`minify: process.env.NODE_ENV === "production"`** — 开发阶段不做压缩，方便调试。发布时才压缩。

## 第八步：Vitest 测试

`vitest.config.ts` 配置：

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "lcov"],
    },
  },
});
```

`globals: true` — 在测试文件中直接写 `describe`、`it`、`expect`，不用手动 import。这是个人偏好，团队项目可能倾向于显式 import 更清晰。

一共写了 21 条测试。来看看几个有代表性的：

### CLI 命令注册测试

```typescript
import { describe, it, expect } from "vitest";
import { createCli } from "../src/cli/index.js";

describe("createCli", () => {
  const cli = createCli();

  it("should return a Command instance with name dsk", () => {
    expect(cli.name()).toBe("dsk");
  });

  it("should register the chat subcommand", () => {
    const chatCmd = cli.commands.find((c) => c.name() === "chat");
    expect(chatCmd).toBeDefined();
    expect(chatCmd!.description()).toBe("启动交互式对话会话");
  });

  it("should output help with --help", async () => {
    // exitOverride 让 Commander 抛 CommanderError，exitCode 为 0
    await expect(
      cli.parseAsync(["node", "dsk", "--help"]),
    ).rejects.toMatchObject({ exitCode: 0 });
  });
});
```

这里用到了 commander 的 `exitOverride` 特性。`parseAsync(["node", "dsk", "--help"])` 在正常模式下会调用 `process.exit(0)`，vitest 进程会被杀掉。加了 `exitOverride` 后，`parseAsync` 返回的 Promise 会 reject 一个 `CommanderError`，我们在测试中断言 `exitCode: 0` 即可。

### 配置结构测试

```typescript
describe("defaultConfig", () => {
  it("should list all 8 built-in tools", () => {
    expect(defaultConfig.tools).toHaveLength(8);
    const names = defaultConfig.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "bash", "edit_file", "fetch", "glob",
      "grep", "ls", "read_file", "write_file",
    ]);
  });
});
```

这种测试看起来"简单到没必要写"，但它的真正价值是**回归保护**——以后有人不小心改掉了默认配置，测试会第一时间告诉你。

### 类型完整性测试

```typescript
it("Tool interface is structurally sound", () => {
  const mock: Tool = {
    name: "echo",
    description: "echoes input",
    parameters: { type: "object", properties: {} },
    execute: async (_args: unknown, _ctx: ToolContext) => ({
      success: true,
      data: "pong",
    }),
  };
  expect(mock.name).toBe("echo");
});
```

这种测试一半是类型检查（TypeScript 编译期验证接口结构），一半是运行时验证（确保 mock 对象能正常工作）。后面写工具实现的时候，这个 mock 可以直接复用。

## 跑一下验证

```bash
# 安装依赖
npm install

# 21 条测试全部通过
npm test

# 类型检查
npm run type-check

# 构建
npm run build

# 运行 CLI
node dist/index.js --help
node dist/index.js --version
node dist/index.js chat
```

测试输出长这样：

```
 ✓ tests/types.test.ts (9 tests) 4ms
 ✓ tests/cli.test.ts (8 tests) 6ms
 ✓ tests/config.test.ts (4 tests) 3ms

 Test Files  3 passed (3)
      Tests  21 passed (21)
```

构建产物：

```
ESM dist\index.js     1.42 KB
ESM dist\index.js.map 3.43 KB
DTS dist\index.d.ts   20.00 B
```

1.42KB，对于一个 CLI 项目来说，这点体积负担几乎可以忽略。esbuild 把 commander 和 smol-toml 都打包进去了。

## 项目记忆（AGENTS.md）

最后，创建一个 `AGENTS.md` 文件，记录项目的关键约定。这个文件会被后续的 agent 自动读取，作为项目上下文：

```markdown
# dsk — 项目记忆

## 关键约定

- **界面语言**：所有用户可见的描述性文字使用中文。
- **命令标识**：CLI 命令名和选项名保持英文。
- **代码注释**：注释使用中文。
- **代码标识符**：变量名、函数名、接口名保持英文。

## 技术栈

- Node.js >= 18, TypeScript (ES2022, ESM)
- CLI: commander, 配置: smol-toml
- 构建: tsup, 测试: Vitest
- API: 原生 fetch (Node 18+)

## 配置层级

1. 内置默认值
2. 用户全局 ~/.config/dsk.toml
3. 项目本地 .dsk.toml
```

## 总结

这一章结束后，我们有了：

| 能力 | 工具/配置 | 状态 |
|------|-----------|------|
| CLI 框架 | commander (chat/run/setup) | ✅ 骨架完成 |
| 配置加载 | smol-toml + 分层合并 | ✅ 接口就绪 |
| 类型安全 | strict tsconfig + typescript-eslint | ✅ 全面覆盖 |
| 测试 | Vitest，21 条 | ✅ 全部通过 |
| 构建 | tsup，1.42KB 产物 | ✅ 一步打包 |
| 代码规范 | ESLint + Prettier | ✅ 自动化 |
| 项目记忆 | AGENTS.md | ✅ 记录约定 |

当前代码仓库：[dsk/src](https://github.com/esengine/DeepSeek-Reasonix/tree/main/ts-version)

## 下期预告

下一章会实现 CLI 框架的完整子命令路由 —— 包括命令参数解析、全局 middleware、退出码规范和 shell 自动补全。

有问题欢迎留言讨论。

## 延伸阅读

- [Commander.js 官方文档](https://github.com/tj/commander.js)
- [TypeScript ESM 官方指南](https://www.typescriptlang.org/docs/handbook/esm-node.html)
- [typescript-eslint v8 迁移指南](https://typescript-eslint.io/blog/announcing-typescript-eslint-v8)
- [tsup 配置参考](https://tsup.egoist.dev/)
- [Vitest 入门](https://vitest.dev/guide/)
