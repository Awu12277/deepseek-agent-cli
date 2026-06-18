# 从零开发 TypeScript 版 Agent CLI 系列博客

> 本系列基于 [Reasonix](https://github.com/esengine/DeepSeek-Reasonix) 的架构设计，从零开始用 TypeScript 构建一个生产级的 AI 编程助手 CLI 工具。贯穿单体 CLI 设计、LLM 集成、插件系统等核心主题。

---

## 目录

| # | 章节 | 核心内容 |
|---|------|----------|
| 01 | [项目初始化与工程基建](#01-项目初始化与工程基建) | monorepo 结构、tsconfig、ESM/CJS、lint、test |
| 02 | [CLI 框架搭建与子命令路由](#02-cli-框架搭建与子命令路由) | commander + inquirer、chat/run/setup 子命令 |
| 03 | [配置系统：TOML 加载与分层合并](#03-配置系统toml-加载与分层合并) | 多级配置文件、flag 覆盖、环境变量 |
| 04 | [Provider 抽象层与多模型支持](#04-provider-抽象层与多模型支持) | Provider 接口、DeepSeek/OpenAI 适配器、工厂注册 |
| 05 | [LLM API 客户端：流式补全与错误处理](#05-llm-api-客户端流式补全与错误处理) | fetch SSE、AbortController、超时重试 |
| 06 | [Token 计价与成本追踪系统](#06-token-计价与成本追踪系统) | 消耗记录、Prefix Cache 优化、累计统计 |
| 07 | [Agent 主循环：消息编排与多轮对话](#07-agent-主循环消息编排与多轮对话) | System/User/Assistant/Tool 消息组装、轮次控制 |
| 08 | [工具系统：内置工具的设计与注册](#08-工具系统内置工具的设计与注册) | Tool 接口、Registry 模式、文件操作 / Bash / Grep |
| 09 | [MCP 插件系统：stdio JSON-RPC 协议](#09-mcp-插件系统stdio-json-rpc-协议) | 子进程管理、JSON-RPC 编解码、生命周期 |
| 10 | [权限控制：逐调用审批策略](#10-权限控制逐调用审批策略) | Allow/Ask/Deny 三级策略、交互式审批 |
| 11 | [会话管理与项目记忆](#11-会话管理与项目记忆) | 对话历史持久化、AGENTS.md 上下文注入 |
| 12 | [终端交互：流式渲染与彩色输出](#12-终端交互流式渲染与彩色输出) | 打字机效果、spinner、markdown 渲染 |
| 13 | [管道模式与 stdin/stdout 集成](#13-管道模式与-stdinstdout-集成) | pipe 输入、非交互模式、Unix 哲学 |
| 14 | [配置向导与初次运行体验](#14-配置向导与初次运行体验) | 交互式 setup、API Key 管理、环境检测 |
| 15 | [构建发布与 CI/CD 流水线](#15-构建发布与cicd-流水线) | tsup 打包、npm publish、GitHub Actions、跨平台 |

---

## 01 项目初始化与工程基建

建立 TypeScript CLI 项目的完整基础设施。

- **包管理选型**：pnpm workspace 还是 bun？monorepo vs single package
- **tsconfig 配置**：`target: ES2022`、`module: NodeNext`、`moduleResolution: NodeNext`
- **ESM 与 CJS**：双格式输出策略，`exports` 字段配置
- **Lint & Format**：ESLint flat config + Prettier + 自定义规则
- **测试框架**：Vitest 单测 + tsx 执行 ESM
- **目录结构设计**：`src/` 分层（`cli/` `agent/` `provider/` `tool/` `plugin/` `config/`）
- **依赖选型**：最小依赖原则，只有 `commander` `smol-toml` 等少数核心依赖
- **构建工具**：tsup 打包为单文件 CLI（esbuild 底座）
- **入口与 shebang**：`#!/usr/bin/env node` + `bin` 字段

## 02 CLI 框架搭建与子命令路由

设计 CLI 的外壳：命令解析、全局选项、子命令分发。

- **框架选型**：commander vs yargs vs citty，选择 commander 的原因
- **顶层入口**：`reasonix` 主命令，全局 `--version` `--verbose` `--config`
- **子命令体系**：
  - `chat` — 交互式对话
  - `run` — 一次性任务执行
  - `setup` — 配置向导
  - `init` — 生成 AGENTS.md
- **全局中间件**：配置加载、鉴权检查、日志初始化
- **退出码规范**：0=成功 1=通用错误 2=配置错误 130=SIGINT
- **帮助信息**：自定义 help 格式化，彩色输出
- **自动补全**：commander 内置的 shell completion

## 03 配置系统：TOML 加载与分层合并

构建健壮的多级配置体系，支持从全局到项目的逐层覆盖。

- **TOML 解析**：为什么选 `smol-toml` 而非 `@iarna/toml`
- **配置层级**：默认值 → 用户全局 `~/.config/reasonix.toml` → 项目 `.reasonix.toml` → 环境变量 → CLI flag
- **配置合并**：deepMerge 策略，数组 vs 对象的合并规则
- **配置类型**：用 TypeScript 类型定义完整的 Config 结构体
- **Provider 声明**：多个 provider 的配置格式（apiKey、baseUrl、model 映射）
- **Tool 开关**：默认配置中启用/禁用工具
- **Plugin 声明**：外部 MCP 服务器配置
- **配置校验**：必填字段检查，友好的错误提示
- **配置热加载**：watch 模式检测文件变更

## 04 Provider 抽象层与多模型支持

设计 Provider 接口，支持 DeepSeek、OpenAI 兼容接口等多种后端。

- **Provider 接口设计**：

  ```typescript
  interface Provider {
    name: string
    chat(messages: Message[], opts: ChatOptions): AsyncIterable<Chunk>
    countTokens(text: string): number
    model(): string
  }
  ```

- **工厂注册模式**：`registry.register('deepseek', DeepSeekProvider)` + `registry.get('deepseek')`
- **DeepSeek Provider**：DeepSeek API 适配，prefix cache 感知
- **OpenAI 兼容 Provider**：通用 OpenAI 适配器，支持任意 baseUrl
- **双模型模式**：executor + planner 分离，独立缓存会话
- **模型预设**：内置 `deepseek-flash` `deepseek-pro` `mimo-pro` 预设
- **错误映射**：HTTP 状态码 → 结构化错误（auth / rate-limit / server-error）

## 05 LLM API 客户端：流式补全与错误处理

实现底层的 API 通信层，确保流式传输稳定可靠。

- **Fetch 封装**：原生 `fetch` vs `undici`，Node 18+ 兼容策略
- **SSE 流式解析**：手动解析 `data: ...` 事件流，处理 `[DONE]` 标记
- **AsyncGenerator**：用 `async function*` 暴露流式块
- **AbortController**：用户 Ctrl+C 中断请求
- **超时控制**：连接超时 + 流式空闲超时
- **指数退避重试**：429 / 5xx 自动重试
- **请求合并**：同一轮对话的 token 统计汇总
- **Types 定义**：ChatCompletionRequest / Chunk / Usage 等完整类型

## 06 Token 计价与成本追踪系统

LLM 成本透明化，让用户清楚每次调用的开销。

- **Token 统计**：`usage.prompt_tokens` + `usage.completion_tokens`
- **计价模型**：不同 model 的不同单价表（输入/输出/缓存命中）
- **Prefix Cache**：DeepSeek 专属优化，缓存命中的 token 半价
- **会话累计成本**：单次会话的 token 和费用累加
- **成本显示**：每次工具调用后显示 ≈$0.0032 格式
- **预算限制**：配置最大成本/最大 token 数，自动中止
- **持久化历史**：历史会话的成本查询

## 07 Agent 主循环：消息编排与多轮对话

Agent 的核心——消息构建、循环控制、工具决策。

- **消息结构**：SystemMessage / UserMessage / AssistantMessage / ToolMessage
- **System Prompt 构建**：动态注入 AGENTS.md、可用工具描述、时间信息
- **主循环流程**：

  ```
  user input → build messages → call provider →
  parse response → has tool calls? → execute tools → append results → loop
  ```

- **最大轮次保护**：`max_tool_rounds` 防止无限循环
- **终止条件判断**：模型返回最终答案 or 达到轮次上限
- **上下文窗口管理**：超出 max_tokens 时自动裁剪历史
- **多轮消息组装**：append 模式，保持完整上下文

## 08 工具系统：内置工具的设计与注册

构建类型安全、可扩展的工具系统，是 Agent 能力的核心。

- **Tool 接口**：

  ```typescript
  interface Tool {
    name: string
    description: string
    parameters: JSONSchema
    execute(args: unknown, ctx: ToolContext): Promise<ToolResult>
  }
  ```

- **JSON Schema 定义**：parameters 用 JSONSchema 描述，供模型理解
- **Registry 注册机制**：`ToolRegistry.register(tool)` + `ToolRegistry.list()`
- **内置工具列表**：
  - `read_file` — 读取文件
  - `write_file` — 写入/修改文件
  - `edit_file` — 精确替换
  - `bash` — 执行 shell 命令
  - `glob` — 文件搜索
  - `grep` — 内容搜索
  - `ls` — 目录列表
  - `fetch` — HTTP 请求
- **工具执行沙箱**：当前工作目录约束、超时控制
- **toolUse 解析**：从模型响应中解析 function_call / tool_use

## 09 MCP 插件系统：stdio JSON-RPC 协议

支持 MCP（Model Context Protocol）插件，扩展外部工具。

- **MCP 协议概览**：JSON-RPC 2.0 over stdio
- **子进程管理**：`child_process.spawn()` 启动插件进程
- **生命周期**：initialize → listTools → callTool → shutdown
- **传输层**：stdin 写入请求，stdout 读取响应（行分隔 JSON）
- **请求/响应匹配**：JSON-RPC `id` 字段关联
- **适配器转换**：MCP Tool → 系统 Tool 接口适配
- **插件声明配置**：`[[plugin]]` TOML 配置段
- **错误处理**：插件崩溃自动恢复、超时机制
- **参考实现**：编写一个 `reasonix-plugin-example`

## 10 权限控制：逐调用审批策略

安全执行机制，防止危险操作未经用户确认。

- **三级权限策略**：

  ```
  Allow — 自动批准（白名单命令）
  Ask — 每次询问用户（默认）
  Deny — 禁止执行（黑名单）
  ```

- **策略匹配规则**：工具名 + 参数模式匹配
- **交互式审批**：确认/拒绝/永久记住，彩色提示
- **允许列表**：`read_file` `grep` `glob` 默认 allow
- **询问列表**：`write_file` `edit_file` `bash` `fetch` 默认 ask
- **拒绝列表**：`rm -rf /` 等危险命令正则匹配
- **Policy 引擎**：`PermissionPolicy.shouldAllow(tool, args) → Decision`
- **Session 级记住**：一次会话内不再重复询问

## 11 会话管理与项目记忆

持久化对话上下文，让 Agent 记住项目信息。

- **会话文件结构**：`.reasonix/sessions/*.json`
- **消息序列化**：完整消息历史存入磁盘
- **项目记忆（AGENTS.md）**：自动生成项目上下文文件
- **`/init` 命令**：扫描项目结构，生成初始 AGENTS.md
- **AGENTS.md 注入**：系统提示词末尾注入项目记忆
- **会话恢复**：`--resume` 会话 ID 恢复历史
- **自动清理**：超过 `max_sessions` 自动淘汰
- **Session ID 生成**：UUID + 时间戳

## 12 终端交互：流式渲染与彩色输出

打造丝滑的终端体验。

- **打字机效果**：逐块叠加文本，无闪烁
- **Spinner 动画**：等待 LLM/Tool 响应时的进度指示
- **Markdown 渲染**：使用 `marked` + `terminal-link` 渲染内联代码和链接
- **代码块高亮**：行号 + 语法高亮（shiki light）
- **彩色输出**：chalk / picocolors 的颜色方案
- **Tool 调用可视化**：嵌套缩进展示工具调用链
- **进度条**：长耗时工具调用的进度指示
- **多行刷新**：`process.stdout.write` + `\r` 实现原位更新

## 13 管道模式与 stdin/stdout 集成

让 CLI 遵循 Unix 哲学：做好一件事，支持管道组合。

- **Pipe 输入检测**：`isTTY` 判断是否管道输入
- **非交互模式**：单条输入，单次输出
- **`echo "explain this" | reasonix run`**：管道输入处理
- **JSON 输出模式**：`--json` 输出结构化结果
- **静默模式**：`--silent` 仅输出最终结果
- **stdin 流处理**：大文件管道输入的分块读取
- **与 jq 组合**：`reasonix run --json | jq .files[].path`

## 14 配置向导与初次运行体验

降低新用户的上手门槛，提供友好的初次运行体验。

- **`reasonix setup` 命令**：
  - 检测 `DEEPSEEK_API_KEY` 环境变量
  - 交互式填写 API Key（inquirer password 模式）
  - 选择默认模型（flash / pro）
  - 选择工作目录
- **一键测试**：`reasonix setup --test` 发送测试请求验证
- **`.env` 文件支持**：自动生成 `.env.example`
- **`.gitignore` 集成**：自动添加 `.env` 到 gitignore
- **首次运行检测**：无配置时自动跳转 setup
- **配置导出**：`reasonix setup --export` 输出 JSON 格式配置
- **`reasonix doctor`**：诊断环境问题（API Key、网络、Node 版本）

## 15 构建发布与 CI/CD 流水线

从源码到 npm 包的完整发布流程。

- **构建配置（tsup）**：
  - `entry: src/index.ts`
  - `target: node18`
  - `format: ['esm', 'cjs']`
  - minify + bundle 单文件
- **npm 包配置**：
  - `bin` 字段
  - `exports` 条件导出
  - `files` 白名单
- **GitHub Actions CI**：
  - lint + type-check + test
  - ESM/CJS 兼容性测试
  - 跨平台 Node 版本矩阵
- **自动发布**：
  - `semantic-release` + commitlint
  - npm publish 自动化
  - Changelog 自动生成
- **发布检查清单**：手动发布前的完整性自检
- **版本策略**：SemVer + 预发布标签

---

> **下篇预告**：各章节完成时将附带完整的代码仓库链接和可运行示例。
> 欢迎 Star & PR！
