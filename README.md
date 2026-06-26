# dskcode

> 基于 DeepSeek 的 AI 编程助手终端 CLI 工具。让 AI 直接在终端中理解你的代码、读写文件、执行命令。

[![npm version](https://img.shields.io/npm/v/dskcode)](https://www.npmjs.com/package/dskcode)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

![dskcode](https://raw.githubusercontent.com/Awu12277/deepseek-agent-cli/refs/heads/main/public/dskcoderun.gif)
---

## 特性

- **终端原生交互** — `dskcode chat` 进入交互式对话，在终端中直接与 AI 协作编码 ✅
- **一次性任务执行** — `dskcode run` 让 AI 自动完成任务 ✅
- **DeepSeek 深度集成** — 原生 DeepSeek API 支持，Prefix Cache 感知，成本透明 ✅
- **模型支持** — 支持 **DeepSeek-V4-Flash**（默认）和 **DeepSeek-V4-Pro** 两个模型 ✅
- **工具系统** — 10 个内置工具（read_file / write_file / edit_file / multi_edit / delete_range / bash / glob / grep / ls / fetch），Agent 可读写文件、执行命令、搜索代码 ✅
- **文件回退（/rewind）** — 每轮对话自动生成 git stash 检查点，**`/rewind 1` 一键撤回最新修改**，也可选择模式的回到任意历史状态 ✅
- **/rewind 提示** — 对话结束后 2s 在原状态栏位置自动出现「↩ /rewind 1 可撤回本次修改」，直到下一轮对话开始 ✅
- **计划模式** — `/plan` 切换到计划模式（紫色主题），让 AI 先分析再编码，适合复杂任务 ✅
- **高级设置** — `/thinking` 切换深度思考、`/effort` 切换推理等级 High/Max、`/toolchoice` 控制工具调用策略 ✅
- **会话持久化** — 对话自动保存到磁盘，Session.resume 恢复历史会话，支持 rewind 回退到任意对话节点 ✅
- **命令提示轮播** — 输入框上方自动轮播可用命令提示，底部命令提示条混洗展示 ✅
- **MCP 插件** — 通过 Model Context Protocol 扩展任意外部工具 ⚡ 骨架就绪
- **项目记忆** — AGENTS.md 注入系统提示词 ❌ 持久化未完成
- **权限控制** — 三级审批策略（Allow / Ask / Deny），安全可控 ❌ 未开始
- **JSON 配置** — 多层级配置（全局 + 项目 + 环境变量 + CLI flag） ✅
- **中文优先** — 界面提示、帮助信息、文档均为中文 ✅
- **Token 计价** — 会话级 / 日级 / 历史级三层成本统计，Prefix Cache 半价计费 ✅
- **流式渲染** — 打字机效果、spinner、代码块高亮、工具调用可视化 ✅
- **股票行情** — `dskcode stock` 交互式 A 股行情终端，键盘选择 + 详情折线图 + 每 10 秒自动刷新 ✅

![股票列表](https://raw.githubusercontent.com/Awu12277/deepseek-agent-cli/refs/heads/main/public/stock_list.png)

![股票详情](https://raw.githubusercontent.com/Awu12277/deepseek-agent-cli/refs/heads/main/public/stock_detail.png)

- **内置小游戏** — `dskcode game` 启动游戏列表，打砖块、Coder Check 极速打字等内置游戏供休闲娱乐 ✅

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
| `dskcode stock [codes...]` | 交互式股票行情，↑/↓ 选择，Enter 查看分时折线图，5s 倒计时自动刷新 |
| `dskcode stock sh000001 sz399006` | 查看指定股票行情 |
| `dskcode completion` | 生成 shell 自动补全配置 |

### 全局选项

| 选项 | 说明 |
|------|------|
| `-V, --version` | 显示版本号 |
| `--verbose` | 开启详细日志输出 |
| `--config <path>` | 指定配置文件路径 |
| `-h, --help` | 显示帮助信息 |

## 交互式 Chat 命令

在 `dskcode chat` 会话中输入以下命令（按 `/help` 查看所有可用命令）：

| 命令 | 说明 |
|------|------|
| `/rewind` | 进入选择模式 ↑↓ 选择检查点回退；`/rewind 1` 直接撤回最新一轮（1=最新，2=上一次…） |
| `/plan` | 切换为计划模式（紫色主题），AI 先分析需求再逐步编码 |
| `/code` | 切换回代码模式 |
| `/thinking` | 切换深度思考（DeepSeek 原生推理能力） |
| `/effort` | 切换推理等级 High / Max |
| `/toolchoice` | 切换工具调用策略（auto / required / none） |
| `/model` | 切换模型（DeepSeek-V4-Flash / DeepSeek-V4-Pro） |
| `/clear` | 清空当前对话历史 |
| `/help` | 查看所有可用命令 |
| `/version` | 显示版本信息 |
| `/game` | 启动内置小游戏 |
| `/stock` | 跳转到股票行情 |

对话结束后若 AI 修改了文件，2 秒后原 spinner 位置会自动出现提示：

```
↩ /rewind 1 可撤回本次修改
```

该提示一直保留到下一轮对话开始，方便随时撤回最新一轮文件修改。

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

### 股票行情

`dskcode stock` 启动交互式股票行情终端，基于腾讯免费行情接口，支持实时查看 A 股/指数/ETF 行情。

#### 功能

- **实时行情列表** — 涨跌彩色标识（红涨绿跌），显示最新价、涨跌幅、最高/最低价、成交量
- **键盘选择** — `↑/↓` 切换股票，`Enter` 查看详情
- **分时折线图** — 详情页展示最近 60 笔分钟线的 ASCII 折线图（直角折线风格）
- **自动刷新** — 列表 5s 倒计时自动刷新，详情页 10s 倒计时自动刷新，右上角显示倒计时
- **手动刷新** — 按 `r` 键强制刷新
- **自选股配置** — 首次运行自动在 `~/.dskcode/settings.json` 生成默认自选股，界面底部提示编辑路径

#### 使用方式

```bash
# 首次运行自动生成自选股配置，默认: 上证指数 + 沪深300 + 紫金矿业
dskcode stock

# 指定股票代码
 dskcode stock sh000001 sz399006 sh601688
```

#### 示例界面

```
  📈 自选股监控                      5s 后自动刷新
   代码     名称         最新价     涨跌幅     涨跌额    最高      最低     成交量
   ────────────────────────────────────────────────────────────────────────────
   ▸ sh000001 上证指数   3150.00   +0.35%   +11.02   3160.00  3140.00  28543.0万
     sz399006 创业板指   1820.00   -0.52%    -9.50   1835.00  1815.00  9865.0万
     sh601688 华泰证券     14.25   +1.05%    +0.15     14.38    14.10    45.2万

  ↑/↓ 选择  Enter 详情  r 手动刷新  q 返回
  最后更新: 14:30:00  编辑自选股: ~/.dskcode/settings.json
```

按 `Enter` 进入详情页，查看 ASCII 分时折线图：

```
  📊 华泰证券 sh601688                       每 8s 刷新

  当前价    ▲ 14.25
  涨跌幅    +1.05%  +0.15

  14.42 ┤    ┌─┐
  14.34 ┤  ┌─┘ └─┐
  14.26 ┤ ┌┘     └─┐
  14.18 ┤─┘        └─┐
  14.10 ┤            └──

  Space/q 返回列表
```

#### 股票代码格式

代码需带市场前缀：

| 市场 | 格式 | 示例 |
|------|------|------|
| 上海主板 | `sh6xxxxx` | `sh601899`（紫金矿业） |
| 深圳主板 | `sz000xxx` | `sz000001`（平安银行） |
| 创业板 | `sz30xxxx` | `sz300750`（宁德时代） |
| 科创板 | `sh688xxx` | `sh688981`（中芯国际） |
| 指数 | `sh000xxx` / `sz399xxx` | `sz399300`（沪深300） |
| ETF | `sh5xxxxx` / `sz15xxxx` | `sh513090`（香港证券ETF） |

#### 自选股配置

首次运行 `dskcode stock` 时，程序会自动在 `~/.dskcode/settings.json` 中生成默认自选股列表：

```json
{
  "stock": {
    "symbols": [
      { "code": "sh000001" },
      { "code": "sz399300" },
      { "code": "sh601899" }
    ]
  }
}
```

编辑该文件的 `stock.symbols` 数组即可自定义自选股，列表页底部也会提示配置文件路径。

也可用纯数字代码，程序自动识别市场：
```bash
dskcode stock 000001 399006
# 000001 → sh000001（上证指数）
# 399006 → sz399006（创业板指）
```

#### 数据来源

分时数据来自腾讯免费行情接口 `web.ifzq.gtimg.cn/appstock/app/minute/query`，全天 242 条分钟线（09:30~15:00）。

## 实现进度

15 章开发计划，当前进度：

| # | 模块 | 说明 | 状态 |
|---|------|------|------|
| 01 | 项目初始化与工程基建 | monorepo、tsconfig、ESM/CJS、lint、test | ✅ 已完成 |
| 02 | CLI 框架搭建与子命令路由 | commander + inquirer、chat/run/setup 子命令 | ✅ 已完成 |
| 03 | 配置系统 | JSON 多级配置、环境变量、CLI flag 覆盖 | ✅ 已完成 |
| 04 | Provider 抽象层 | Provider 接口、DeepSeek 适配器、工厂注册 | ✅ 已完成 |
| 05 | LLM API 客户端 | 流式补全（SSE）、AbortController、超时重试 | ✅ 已完成 |
| 06 | Token 计价与成本追踪 | CostTracker 三层统计、Prefix Cache 半价 | ✅ 已完成 |
| 07 | Agent 主循环 | 消息编排、工具调用循环、轮次控制、/plan 计划模式 | ✅ 已完成 |
| 08 | 工具系统 | Tool 接口、Registry、10 个内置工具 | ✅ 已完成 |
| 09 | MCP 插件系统 | stdio JSON-RPC、子进程管理 | ⚡ 骨架就绪 |
| 10 | 权限控制 | Allow/Ask/Deny 三级策略、交互式审批 | ❌ 未开始 |
| 11 | 会话管理与检查点 | 会话持久化与恢复、git stash 检查点、/rewind 回退 | ✅ 已完成 |
| 12 | 终端交互 | 打字机效果、spinner、代码块高亮、工具调用可视化、命令提示轮播、rewind 提示 | ✅ 已完成 |
| 13 | 管道模式 | stdin/stdout 集成、非交互模式、JSON 输出 | ❌ 未开始 |
| 14 | 配置向导 | `dskcode setup` 交互式配置、API Key 管理 | ❌ 未开始 |
| 15 | 构建发布与 CI/CD | tsup 打包、npm publish、GitHub Actions | ✅ 已完成 |

### 内置工具详情

| 工具 | 说明 | 状态 |
|------|------|------|
| `read_file` | 读取文件，支持行号范围，自动拒绝二进制文件 | ✅ |
| `write_file` | 写入/创建文件，自动创建中间目录 | ✅ |
| `edit_file` | 精确文本替换，唯一匹配校验，自动保留原 EOL | ✅ |
| `multi_edit` | 原子批量替换，一处失败全部回滚，支持 replaceAll | ✅ |
| `delete_range` | 按行锚点删除文件中的行范围 | ✅ |
| `bash` | 执行 shell 命令，超时控制，Windows 兼容 | ✅ |
| `glob` | 文件路径模式搜索（`*` / `**` / `?`），自动跳过 node_modules /.git | ✅ |
| `grep` | 文件内容正则搜索，大小写控制，扩展名过滤 | ✅ |
| `ls` | 目录列表，类型标记，隐藏文件控制 | ✅ |
| `fetch` | HTTP 请求（GET/POST/PUT/DELETE），自定义请求头 | ✅ |

## 架构

```
src/
├── index.ts          # 入口，shebang + 异常处理
├── cli/              # commander 命令路由
├── config/           # JSON 配置加载与合并
├── provider/         # LLM Provider 接口（DeepSeek）+ CostTracker
├── tool/             # 内置工具（Registry + 10 个内置工具）
├── plugin/           # MCP 插件管理器（骨架就绪）
├── agent/            # Agent 会话循环 + 检查点（Checkpoint）
├── checkpoint/       # git stash 驱动的文件状态检查点（/rewind 基础）
├── session-store/    # 会话持久化与恢复
├── stock/            # 股票行情（交互式终端 + asciichart）
├── game/             # 内置小游戏
├── types/            # 共享类型定义
├── utils/            # 工具函数（渐变、模型工具等）
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
