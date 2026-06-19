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
- **股票行情** — `dskcode stock` 交互式 A 股行情终端，键盘选择 + 详情折线图 + 每 10 秒自动刷新

![股票列表](https://raw.githubusercontent.com/Awu12277/deepseek-agent-cli/refs/heads/main/public/stock_list.png)

![股票详情](https://raw.githubusercontent.com/Awu12277/deepseek-agent-cli/refs/heads/main/public/stock_detail.png)

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
| `dskcode stock [codes...]` | 交互式股票行情，↑/↓ 选择，Enter 查看分时折线图，每 10 秒自动刷新 |
| `dskcode stock sh000001 sz399006` | 查看指定股票行情 |
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

### 股票行情

`dskcode stock` 启动交互式股票行情终端，基于腾讯免费行情接口，支持实时查看 A 股/指数/ETF 行情。

#### 功能

- **实时行情列表** — 涨跌彩色标识（红涨绿跌），显示最新价、涨跌幅、最高/最低价、成交量
- **键盘选择** — `↑/↓` 切换股票，`Enter` 查看详情
- **分时折线图** — 详情页展示最近 60 笔分钟线的 ASCII 折线图（直角折线风格）
- **自动刷新** — 列表每 5 秒刷新，详情页每 10 秒刷新，右上角显示倒计时
- **手动刷新** — 按 `r` 键强制刷新

#### 使用方式

```bash
# 默认股票（上证指数 + 创业板指 + 华泰证券）
dskcode stock

# 指定股票代码
 dskcode stock sh000001 sz399006 sh601688
```

#### 示例界面

```
  📈 自选股监控                      每 5s 自动刷新
   代码     名称         最新价     涨跌幅     涨跌额    最高      最低     成交量
   ────────────────────────────────────────────────────────────────────────────
   ▸ sh000001 上证指数   3150.00   +0.35%   +11.02   3160.00  3140.00  28543.0万
     sz399006 创业板指   1820.00   -0.52%    -9.50   1835.00  1815.00  9865.0万
     sh601688 华泰证券     14.25   +1.05%    +0.15     14.38    14.10    45.2万

  ↑/↓ 选择  Enter 详情  r 手动刷新  q 返回
  最后更新: 14:30:00
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

也可用纯数字代码，程序自动识别市场：
```bash
dskcode stock 000001 399006
# 000001 → sh000001（上证指数）
# 399006 → sz399006（创业板指）
```

#### 数据来源

分时数据来自腾讯免费行情接口 `web.ifzq.gtimg.cn/appstock/app/minute/query`，全天 242 条分钟线（09:30~15:00）。

## 架构

```
src/
├── index.ts          # 入口，shebang + 异常处理
├── cli/              # commander 命令路由
├── config/           # JSON 配置加载与合并
├── provider/         # LLM Provider 接口（DeepSeek）
├── tool/             # 内置工具接口（读文件、写文件、bash 等）
├── plugin/           # MCP 插件管理器
├── agent/            # Agent 会话循环
├── stock/            # 股票行情（StockList 交互式行情终端 + asciichart 折线图）
├── game/             # 内置小游戏
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
