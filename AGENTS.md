# dskcode — 项目记忆

## 项目定位

dskcode 是一个基于 DeepSeek 的 AI 编程助手终端 CLI 工具，源自 Reasonix 的架构设计。用 TypeScript 从零实现，只面向国内用户。

## 关键约定

- **界面语言**：所有用户可见的描述性文字（命令帮助、提示信息、文档）使用**中文**。
- **命令标识**：CLI 命令名（`dskcode`、`chat`、`run`、`setup`）和选项名（`--verbose`、`--model`、`--version`）保持英文，这是 CLI 工具的通行做法。
- **代码注释**：注释使用中文，方便国内开发者阅读。
- **代码标识符**：变量名、函数名、接口名等代码标识符保持英文（TypeScript 语言规范）。

## 技术栈

- **运行时**：Node.js >= 18
- **语言**：TypeScript (ES2022, ESM)
- **CLI 框架**：commander
- **配置解析**：smol-toml
- **构建**：tsup (esbuild)
- **测试**：Vitest
- **包管理器**：npm

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
```

## 配置层级

1. 内置默认值
2. 用户全局 `~/.config/dskcode.toml`
3. 项目本地 `.dskcode.toml`
4. 环境变量
5. CLI flag

## 发布信息

- **npm 包名**：`dskcode`
- **bin 命令**：`dskcode`
- **使用方式**：`npx dskcode --version` 或 `npm install -g dskcode`
