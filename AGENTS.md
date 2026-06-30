# dskcode — 项目记忆

## 项目定位

dskcode 是一个基于 DeepSeek 的 AI 编程助手终端 CLI 工具，源自 Reasonix 的架构设计。用 TypeScript 从零实现，只面向国内用户。

## 关键约定

- **界面语言**：所有用户可见的描述性文字（命令帮助、提示信息、文档）使用**中文**。
- **命令标识**：CLI 命令名（`dskcode`、`chat`、`run`、`setup`）和选项名（`--verbose`、`--model`、`--version`）保持英文，这是 CLI 工具的通行做法。
- **代码注释**：注释使用中文，方便国内开发者阅读。
- **代码标识符**：变量名、函数名、接口名等代码标识符保持英文（TypeScript 语言规范）。

## 博客文档规范

> 适用范围：`ts-version/docs/` 下全部博客文章。

- **存放位置**：所有技术博客统一放在 `ts-version/docs/` 目录，不散落到仓库根或其他子目录。
- **文件命名**：采用 `blog-NN-主题.md` 格式，`NN` 为两位递增序号（接续已有编号，当前已到 `blog-08`），`主题` 用英文短横线连接的小写短语（如 `blog-09-tolf-crlf-fix.md`）。早期 `01-` / `02-` / `03-` 前缀为历史遗留，新文章一律用 `blog-` 前缀。
- **索引登记**：架构系列博客（01–15 章）在 `docs/docs.md` 的目录表格中登记状态；独立实战/排障类博客在 `docs/docs.md` 末尾「实战记录」分区追加条目，保持可发现性。
- **写作风格**：面向开发者，遵循 `technical-blog-writing` 技能的约定——开头给 TL;DR，语气像跟同事聊天，代码块带语言标识且可运行，坦诚讨论 trade-offs，避免营销话术和废话开场。
- **版本与日期**：涉及具体实现的文章，写清楚对应 commit 或依赖版本，避免教程随代码演进失效。

## 函数注释规范

> 适用范围：`src` 全部模块。

### 必须加 JSDoc 注释的对象

1. **类成员**：`public` 和 `private` 的 `getter` / `setter` / `method` / 静态方法
2. **导出接口（`export interface`）**：每个字段加一行说明
3. **导出类型别名（`export type`）**：视情况加整体说明
4. **构造函数**：说明参数、默认值、副作用

### 不需要加 JSDoc 的对象

- 文件级 `import` 块
- 显而易见的内部局部变量（一眼能看懂的）
- 已经用 `// 单行注释` 充分说明的"为什么"（why）类代码内注释

### JSDoc 注释结构（推荐）

每个函数 / 方法 / 接口的 JSDoc 应包含以下要素（按需精简，不必每条都写）：

```
/**
 * 简述（动词开头，1 句话讲清做什么）
 *
 * @param xxx — 参数说明
 * @param yyy — 参数说明
 * @returns 返回值说明
 * @throws  抛出异常的条件（如果有）
 * @yields 生成器 yield 的内容（如果是 async generator）
 *
 * @pure    — 标记纯函数 / 无副作用（可选）
 * @sideEffect — 标记副作用（写文件 / 改状态 / IO）
 */
```

### 中文 JSDoc 标签约定

- `@param` / `@returns` / `@throws` / `@yields` / `@field` — 英文标签（TS 工具识别友好）
- `@pure` / `@sideEffect` — 自定义标签，中文项目内通用
- 描述文字全部用中文，标点用中文全角（，；：。）与英文标点混排时保持可读即可

### 风格要求

- **第一句用动词**：「构建...」「执行...」「判定...」「刷新...」「列出...」「中止...」
- **解释"为什么"而不是"是什么"**：名称已经说明的就不用复述，重点讲清意图、约束、不变量
- **标注关键不变量**：例如"不拆散工具调用回合"、"只读才并行"、"abort 不会传播到子工具"
- **既有 `// ...` 注释保留**：解释"为什么"的代码内单行注释原样保留
- **不要复述类型签名**：`@field name: string — 工具名` 即可，不必写"这是一个字符串类型的字段"

### 反例（避免）

```ts
// ❌ 复述签名
/** id */
get id(): string { return this.#id; }

// ❌ 没有动作的描述
/** 工具执行器 */
class ToolExecutor { ... }

// ❌ 没说清何时用、为什么
/** 执行 batch */
async executeBatch(calls) { ... }
```

