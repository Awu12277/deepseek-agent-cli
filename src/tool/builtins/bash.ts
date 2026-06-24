// ---------------------------------------------------------------------------
// bash 工具 — 执行 shell 命令
// ---------------------------------------------------------------------------

import process from "node:process";
import { ToolKind, type AgentTool, type ToolContext, type ToolResult } from "../types.js";
import { execCommand, truncateOutput, getDefaultTimeout } from "../sandbox.js";

/** 是否为 Windows 平台 */
const isWindows = process.platform === "win32";

/** bash 工具的参数格式 */
export interface BashArgs {
  /** 要执行的命令 */
  command: string;
  /** 执行超时时间（毫秒），默认 30000 */
  timeout?: number;
}

/**
 * bash 工具 — 在 shell 中执行命令。
 */
export const bashTool: AgentTool<BashArgs> = {
  name: "bash",
  kind: ToolKind.Other,
  description:
    "在 shell 中执行命令。返回标准输出、标准错误和退出码。支持超时控制和信号中止。适用于运行构建、测试、Git 操作等命令。",
  parameters: {
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
  },

  async execute(args: BashArgs, ctx: ToolContext): Promise<ToolResult> {
    if (!args?.command || typeof args.command !== "string") {
      return { success: false, data: "缺少必要参数 command", error: "INVALID_ARGS" };
    }

    const timeout = args.timeout ?? ctx.timeout ?? getDefaultTimeout();

    try {
      const shellCommand = isWindows ? "cmd" : "sh";
      const shellArgs = isWindows ? ["/c", args.command] : ["-c", args.command];

      const result = await execCommand(
        shellCommand,
        shellArgs,
        ctx.cwd,
        timeout,
        ctx.signal,
        true,
      );

      const parts: string[] = [];
      if (result.stdout) {
        parts.push(truncateOutput(result.stdout));
      }
      if (result.stderr) {
        parts.push(`[stderr]\n${truncateOutput(result.stderr)}`);
      }

      const success = result.exitCode === 0;
      const output = parts.length > 0 ? parts.join("\n") : "(无输出)";

      const cmdPreview = args.command.length > 60
        ? args.command.slice(0, 57) + "..."
        : args.command;
      const summary = `🔧 $ ${cmdPreview}（exit ${result.exitCode ?? "未知"}）`;

      return {
        success,
        data: `${output}\n[退出码: ${result.exitCode ?? "未知"}]`,
        summary,
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
