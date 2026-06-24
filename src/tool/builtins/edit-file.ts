// ---------------------------------------------------------------------------
// edit_file 工具 — 精确字符串替换编辑文件
// ---------------------------------------------------------------------------

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { ToolKind, type AgentTool, type ToolContext, type ToolResult } from "../types.js";
import { resolvePath, confine } from "../sandbox.js";
import { computeFileDiff } from "../diff.js";
import { writeFileWithEol } from "../eol.js";

/** edit_file 工具的参数格式 */
export interface EditFileArgs {
  /** 文件路径（相对于 cwd 或绝对路径） */
  path: string;
  /** 要查找的原始文本（精确匹配） */
  old_text: string;
  /** 替换后的新文本 */
  new_text: string;
}

/**
 * edit_file 工具 — 对文件进行精确字符串替换。
 */
export const editFileTool: AgentTool<EditFileArgs> = {
  name: "edit_file",
  kind: ToolKind.Edit,
  description:
    "对文件进行精确字符串替换。查找文件中的 old_text 并替换为 new_text。如果 old_text 出现多次或未找到则报错。适用于小范围精确修改。",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "文件路径（相对于当前工作目录或绝对路径）",
      },
      old_text: {
        type: "string",
        description: "要查找的原始文本（精确匹配）",
      },
      new_text: {
        type: "string",
        description: "替换后的新文本",
      },
    },
    required: ["path", "old_text", "new_text"],
    additionalProperties: false,
  },

  async execute(args: EditFileArgs, ctx: ToolContext): Promise<ToolResult> {
    if (!args?.path || typeof args.path !== "string") {
      return { success: false, data: "缺少必要参数 path", error: "INVALID_ARGS" };
    }
    if (typeof args.old_text !== "string") {
      return { success: false, data: "缺少必要参数 old_text", error: "INVALID_ARGS" };
    }
    if (typeof args.new_text !== "string") {
      return { success: false, data: "缺少必要参数 new_text", error: "INVALID_ARGS" };
    }

    const filePath = resolvePath(args.path, ctx.cwd);

    if (ctx.writeRoots && ctx.writeRoots.length > 0) {
      const conf = await confine(ctx.writeRoots, filePath);
      if (!conf.ok) {
        return { success: false, data: conf.error, error: "OUTSIDE_WRITE_ROOTS" };
      }
    }

    try {
      const content = await readFile(filePath, "utf-8");

      const firstIndex = content.indexOf(args.old_text);
      if (firstIndex === -1) {
        return {
          success: false,
          data: `未找到要替换的文本。请确认 old_text 与文件内容完全一致（包括缩进和空格）。`,
          error: "TEXT_NOT_FOUND",
        };
      }

      const secondIndex = content.indexOf(args.old_text, firstIndex + 1);
      if (secondIndex !== -1) {
        return {
          success: false,
          data: `要替换的文本在文件中出现多次，请提供更多上下文以精确定位。`,
          error: "TEXT_MULTIPLE_MATCHES",
        };
      }

      const newContent = content.replace(args.old_text, args.new_text);
      await writeFileWithEol(filePath, content, newContent);

      const diff = computeFileDiff(content, newContent, filePath);
      diff.existedBefore = true;

      const beforeText = content.slice(0, firstIndex);
      const startLine = beforeText.split("\n").length;
      const oldLines = args.old_text.split("\n").length;
      const newLines = args.new_text.split("\n").length;

      const diffSummary = `+${diff.additions} -${diff.deletions}`;
      const summary = `📝 修改: ${basename(filePath)} (+${diff.additions} -${diff.deletions})`;

      return {
        success: true,
        data: `文件已编辑：${filePath}\n替换位置：第 ${startLine} 行\n${oldLines} 行 → ${newLines} 行\n变更：${diffSummary}`,
        summary,
        diff,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        data: `编辑文件失败：${message}`,
        error: "EDIT_ERROR",
      };
    }
  },
};
