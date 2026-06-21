// ---------------------------------------------------------------------------
// ls 工具 — 列出目录内容
// ---------------------------------------------------------------------------

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Tool, ToolContext, ToolResult, JSONSchema } from "../types.js";
import { resolvePath, truncateOutput } from "../sandbox.js";

/** ls 工具的参数格式 */
interface LsArgs {
  /** 目录路径，默认为 cwd */
  path?: string;
  /** 是否显示隐藏文件，默认 false */
  all?: boolean;
}

/** 目录项类型标记 */
type EntryType = "FILE" | "DIR" | "LINK";

/** ls 工具的参数 JSON Schema */
const lsSchema: JSONSchema = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "目录路径（相对于当前工作目录或绝对路径），默认为当前目录",
    },
    all: {
      type: "boolean",
      description: "是否显示隐藏文件（以 . 开头的文件），默认 false",
    },
  },
  required: [],
  additionalProperties: false,
};

/**
 * ls 工具 — 列出目录内容。
 *
 * 功能：
 * - 显示文件/目录类型标记
 * - 显示文件大小
 * - 可选显示隐藏文件
 * - 自动跳过无权访问的目录
 */
export const lsTool: Tool = {
  name: "ls",
  description:
    "列出目录内容。显示条目类型（文件/目录/链接）和大小。可选择是否显示隐藏文件。",
  parameters: lsSchema,

  async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const params = (args ?? {}) as LsArgs;
    const dirPath = params.path ? resolvePath(params.path, ctx.cwd) : ctx.cwd;
    const showAll = params.all ?? false;

    try {
      const entries = await readdir(dirPath, { withFileTypes: true });
      const lines: string[] = [];

      // 按名称排序：目录在前，文件在后
      const sorted = [...entries].sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) {
          return a.isDirectory() ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });

      for (const entry of sorted) {
        // 过滤隐藏文件
        if (!showAll && entry.name.startsWith(".")) continue;

        const typeMark: EntryType = entry.isDirectory()
          ? "DIR"
          : entry.isSymbolicLink()
            ? "LINK"
            : "FILE";

        let sizeStr = "";
        if (typeMark === "FILE") {
          try {
            const fileStat = await stat(join(dirPath, entry.name));
            if (fileStat.size < 1024) {
              sizeStr = `${fileStat.size}B`;
            } else if (fileStat.size < 1024 * 1024) {
              sizeStr = `${(fileStat.size / 1024).toFixed(1)}KB`;
            } else {
              sizeStr = `${(fileStat.size / 1024 / 1024).toFixed(1)}MB`;
            }
          } catch {
            sizeStr = "?";
          }
        }

        const typeLabel = typeMark === "DIR" ? "📁" : typeMark === "LINK" ? "🔗" : "📄";
        lines.push(`${typeLabel} ${entry.name}${sizeStr ? ` (${sizeStr})` : ""}`);
      }

      if (lines.length === 0) {
        return { success: true, data: "目录为空" };
      }

      return {
        success: true,
        data: truncateOutput(`目录：${dirPath}\n${lines.join("\n")}`),
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        data: `列目录失败：${message}`,
        error: "LS_ERROR",
      };
    }
  },
};