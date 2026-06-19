# dskcode

> 基于 DeepSeek 的 AI 编程助手终端 CLI 工具。让 AI 直接在终端中理解你的代码、读写文件、执行命令。

[![npm version](https://img.shields.io/npm/v/dskcode)](https://www.npmjs.com/package/dskcode)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

---

## 特性

- **终端原生交互** — `dskcode chat` 进入交互式对话，在终端中直接与 AI 协作编码
- **一次性任务执行** — `dskcode run 重构所有 TODO 为 Jira 链接` 让 AI 自动完成
- **DeepSeek 深度集成** — 原生 DeepSeek API 支持，Prefix Cache 感知，成本透明
- **模型支持** — 仅支持 **DeepSeek-V4-Flash**（默认）和 **DeepSeek-V4-Pro** 两个模型
- **工具系统** — AI 可以读文件、写代码、执行命令、搜索代码，像人类开发者一样工作
- **MCP 插件** — 通过 Model Context Protocol 扩展任意外部工具
- **项目记忆** — AGENTS.md 让你的项目上下文被 AI 理解
- **权限控制** — 三级审批策略（Allow / Ask / Deny），安全可控
- **TOML 配置** — 多层级配置（全局 + 项目 + 环境变量 + CLI flag）
- **中文优先** — 界面提示、帮助信息、文档均为中文
- **内置小游戏** — `dskcode game` 启动游戏列表，打砖块、Coder Check 极速打字等内置游戏供休闲娱乐

![Brick Breaker — 经典打砖块游戏，10 个关卡可选](https://raw.githubusercontent.com/Awu12277/deepseek-agent-cli/refs/heads/main/public/brickbreaker_preview.gif)

![Coder Check — 极速打字游戏，消除编程单词](https://raw.githubusercontent.com/Awu12277/deepseek-agent-cli/refs/heads/main/public/codercheck_preview.gif)

## 快速开始

```bash
# 全局安装
npm install -g dskcode

# 查看帮助
dskcode --help

# 启动交互式对话
dskcode chat
```

### 使用 npx

```bash
npx dskcode --help
npx dskcode chat
```

## 命令

| 命令 | 说明 |
|------|------|
| `dskcode chat` | 启动交互式对话会话 |
| `dskcode run <prompt>` | 执行一次性任务（如"修改所有 TODO"） |
| `dskcode setup` | 运行配置向导，设置 API Key 等 |
| `dskcode init` | 在当前项目生成 AGENTS.md 项目记忆文件 |
| `dskcode game <name>` | 启动内置小游戏，不指定名称则显示交互式游戏列表 |
| `dskcode completion` | 生成 shell 自动补全配置 |

### 全局选项

| 选项 | 说明 |
|------|------|
| `-V, --version` | 显示版本号 |
| `--verbose` | 开启详细日志输出 |
| `--config <path>` | 指定配置文件路径 |
| `-h, --help` | 显示帮助信息 |

## 配置

dskcode 使用 JSON 格式的配置文件，支持多层级合并：

1. **内置默认值** — 无需配置即可运行
2. **用户全局** — `~/.dskcode/settings.json`
3. **项目本地** — 当前目录下的 `.dskcode/settings.json`
4. **环境变量** — 如 `DEEPSEEK_API_KEY`
5. **CLI flag** — 命令行参数优先级最高

### 配置示例

**全局配置（~/.dskcode/settings.json，存放个人密钥）：**

```json
{
  "defaultProvider": "deepseek",
  "providers": [
    {
      "name": "deepseek",
      "apiKey": "sk-xxx",
      "baseUrl": "https://api.deepseek.com",
      "model": "deepseek-v4-flash"
    }
  ]
}
```

**项目配置（.dskcode/settings.json，存放团队约定的行为参数）：**

```json
{
  "defaultProvider": "deepseek",
  "temperature": 0.3,
  "maxToolRounds": 30,
  "tools": [
    { "name": "read_file", "enabled": true },
    { "name": "write_file", "enabled": true },
    { "name": "bash", "enabled": true },
    { "name": "grep", "enabled": true }
  ]
}
```

## 架构

```
src/
├── index.ts          # 入口，shebang + 异常处理
├── cli/              # commander 命令路由
├── config/           # TOML 配置加载与合并
├── provider/         # LLM Provider 接口（DeepSeek / OpenAI 兼容）
├── tool/             # 内置工具接口（读文件、写文件、bash 等）
├── plugin/           # MCP 插件管理器
├── agent/            # Agent 会话循环
└── ui/               # Ink 交互式终端 UI
```

## 开发

```bash
# 克隆仓库（clone 后直接安装即可）
git clone https://github.com/Awu12277/deepseek-agent-cli.git

# 安装依赖
npm install

# 开发模式（自动监听重构建）
npm run dev

# 构建
npm run build

# 测试
npm test

# 类型检查
npm run type-check

# 代码检查
npm run lint
```

## 许可

[MIT](LICENSE)
