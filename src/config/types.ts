/** 单个 Provider 的配置（如 deepseek、openai 等） */
export interface ProviderConfig {
  /** Provider 在注册表中使用的标识符 */
  name: string;
  /** API 基础地址 */
  baseUrl?: string;
  /** API 密钥（也可通过环境变量读取，如 DEEPSEEK_API_KEY） */
  apiKey?: string;
  /** 聊天请求中发送的模型标识 */
  model: string;
}

/** 内置工具的配置 */
export interface ToolConfig {
  /** 工具名称 */
  name: string;
  /** 是否启用该工具 */
  enabled: boolean;
}

/** 外部 MCP 插件的配置 */
export interface PluginConfig {
  /** 插件名称 */
  name: string;
  /** 启动插件进程的命令 */
  command: string;
  /** CLI 参数 */
  args?: string[];
  /** 环境变量 */
  env?: Record<string, string>;
}

/** 自选股配置 */
export interface StockSymbol {
  /** 股票代码，如 sh513090、sz000001 */
  code: string;
  /** 显示别名（可选），不设置则使用接口返回的名称 */
  name?: string;
}

export interface StockConfig {
  /** 自选股列表 */
  symbols: StockSymbol[];
}

/** dskcode 的根配置 */
export interface Config {
  /** 默认 Provider 名称（必须匹配 TOML 中某个 provider 的 name 字段） */
  defaultProvider: string;
  /** 是否开启详细日志输出 */
  verbose?: boolean;
  /** 每次 LLM 请求的最大 token 数 */
  maxTokens?: number;
  /** 生成温度（0.0 ~ 2.0） */
  temperature?: number;
  /** 单次会话最大工具调用轮次 */
  maxToolRounds?: number;
  /** 每日预算上限（元），超过后自动中止请求，0 表示不限制 */
  budgetLimit?: number;
  /** 每日 Token 预算上限，超过后自动中止请求，0 表示不限制 */
  tokenBudgetLimit?: number;
  /** Provider 定义列表 */
  providers: ProviderConfig[];
  /** 工具设置 */
  tools: ToolConfig[];
  /** 外部 MCP 插件定义列表 */
  plugins: PluginConfig[];
  /** 自选股配置 */
  stock?: StockConfig;
}