### 正例

```ts
// ✅ 第一句动词 + 关键不变量
/**
 * 执行一批工具调用。
 *
 * 自动选择并行 / 串行：
 * - 全部为只读工具 且 calls.length > 1：分批并行
 * - 其他：严格串行
 *
 * @sideEffect 调用 tool.execute；不修改 Session.messages
 */
async executeBatch(calls) { ... }

// ✅ 接口字段逐个解释
/**
 * 消息检查点信息（对外暴露给 UI 展示 /rewind 列表用）。
 *
 * @field index — 该 user 消息在 messages 数组中的索引
 * @field preview — 用户消息前 80 字
 * @field timestamp — checkpoint 创建时间（毫秒）
 * @field isGitRepo — 该检查点对应的工作区是否为 git 仓库
 */
export interface MessageCheckpointInfo { ... }
```

## 技术栈

- **运行时**：Node.js >= 22
- **语言**：TypeScript (ES2022, ESM)
- **CLI 框架**：commander
- **构建**：tsup (esbuild)
- **测试**：Vitest
- **包管理器**：npm

## 模型支持

- 仅支持 **DeepSeek-V4-Flash**（默认）和 **DeepSeek-V4-Pro** 两个模型
- 配置中 `providers[].model` 字段填写 `deepseek-v4-flash` 或 `deepseek-v4-pro`

## 模块架构

```
src/
├── index.ts          # 入口，shebang + 异常处理
├── cli/              # commander 命令路由
├── config/           # TOML 配置加载与合并
├── provider/         # LLM Provider 接口
├── tool/             # 内置工具接口
├── plugin/           # MCP 插件管理器
└── agent/            # Agent 会话循环
    ├── index.ts              # Session 协调者（瘦身后）
    ├── tool-executor.ts      # 纯执行层（并行/串行调度）
    ├── storm-detector.ts     # 纯判断层（连续失败风暴检测）
    ├── tool-definitions.ts   # 纯计算层（registry + mode → ToolDefinition[]）
    ├── message-builder.ts    # 纯计算层（trim / buildApiMessages）
    ├── system-prompt.ts      # 纯计算层（Handlebars 模板渲染）
    └── types.ts              # AgentEvent / SessionMode 等类型
```

> P0 拆分原则（已完成）：Session 类不再直接实现工具执行和风暴检测，
> 而是协调 4 个单一职责子模块（`ToolExecutor` / `StormDetector` /
> `buildToolDefinitions` / `trimMessages`），便于独立单测和未来扩展。

## 配置层级

1. 内置默认值
2. 用户全局 `~/.dskcode/settings.json`
3. 项目本地 `.dskcode/settings.json`
4. 环境变量
5. CLI flag

## 发布信息

- **npm 包名**：`dskcode`
- **bin 命令**：`dskcode`
- **使用方式**：`npx dskcode --version` 或 `npm install -g dskcode`

## Bug 与优化记录

> 适用范围：项目代码审查中发现的问题（bug 或可优化点）。

- **存放位置**：统一放在 `ts-version/bugfix/` 目录，不散落到仓库其他位置。
- **文件命名**：采用 `bugfix-NN-主题.md` 格式，`NN` 为两位递增序号（从 `01` 开始），`主题` 用英文短横线连接的小写短语（如 `bugfix-01-session-leak.md`）。
- **触发时机**：在阅读 / 修改代码时发现以下情况之一，就应写一份记录：
  - 明确的 bug（逻辑错误、资源泄漏、竞态、边界处理缺失等）。
  - 可优化的点（性能瓶颈、重复代码、命名混乱、不够健壮的错误处理等）。
- **文档结构**（按需精简，不必每条都写）：
  1. **TL;DR**：一句话讲清问题和建议改法。
  2. **现象 / 触发条件**：什么场景下会出现，如何复现。
  3. **根因分析**：定位到具体文件 / 函数 / 行号，说明为什么会有问题。
  4. **影响范围**：会影响哪些调用方、哪些场景。
  5. **建议方案**：可选，给出修复思路或 trade-offs 讨论。
  6. **关联文件**：列出受影响的文件路径，方便后续修复时定位。
- **写作要求**：附上定位到的具体文件路径与代码片段位置（函数名 / 行号），不要空泛描述；分析要落到代码证据上，避免主观猜测。
