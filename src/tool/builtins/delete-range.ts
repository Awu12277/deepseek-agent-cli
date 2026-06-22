// ---------------------------------------------------------------------------
// delete_range 工具 — 按行锚点删除文件中的行范围
//
// 通过两个唯一的行内容锚点（start_anchor / end_anchor）定位删除范围，
// 要求每个锚点在文件中恰好出现一次，避免模糊删除。
// ---------------------------------------------------------------------------

import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import type { Tool, ToolContext, ToolResult, JSONSchema } from "../types.js";
import { resolvePath } from "../sandbox.js";
import { computeFileDiff } from "../diff.js";

/** delete_range 工具的参数格式 */
interface DeleteRangeArgs {
  /** 文件路径（相对于 cwd 或绝对路径） */
  path: string;
  /** 删除范围的起始标记行（必须唯一） */
  startAnchor: string;
  /** 删除范围的结束标记行（必须唯一，须在 start_anchor 之后） */
  endAnchor: string;
  /** 是否包含锚点行本身，默认 false（只删除中间内容） */
  inclusive?: boolean;
}

/** delete_range 工具的参数 JSON Schema */
const deleteRangeSchema: JSONSchema = {
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
};

/**
 * 在行列表中查找唯一匹配的行号。
 * 要求行内容精确匹配，且只能匹配一次。
 *
 * @returns 匹配的行号（0-based），如果不存在或不唯一则返回错误
 */
function findUniqueLine(lines: string[], anchor: string, label: string): { line: number } | { error: string } {
  const matches: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] as string) === anchor) {
      matches.push(i);
    }
  }

  if (matches.length === 0) {
    return { error: `未找到 "${label}" 锚点行，请确认内容完全一致` };
  }
  if (matches.length > 1) {
    return { error: `"${label}" 锚点行在文件中出现 ${matches.length} 次，请使用更唯一的行内容` };
  }

  return { line: matches[0] as number };
}

/**
 * delete_range 工具 — 删除文件中两个锚点行之间的内容。
 *
 * 设计要点：
 * - 通过两个唯一行锚点定位范围
 * - 两个锚点必须在文件中恰好出现一次
 * - end_anchor 必须在 start_anchor 之后
 * - 可选择是否包含锚点行
 */
export const deleteRangeTool: Tool = {
  name: "delete_range",
  description:
    "删除文件中两个锚点行之间的内容。通过两个唯一的行内容精确定位范围。适用于删除方法、代码块、配置段等。",
  parameters: deleteRangeSchema,
  readOnly: false,

  async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const params = args as DeleteRangeArgs;
    if (!params?.path || typeof params.path !== "string") {
      return { success: false, data: "缺少必要参数 path", error: "INVALID_ARGS" };
    }
    if (typeof params.startAnchor !== "string") {
      return { success: false, data: "缺少有效参数 startAnchor", error: "INVALID_ARGS" };
    }
    if (typeof params.endAnchor !== "string") {
      return { success: false, data: "缺少有效参数 endAnchor", error: "INVALID_ARGS" };
    }

    const filePath = resolvePath(params.path, ctx.cwd);
    const inclusive = params.inclusive ?? false;

    try {
      const content = await readFile(filePath, "utf-8");
      const lines = content.split("\n");

      // 查找锚点
      const startResult = findUniqueLine(lines, params.startAnchor, "start_anchor");
      if ("error" in startResult) {
        return { success: false, data: startResult.error, error: "ANCHOR_NOT_FOUND" };
      }

      const endResult = findUniqueLine(lines, params.endAnchor, "end_anchor");
      if ("error" in endResult) {
        return { success: false, data: endResult.error, error: "ANCHOR_NOT_FOUND" };
      }

      const startLine = startResult.line;
      const endLine = endResult.line;

      // 验证顺序
      if (startLine >= endLine) {
        return {
          success: false,
          data: "end_anchor 必须在 start_anchor 之后",
          error: "ANCHOR_ORDER_ERROR",
        };
      }

      // 计算删除范围（0-based，含头含尾 slice）
      const rangeStart = inclusive ? startLine : startLine + 1;
      const rangeEnd = inclusive ? endLine : endLine - 1;

      if (rangeStart > rangeEnd) {
        return {
          success: false,
          data: "删除范围为空（两行锚点相邻且 inclusive=false）",
          error: "EMPTY_RANGE",
        };
      }

      // 执行删除
      const newLines = [...lines.slice(0, rangeStart), ...lines.slice(rangeEnd + 1)];
      const newContent = newLines.join("\n");

      // 检测行尾风格并保留
      let writeContent = newContent;
      if (content.endsWith("\n") && !newContent.endsWith("\n")) {
        writeContent = newContent + "\n";
      } else if (content.endsWith("\r\n") && !newContent.endsWith("\r\n") && !newContent.endsWith("\n")) {
        writeContent = newContent + "\r\n";
      }

      await writeFile(filePath, writeContent, "utf-8");

      const diff = computeFileDiff(content, writeContent, filePath);
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
