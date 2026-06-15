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

/** dsk 的根配置 */
export interface Config {
  /** 默认 Provider 名称（必须匹配 TOML 中某个 provider 的 name 字段） */
  defaultProvider: string;
  /** Provider 定义列表 */
  providers: ProviderConfig[];
  /** 工具设置 */
  tools: ToolConfig[];
  /** 外部 MCP 插件定义列表 */
  plugins: PluginConfig[];
}
