// ---------------------------------------------------------------------------
// multi_edit 工具 — 精确字符串批量替换编辑文件（原子性）
//
// 与 edit_file 不同之处：
// - 支持多个替换步骤，在一个请求中原子完成
// - 支持 replace_all 标志，允许替换文件中所有匹配项
// - 所有步骤在内存中应用，要么全部成功（一次写入），要么全部失败
// ---------------------------------------------------------------------------

import { readFile, writeFile } from "node:fs/promises";
import type { Tool, ToolContext, ToolResult, JSONSchema } from "../types.js";
import { resolvePath } from "../sandbox.js";
import { computeFileDiff } from "../diff.js";

/** 单个编辑步骤 */
interface EditStep {
  /** 要查找的原始文本（精确匹配） */
  oldText: string;
  /** 替换后的新文本 */
  newText: string;
  /** 是否替换文件中所有匹配项，默认 false */
  replaceAll?: boolean;
}

/** multi_edit 工具的参数格式 */
interface MultiEditArgs {
  /** 文件路径（相对于 cwd 或绝对路径） */
  path: string;
  /** 有序编辑步骤数组 */
  edits: EditStep[];
}

/** multi_edit 工具的参数 JSON Schema */
const multiEditSchema: JSONSchema = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "文件路径（相对于当前工作目录或绝对路径）",
    },
    edits: {
      type: "array",
      description: "有序的编辑步骤列表。每个步骤包含 oldText（精确匹配）、newText（替换内容）和可选的 replaceAll（是否替换所有匹配项）",
      items: {
        type: "object",
        properties: {
          oldText: { type: "string", description: "要查找的原始文本（精确匹配）" },
          newText: { type: "string", description: "替换后的新文本" },
          replaceAll: { type: "boolean", description: "是否替换所有匹配项，默认 false" },
        },
        required: ["oldText", "newText"],
        additionalProperties: false,
      },
    },
  },
  required: ["path", "edits"],
  additionalProperties: false,
};

/**
 * multi_edit 工具 — 对文件进行原子批量替换编辑。
 *
 * 设计要点：
 * - 读文件到内存 → 逐个应用所有编辑步骤 → 全部成功才写入磁盘
 * - 任一步骤失败（文本不存在、不唯一等）则返回错误，文件不变
 * - 支持 replace_all 标志做全局替换
 * - 返回汇总后的 diff
 */
export const multiEditTool: Tool = {
  name: "multi_edit",
  description:
    "对文件进行原子批量替换编辑。在一个请求中执行多个精确替换，任一失败则全部回滚。支持 replaceAll 参数做全局替换。适用于需要同时修改文件多处的场景。",
  parameters: multiEditSchema,
  readOnly: false,

  async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const params = args as MultiEditArgs;
    if (!params?.path || typeof params.path !== "string") {
      return { success: false, data: "缺少必要参数 path", error: "INVALID_ARGS" };
    }
    if (!Array.isArray(params.edits) || params.edits.length === 0) {
      return { success: false, data: "缺少必要参数 edits（非空数组）", error: "INVALID_ARGS" };
    }

    const filePath = resolvePath(params.path, ctx.cwd);

    try {
      const originalContent = await readFile(filePath, "utf-8");
      let currentContent = originalContent;

      // 逐个应用编辑步骤
      for (let idx = 0; idx < params.edits.length; idx++) {
        const step = params.edits[idx] as EditStep;
        if (typeof step.oldText !== "string") {
          return {
            success: false,
            data: `第 ${idx + 1} 步：缺少有效的 oldText`,
            error: "INVALID_STEP_ARGS",
          };
        }

        if (step.replaceAll) {
          // 全局替换 — 统计替换次数
          let count = 0;
          let pos = -1;
          while ((pos = currentContent.indexOf(step.oldText, pos + 1)) !== -1) {
            count++;
          }

          if (count === 0) {
            return {
              success: false,
              data: `第 ${idx + 1} 步：未找到要替换的文本，请确认 oldText 与文件内容完全一致`,
              error: "TEXT_NOT_FOUND",
            };
          }

          currentContent = currentContent.split(step.oldText).join(step.newText);
        } else {
          // 精确单次替换 — 检查唯一性
          const firstIdx = currentContent.indexOf(step.oldText);
          if (firstIdx === -1) {
            return {
              success: false,
              data: `第 ${idx + 1} 步：未找到要替换的文本。请确认 oldText 与文件内容完全一致（包括缩进和空格）。`,
              error: "TEXT_NOT_FOUND",
            };
          }

          const secondIdx = currentContent.indexOf(step.oldText, firstIdx + 1);
          if (secondIdx !== -1) {
            return {
              success: false,
              data: `第 ${idx + 1} 步：要替换的文本在文件中出现多次，请提供更多上下文以精确定位，或设置 replaceAll=true`,
              error: "TEXT_MULTIPLE_MATCHES",
            };
          }

          currentContent = currentContent.replace(step.oldText, step.newText);
        }
      }

      // 全部步骤成功 → 一次性写入磁盘
      await writeFile(filePath, currentContent, "utf-8");

      // 计算总体 diff
      const diff = computeFileDiff(originalContent, currentContent, filePath);
      diff.existedBefore = true;

      return {
        success: true,
        data: `文件已编辑：${filePath}\n共执行 ${params.edits.length} 步替换\n变更：+${diff.additions} -${diff.deletions}`,
        diff,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        data: `批量编辑失败：${message}`,
        error: "MULTI_EDIT_ERROR",
      };
    }
  },
};
