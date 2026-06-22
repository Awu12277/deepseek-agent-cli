// ---------------------------------------------------------------------------
// edit_file 工具 — 精确字符串替换编辑文件
// ---------------------------------------------------------------------------

import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import type { Tool, ToolContext, ToolResult, JSONSchema } from "../types.js";
import { resolvePath } from "../sandbox.js";
import { computeFileDiff } from "../diff.js";

/** edit_file 工具的参数格式 */
interface EditFileArgs {
  /** 文件路径（相对于 cwd 或绝对路径） */
  path: string;
  /** 要查找的原始文本（精确匹配） */
  old_text: string;
  /** 替换后的新文本 */
  new_text: string;
}

/** edit_file 工具的参数 JSON Schema */
const editFileSchema: JSONSchema = {
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
};

/**
 * edit_file 工具 — 对文件进行精确字符串替换。
 *
 * 功能：
 * - 精确匹配 old_text 并替换为 new_text
 * - 如果 old_text 在文件中出现多次则报错（避免误改）
 * - 如果 old_text 未找到则报错
 * - 返回替换前后的上下文信息
 */
export const editFileTool: Tool = {
  name: "edit_file",
  description:
    "对文件进行精确字符串替换。查找文件中的 old_text 并替换为 new_text。如果 old_text 出现多次或未找到则报错。适用于小范围精确修改。",
  parameters: editFileSchema,
  readOnly: false,

  async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const params = args as EditFileArgs;
    if (!params?.path || typeof params.path !== "string") {
      return { success: false, data: "缺少必要参数 path", error: "INVALID_ARGS" };
    }
    if (typeof params.old_text !== "string") {
      return { success: false, data: "缺少必要参数 old_text", error: "INVALID_ARGS" };
    }
    if (typeof params.new_text !== "string") {
      return { success: false, data: "缺少必要参数 new_text", error: "INVALID_ARGS" };
    }

    const filePath = resolvePath(params.path, ctx.cwd);

    try {
      const content = await readFile(filePath, "utf-8");

      // 检查 old_text 是否存在
      const firstIndex = content.indexOf(params.old_text);
      if (firstIndex === -1) {
        return {
          success: false,
          data: `未找到要替换的文本。请确认 old_text 与文件内容完全一致（包括缩进和空格）。`,
          error: "TEXT_NOT_FOUND",
        };
      }

      // 检查是否出现多次
      const secondIndex = content.indexOf(params.old_text, firstIndex + 1);
      if (secondIndex !== -1) {
        return {
          success: false,
          data: `要替换的文本在文件中出现多次，请提供更多上下文以精确定位。`,
          error: "TEXT_MULTIPLE_MATCHES",
        };
      }

      // 执行替换
      const newContent = content.replace(params.old_text, params.new_text);
      await writeFile(filePath, newContent, "utf-8");

      // 计算文件变更 diff
      const diff = computeFileDiff(content, newContent, filePath);
      diff.existedBefore = true;

      // 计算替换位置的行号
      const beforeText = content.slice(0, firstIndex);
      const startLine = beforeText.split("\n").length;
      const oldLines = params.old_text.split("\n").length;
      const newLines = params.new_text.split("\n").length;

      // 构建包含 diff 摘要的返回信息
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