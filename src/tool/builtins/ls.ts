// ---------------------------------------------------------------------------
// ls 工具 — 列出目录内容
// ---------------------------------------------------------------------------

import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { ToolKind, type AgentTool, type ToolContext, type ToolResult } from "../types.js";
import { resolvePath, truncateOutput } from "../sandbox.js";

/** ls 工具的参数格式 */
export interface LsArgs {
  /** 目录路径，默认为 cwd */
  path?: string;
  /** 是否显示隐藏文件，默认 false */
  all?: boolean;
}

/** 目录项类型标记 */
type EntryType = "FILE" | "DIR" | "LINK";

/**
 * ls 工具 — 列出目录内容。
 *
 * 功能：
 * - 显示文件/目录类型标记
 * - 显示文件大小
 * - 可选显示隐藏文件
 * - 自动跳过无权访问的目录
 */
export const lsTool: AgentTool<LsArgs> = {
  name: "ls",
  kind: ToolKind.Read,
  description:
    "列出目录内容。显示条目类型（文件/目录/链接）和大小。可选择是否显示隐藏文件。",
  parameters: {
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
  },

  async execute(args: LsArgs, ctx: ToolContext): Promise<ToolResult> {
    const dirPath = args.path ? resolvePath(args.path, ctx.cwd) : ctx.cwd;
    const showAll = args.all ?? false;

    try {
      const entries = await readdir(dirPath, { withFileTypes: true });
      const lines: string[] = [];

      // 按名称排序：目录在前，文件在后
      const sorted = [...entries].toSorted((a, b) => {
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
        return { success: true, data: "目录为空", summary: `📂 ${relative(ctx.cwd, dirPath).replace(/\\/g, "/")}（空）` };
      }

      const relPath = relative(ctx.cwd, dirPath).replace(/\\/g, "/");
      return {
        success: true,
        data: truncateOutput(`目录：${dirPath}\n${lines.join("\n")}`),
        summary: `📂 ${relPath}（${lines.length} 项）`,
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
