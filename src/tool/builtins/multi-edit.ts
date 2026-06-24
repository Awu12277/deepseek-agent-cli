// ---------------------------------------------------------------------------
// multi_edit 工具 — 精确字符串批量替换编辑文件（原子性）
// ---------------------------------------------------------------------------

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { ToolKind, type AgentTool, type ToolContext, type ToolResult } from "../types.js";
import { resolvePath, confine } from "../sandbox.js";
import { computeFileDiff } from "../diff.js";
import { writeFileWithEol } from "../eol.js";

/** 单个编辑步骤 */
export interface EditStep {
  /** 要查找的原始文本（精确匹配） */
  oldText: string;
  /** 替换后的新文本 */
  newText: string;
  /** 是否替换文件中所有匹配项，默认 false */
  replaceAll?: boolean;
}

/** multi_edit 工具的参数格式 */
export interface MultiEditArgs {
  /** 文件路径（相对于 cwd 或绝对路径） */
  path: string;
  /** 有序编辑步骤数组 */
  edits: EditStep[];
}

/**
 * multi_edit 工具 — 对文件进行原子批量替换编辑。
 */
export const multiEditTool: AgentTool<MultiEditArgs> = {
  name: "multi_edit",
  kind: ToolKind.Edit,
  description:
    "对文件进行原子批量替换编辑。在一个请求中执行多个精确替换，任一失败则全部回滚。支持 replaceAll 参数做全局替换。适用于需要同时修改文件多处的场景。",
  parameters: {
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
  },

  async execute(args: MultiEditArgs, ctx: ToolContext): Promise<ToolResult> {
    if (!args?.path || typeof args.path !== "string") {
      return { success: false, data: "缺少必要参数 path", error: "INVALID_ARGS" };
    }
    if (!Array.isArray(args.edits) || args.edits.length === 0) {
      return { success: false, data: "缺少必要参数 edits（非空数组）", error: "INVALID_ARGS" };
    }

    const filePath = resolvePath(args.path, ctx.cwd);

    if (ctx.writeRoots && ctx.writeRoots.length > 0) {
      const conf = await confine(ctx.writeRoots, filePath);
      if (!conf.ok) {
        return { success: false, data: conf.error, error: "OUTSIDE_WRITE_ROOTS" };
      }
    }

    try {
      const originalContent = await readFile(filePath, "utf-8");
      let currentContent = originalContent;

      for (let idx = 0; idx < args.edits.length; idx++) {
        const step = args.edits[idx]!;
        if (typeof step.oldText !== "string") {
          return {
            success: false,
            data: `第 ${idx + 1} 步：缺少有效的 oldText`,
            error: "INVALID_STEP_ARGS",
          };
        }

        if (step.replaceAll) {
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

      await writeFileWithEol(filePath, originalContent, currentContent);

      const diff = computeFileDiff(originalContent, currentContent, filePath);
      diff.existedBefore = true;

      return {
        success: true,
        data: `文件已编辑：${filePath}\n共执行 ${args.edits.length} 步替换\n变更：+${diff.additions} -${diff.deletions}`,
        summary: `📝 修改: ${basename(filePath)} (${args.edits.length} 步, +${diff.additions} -${diff.deletions})`,
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
