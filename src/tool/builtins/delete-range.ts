// ---------------------------------------------------------------------------
// delete_range 工具 — 按行锚点删除文件中的行范围
// ---------------------------------------------------------------------------

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { ToolKind, type AgentTool, type ToolContext, type ToolResult } from "../types.js";
import { resolvePath, confine } from "../sandbox.js";
import { computeFileDiff } from "../diff.js";
import { writeFileWithEol } from "../eol.js";

/** delete_range 工具的参数格式 */
export interface DeleteRangeArgs {
  /** 文件路径（相对于 cwd 或绝对路径） */
  path: string;
  /** 删除范围的起始标记行（必须唯一） */
  startAnchor: string;
  /** 删除范围的结束标记行（必须唯一，须在 start_anchor 之后） */
  endAnchor: string;
  /** 是否包含锚点行本身，默认 false（只删除中间内容） */
  inclusive?: boolean;
}

/**
 * 在行列表中查找唯一匹配的行号。
 */
function findUniqueLine(lines: string[], anchor: string, label: string): { line: number } | { error: string } {
  const matches: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === anchor) {
      matches.push(i);
    }
  }

  if (matches.length === 0) {
    return { error: `未找到 "${label}" 锚点行，请确认内容完全一致` };
  }
  if (matches.length > 1) {
    return { error: `"${label}" 锚点行在文件中出现 ${matches.length} 次，请使用更唯一的行内容` };
  }

  return { line: matches[0]! };
}

/**
 * delete_range 工具 — 删除文件中两个锚点行之间的内容。
 */
export const deleteRangeTool: AgentTool<DeleteRangeArgs> = {
  name: "delete_range",
  kind: ToolKind.Edit,
  description:
    "删除文件中两个锚点行之间的内容。通过两个唯一的行内容精确定位范围。适用于删除方法、代码块、配置段等。",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "文件路径（相对于当前工作目录或绝对路径）",
      },
      startAnchor: {
        type: "string",
        description: "删除范围的起始标记行内容（必须在文件中唯一，精确匹配整行）",
      },
      endAnchor: {
        type: "string",
        description: "删除范围的结束标记行内容（必须在文件中唯一，精确匹配整行，须在 start_anchor 之后）",
      },
      inclusive: {
        type: "boolean",
        description: "是否包含锚点行本身，默认 false（只删除两行之间的内容）",
      },
    },
    required: ["path", "startAnchor", "endAnchor"],
    additionalProperties: false,
  },

  async execute(args: DeleteRangeArgs, ctx: ToolContext): Promise<ToolResult> {
    if (!args?.path || typeof args.path !== "string") {
      return { success: false, data: "缺少必要参数 path", error: "INVALID_ARGS" };
    }
    if (typeof args.startAnchor !== "string") {
      return { success: false, data: "缺少有效参数 startAnchor", error: "INVALID_ARGS" };
    }
    if (typeof args.endAnchor !== "string") {
      return { success: false, data: "缺少有效参数 endAnchor", error: "INVALID_ARGS" };
    }

    const filePath = resolvePath(args.path, ctx.cwd);
    const inclusive = args.inclusive ?? false;

    if (ctx.writeRoots && ctx.writeRoots.length > 0) {
      const conf = await confine(ctx.writeRoots, filePath);
      if (!conf.ok) {
        return { success: false, data: conf.error, error: "OUTSIDE_WRITE_ROOTS" };
      }
    }

    try {
      const content = await readFile(filePath, "utf-8");
      const lines = content.split("\n");

      const startResult = findUniqueLine(lines, args.startAnchor, "start_anchor");
      if ("error" in startResult) {
        return { success: false, data: startResult.error, error: "ANCHOR_NOT_FOUND" };
      }

      const endResult = findUniqueLine(lines, args.endAnchor, "end_anchor");
      if ("error" in endResult) {
        return { success: false, data: endResult.error, error: "ANCHOR_NOT_FOUND" };
      }

      const startLine = startResult.line;
      const endLine = endResult.line;

      if (startLine >= endLine) {
        return {
          success: false,
          data: "end_anchor 必须在 start_anchor 之后",
          error: "ANCHOR_ORDER_ERROR",
        };
      }

      const rangeStart = inclusive ? startLine : startLine + 1;
      const rangeEnd = inclusive ? endLine : endLine - 1;

      if (rangeStart > rangeEnd) {
        return {
          success: false,
          data: "删除范围为空（两行锚点相邻且 inclusive=false）",
          error: "EMPTY_RANGE",
        };
      }

      const newLines = [...lines.slice(0, rangeStart), ...lines.slice(rangeEnd + 1)];
      const newContent = newLines.join("\n");

      await writeFileWithEol(filePath, content, newContent);

      const diff = computeFileDiff(content, newContent, filePath);
      diff.existedBefore = true;

      const deletedLines = rangeEnd - rangeStart + 1;

      const summary = `📝 修改: ${basename(filePath)} (删 ${deletedLines} 行, +${diff.additions} -${diff.deletions})`;

      return {
        success: true,
        data: `文件已编辑：${filePath}\n删除行范围：第 ${rangeStart + 1} 行 ~ 第 ${rangeEnd + 1} 行（共 ${deletedLines} 行）\n变更：+${diff.additions} -${diff.deletions}`,
        summary,
        diff,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        data: `删除范围失败：${message}`,
        error: "DELETE_RANGE_ERROR",
      };
    }
  },
};
