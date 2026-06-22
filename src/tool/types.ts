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
 * 设计要点：
 * - ReadOnly() 标志控制并行执行：读工具返回 true，写工具返回 false。
 *   代理在 executeBatch 中判断：全部 ReadOnly 的可并行执行，否则串行。
 * - 写工具（write_file/edit_file/delete_range等）返回 false，
 *   读工具（read_file/grep/ls/glob/fetch）返回 true。
 */
export interface Tool {
  /** 工具名称，全局唯一标识符 */
  readonly name: string;
  /** 工具描述，供模型理解工具的功能和用法 */
  readonly description: string;
  /** 参数的 JSON Schema 定义，供模型理解输入格式 */
  readonly parameters: JSONSchema;
  /**
   * 工具是否为只读。
   * true = 无副作用的读操作，可并行执行；
   * false = 有写操作，需串行执行。
   */
  readonly readOnly: boolean;
  /** 执行工具逻辑 */
  execute(args: unknown, ctx: ToolContext): Promise<ToolResult>;
}

/**
 * Previewer 可选接口 — 写工具可实现此接口。
 *
 * 给定相同的参数，计算文件变更的 diff 信息，而不实际写入磁盘。
 * 用于：
 * - 审批前预览变更
 * - 检查点快照
 * - 在不触盘的情况下展示改动
 */
export interface Previewer {
  /**
   * 预览文件变更。
   * @param args 与 execute 相同的参数
   * @returns 文件变更的 diff 信息
   */
  preview(args: unknown, ctx: ToolContext): Promise<FileDiff>;
}

/**
 * Gate 权限门接口 — 控制工具执行前是否需要审批。
 *
 * 当前预留接口，默认实现为 always-allow。
 * 未来可接入交互式审批或策略引擎。
 */
export interface Gate {
  /**
   * 检查工具调用是否允许执行。
   * @param toolName 工具名称
   * @param args     工具参数
   * @returns true = 允许执行，false = 拒绝执行
   */
  check(toolName: string, args: unknown): boolean | Promise<boolean>;
}

/**
 * AlwaysAllowGate — 默认权限门，所有工具调用默认放行。
 */
export class AlwaysAllowGate implements Gate {
  check(_toolName: string, _args: unknown): boolean {
    return true;
  }
}

/** 工具调用记录（用于风暴检测等） */
export interface ToolCallRecord {
  /** 工具名称 */
  name: string;
  /** 执行是否成功 */
  success: boolean;
  /** 退出时是否发生错误 */
  error?: string;
  /** 执行时间戳 */
  timestamp: number;
}
