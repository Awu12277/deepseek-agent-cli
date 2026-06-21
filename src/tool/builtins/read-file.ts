// ---------------------------------------------------------------------------
// read_file 工具 — 读取指定路径的文件内容
// ---------------------------------------------------------------------------

import { readFile } from "node:fs/promises";
import { stat } from "node:fs/promises";
import type { Tool, ToolContext, ToolResult, JSONSchema } from "../types.js";
import { resolvePath, truncateOutput } from "../sandbox.js";

/** read_file 工具的参数格式 */
interface ReadFileArgs {
  /** 文件路径（相对于 cwd 或绝对路径） */
  path: string;
  /** 起始行号（1-based），默认 1 */
  start_line?: number;
  /** 结束行号（1-based，包含），默认到文件末尾 */
  end_line?: number;
}

/** read_file 工具的参数 JSON Schema */
const readFileSchema: JSONSchema = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "文件路径（相对于当前工作目录或绝对路径）",
    },
    start_line: {
      type: "number",
      description: "起始行号（从 1 开始），默认为 1",
    },
    end_line: {
      type: "number",
      description: "结束行号（包含），默认到文件末尾",
    },
  },
  required: ["path"],
  additionalProperties: false,
};

/**
 * read_file 工具 — 读取文件内容，支持行号范围选择。
 *
 * 功能：
 * - 按行号范围读取部分内容
 * - 自动添加行号前缀
 * - 文件大小限制（默认 10MB）
 * - 输出长度截断（默认 50K 字符）
 */
export const readFileTool: Tool = {
  name: "read_file",
  description:
    "读取指定路径的文件内容。支持行号范围选择，输出带行号。适用于查看源代码、配置文件等文本文件。",
  parameters: readFileSchema,

  async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const params = args as ReadFileArgs;
    if (!params?.path || typeof params.path !== "string") {
      return { success: false, data: "缺少必要参数 path", error: "INVALID_ARGS" };
    }

    const filePath = resolvePath(params.path, ctx.cwd);

    try {
      // 检查文件大小
      const fileStat = await stat(filePath);
      const maxSize = 10 * 1024 * 1024; // 10MB
      if (fileStat.size > maxSize) {
        return {
          success: false,
          data: `文件过大（${(fileStat.size / 1024 / 1024).toFixed(1)}MB），超过 10MB 限制`,
          error: "FILE_TOO_LARGE",
        };
      }

      const content = await readFile(filePath, "utf-8");
      const lines = content.split("\n");

      // 行号范围处理（1-based → 0-based）
      const startLine = Math.max(1, params.start_line ?? 1) - 1;
      const endLine = params.end_line ? Math.min(params.end_line, lines.length) : lines.length;
      const selectedLines = lines.slice(startLine, endLine);

      // 添加行号前缀
      const lineNumWidth = String(endLine).length;
      const result = selectedLines
        .map((line, i) => {
          const lineNum = String(startLine + i + 1).padStart(lineNumWidth, " ");
          return `${lineNum} | ${line}`;
        })
        .join("\n");

      return {
        success: true,
        data: truncateOutput(result),
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        data: `读取文件失败：${message}`,
        error: "READ_ERROR",
      };
    }
  },
};