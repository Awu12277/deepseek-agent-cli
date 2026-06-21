// ---------------------------------------------------------------------------
// bash 工具 — 执行 shell 命令
// ---------------------------------------------------------------------------

import type { Tool, ToolContext, ToolResult, JSONSchema } from "../types.js";
import { execCommand, truncateOutput, getDefaultTimeout } from "../sandbox.js";

/** bash 工具的参数格式 */
interface BashArgs {
  /** 要执行的命令 */
  command: string;
  /** 执行超时时间（毫秒），默认 30000 */
  timeout?: number;
}

/** bash 工具的参数 JSON Schema */
const bashSchema: JSONSchema = {
  type: "object",
  properties: {
    command: {
      type: "string",
      description: "要执行的 shell 命令",
    },
    timeout: {
      type: "number",
      description: "执行超时时间（毫秒），默认 30000",
    },
  },
  required: ["command"],
  additionalProperties: false,
};

/**
 * bash 工具 — 在 shell 中执行命令。
 *
 * 功能：
 * - 支持任意 shell 命令
 * - 超时控制（默认 30 秒）
 * - 输出截断（默认 50K 字符）
 * - 返回标准输出、标准错误和退出码
 * - 支持外部中止信号
 */
export const bashTool: Tool = {
  name: "bash",
  description:
    "在 shell 中执行命令。返回标准输出、标准错误和退出码。支持超时控制和信号中止。适用于运行构建、测试、Git 操作等命令。",
  parameters: bashSchema,

  async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const params = args as BashArgs;
    if (!params?.command || typeof params.command !== "string") {
      return { success: false, data: "缺少必要参数 command", error: "INVALID_ARGS" };
    }

    const timeout = params.timeout ?? ctx.timeout ?? getDefaultTimeout();

    try {
      const result = await execCommand(
        "sh",
        ["-c", params.command],
        ctx.cwd,
        timeout,
        ctx.signal,
      );

      // 组装输出
      const parts: string[] = [];
      if (result.stdout) {
        parts.push(truncateOutput(result.stdout));
      }
      if (result.stderr) {
        parts.push(`[stderr]\n${truncateOutput(result.stderr)}`);
      }

      const success = result.exitCode === 0;
      const output = parts.length > 0 ? parts.join("\n") : "(无输出)";

      return {
        success,
        data: `${output}\n[退出码: ${result.exitCode ?? "未知"}]`,
        error: success ? undefined : `EXIT_CODE_${result.exitCode ?? "UNKNOWN"}`,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        data: `命令执行失败：${message}`,
        error: "EXECUTION_ERROR",
      };
    }
  },
};