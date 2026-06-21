// ---------------------------------------------------------------------------
// 工具系统核心类型定义
// ---------------------------------------------------------------------------

/** 工具参数的 JSON Schema 表示 */
export interface JSONSchema {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

/** 每次工具执行时传入的上下文 */
export interface ToolContext {
  /** 当前工作目录，用于路径约束和相对路径解析 */
  cwd: string;
  /** 中止信号，用于取消正在执行的工具 */
  signal?: AbortSignal;
  /** 命令执行超时（毫秒），默认 30000 */
  timeout?: number;
}

/** 文件变更的 diff 信息 */
export interface FileDiff {
  /** 文件路径（绝对路径） */
  filePath: string;
  /** unified diff 文本 */
  patch: string;
  /** 变更前是否存在（新建文件时为 false） */
  existedBefore: boolean;
  /** 变更统计：新增行数 */
  additions: number;
  /** 变更统计：删除行数 */
  deletions: number;
}

/** 工具执行返回的结果 */
export interface ToolResult {
  /** 是否执行成功 */
  success: boolean;
  /** 结果内容（成功时为输出，失败时为错误信息） */
  data: string;
  /** 错误详情（仅在 success=false 时有意义） */
  error?: string;
  /** 文件变更 diff（仅文件修改工具携带） */
  diff?: FileDiff;
}

/**
 * Tool 接口 — 每个内置工具或插件适配的工具都需要实现此接口。
 *
 * 内置工具实现示例：
 * ```ts
 * export const readFileTool: Tool = {
 *   name: "read_file",
 *   description: "读取指定路径的文件内容",
 *   parameters: { ... },
 *   execute: async (args, ctx) => { ... },
 * };
 * ```
 */
export interface Tool {
  /** 工具名称，全局唯一标识符 */
  readonly name: string;
  /** 工具描述，供模型理解工具的功能和用法 */
  readonly description: string;
  /** 参数的 JSON Schema 定义，供模型理解输入格式 */
  readonly parameters: JSONSchema;
  /** 执行工具逻辑 */
  execute(args: unknown, ctx: ToolContext): Promise<ToolResult>;
}