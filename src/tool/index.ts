/** 工具参数的 JSON Schema 表示 */
export interface JSONSchema {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

/** 每次工具执行时传入的上下文 */
export interface ToolContext {
  cwd: string;
  signal?: AbortSignal;
}

/** 工具执行返回的结果 */
export interface ToolResult {
  success: boolean;
  data: string;
  error?: string;
}

/** Tool 接口 — 每个内置工具或插件适配的工具都需要实现此接口。 */
export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly parameters: JSONSchema;
  execute(args: unknown, ctx: ToolContext): Promise<ToolResult>;
}
