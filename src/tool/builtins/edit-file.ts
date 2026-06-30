// ---------------------------------------------------------------------------
// edit_file 工具 — 精确字符串替换编辑文件
// ---------------------------------------------------------------------------

import { readFile } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { ToolKind, type AgentTool, type ToolContext, type ToolResult } from "../types.js";
import { resolvePath, confine } from "../sandbox.js";
import { computeFileDiff } from "../diff.js";
import { normalizeEol, toLf } from "../eol.js";

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

      // 匹配在 LF 归一化空间进行：原文件可能是 CRLF，而 LLM 习惯用 LF
      // 编写 old_text/new_text。这里把两端都归一为 LF 再 indexOf，落盘时
      // 再由 normalizeEol 还原为原 EOL，避免「CRLF 文件整段匹配失败」的
      // 反复重试，也不产生 EOL 翻转噪声。
      const contentN = toLf(content);
      const oldTextN = toLf(args.old_text);

      const firstIndex = contentN.indexOf(oldTextN);
      if (firstIndex === -1) {
        return {
          success: false,
          data: `未找到要替换的文本。请确认 old_text 与文件内容完全一致（包括缩进和空格）。`,
          error: "TEXT_NOT_FOUND",
        };
      }

      const secondIndex = contentN.indexOf(oldTextN, firstIndex + 1);
      if (secondIndex !== -1) {
        return {
          success: false,
          data: `要替换的文本在文件中出现多次，请提供更多上下文以精确定位。`,
          error: "TEXT_MULTIPLE_MATCHES",
        };
      }

      const newContentN =
        contentN.slice(0, firstIndex) +
        toLf(args.new_text) +
        contentN.slice(firstIndex + oldTextN.length);
      // 按原文件 EOL 还原后再落盘，diff 也基于实际落盘内容计算。
      const writtenContent = normalizeEol(content, newContentN);
      await writeFile(filePath, writtenContent, "utf-8");

      const diff = computeFileDiff(content, writtenContent, filePath);
      diff.existedBefore = true;

      const beforeText = contentN.slice(0, firstIndex);
      const startLine = beforeText.split("\n").length;
      const oldLines = oldTextN.split("\n").length;
      const newLines = toLf(args.new_text).split("\n").length;

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
