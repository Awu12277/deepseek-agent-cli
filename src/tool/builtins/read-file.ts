// ---------------------------------------------------------------------------
// read_file 工具 — 读取指定路径的文件内容
// ---------------------------------------------------------------------------

import { readFile, stat } from "node:fs/promises";
import { open } from "node:fs/promises";
import type { Tool, ToolContext, ToolResult, JSONSchema } from "../types.js";
import { resolvePath, truncateOutput } from "../sandbox.js";

/** read_file 工具的参数格式 */
interface ReadFileArgs {
  /** 文件路径（相对于 cwd 或绝对路径） */
  path: string;
  /** 起始行号（1-based），默认 1 */
  startLine?: number;
  /** 结束行号（1-based，包含），默认到文件末尾 */
  endLine?: number;
}

/** read_file 工具的参数 JSON Schema */
const readFileSchema: JSONSchema = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "文件路径（相对于当前工作目录或绝对路径）",
    },
    startLine: {
      type: "number",
      description: "起始行号（从 1 开始），默认为 1",
    },
    endLine: {
      type: "number",
      description: "结束行号（包含），默认到文件末尾",
    },
  },
  required: ["path"],
  additionalProperties: false,
};

/** 读取前 N 字节检测是否为二进制文件 */
async function checkBinary(filePath: string): Promise<boolean> {
  const fileHandle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(8192); // 8KB
    const { bytesRead } = await fileHandle.read(buffer, 0, 8192, 0);
    return buffer.subarray(0, bytesRead).includes(0); // NUL 字节 → 二进制
  } finally {
    await fileHandle.close();
  }
}

/**
 * read_file 工具 — 读取文件内容，支持行号范围选择。
 *
 * 功能：
 * - 按行号范围读取部分内容
 * - 自动添加行号前缀（→ 分隔）
 * - 文件大小限制（默认 10MB）
 * - 输出长度截断（默认 50K 字符）
 * - 二进制检测（阻止读取二进制文件）
 */
export const readFileTool: Tool = {
  name: "read_file",
  description:
    "读取指定路径的文件内容。支持行号范围选择，输出带行号。适用于查看源代码、配置文件等文本文件。自动拒绝二进制文件。",
  parameters: readFileSchema,
  readOnly: true,

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

      // 检查是否为目录
      if (fileStat.isDirectory()) {
        return {
          success: false,
          data: `"${filePath}" 是一个目录，请使用 ls 工具查看目录内容`,
          error: "IS_DIRECTORY",
        };
      }

      // 二进制检测：扫描前 8KB 看是否包含 NUL 字节
      if (fileStat.size > 0) {
        const isBin = await checkBinary(filePath);
        if (isBin) {
          return {
            success: false,
            data: `"${filePath}" 看起来是二进制文件，不支持读取`,
            error: "BINARY_FILE",
          };
        }
      }

      const content = await readFile(filePath, "utf-8");
      const lines = content.split("\n");

      // 如果是空文件，最后一项为空行，pop 掉
      if (lines.length > 0 && lines[lines.length - 1] === "" && content.endsWith("\n")) {
        lines.pop();
      }

      // 行号范围处理（1-based → 0-based）
      const startLine = Math.max(1, params.startLine ?? 1) - 1;
      const endLine = params.endLine
        ? Math.min(params.endLine, lines.length)
        : lines.length;
      const selectedLines = lines.slice(startLine, endLine);

      // 添加行号前缀（右对齐 + →）
      const lineNumWidth = String(endLine).length;
      const result = selectedLines
        .map((line, i) => {
          const lineNum = String(startLine + i + 1).padStart(lineNumWidth, " ");
          return `${lineNum}→${line}`;
        })
        .join("\n");

      // 尾部提示：告知剩余行数
      const remaining = lines.length - endLine;
      const tailHint = remaining > 0
        ? `\n\n[还有 ${remaining} 行；使用 startLine=${endLine + 1} 继续查看]`
        : "";

      return {
        success: true,
        data: truncateOutput(result) + tailHint,
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
