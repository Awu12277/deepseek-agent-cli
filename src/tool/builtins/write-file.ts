// ---------------------------------------------------------------------------
// write_file 工具 — 创建或覆盖文件
// ---------------------------------------------------------------------------

import { mkdir, readFile } from "node:fs/promises";
import { dirname, relative, basename } from "node:path";
import { ToolKind, type AgentTool, type ToolContext, type ToolResult } from "../types.js";
import { resolvePath, confine } from "../sandbox.js";
import { computeFileDiff } from "../diff.js";
import { writeFileWithEol } from "../eol.js";

/** write_file 工具的参数格式 */
export interface WriteFileArgs {
  /** 文件路径（相对于 cwd 或绝对路径） */
  path: string;
  /** 要写入的文件内容 */
  content: string;
}

/**
 * write_file 工具 — 创建或覆盖文件。
 */
export const writeFileTool: AgentTool<WriteFileArgs> = {
  name: "write_file",
  kind: ToolKind.Edit,
  description:
    "创建或覆盖文件。如果父目录不存在会自动创建。适用于创建新文件或完全替换文件内容。请勿用此工具创建 _temp_、_debug_ 等用于诊断/调试的临时文件——如需诊断请改用 bash 工具内联脚本（node -e）。",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "文件路径（相对于当前工作目录或绝对路径）",
      },
      content: {
        type: "string",
        description: "要写入的文件内容",
      },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },

  async execute(args: WriteFileArgs, ctx: ToolContext): Promise<ToolResult> {
    if (!args?.path || typeof args.path !== "string") {
      return { success: false, data: "缺少必要参数 path", error: "INVALID_ARGS" };
    }
    if (args.content === undefined || args.content === null) {
      return { success: false, data: "缺少必要参数 content", error: "INVALID_ARGS" };
    }

    const filePath = resolvePath(args.path, ctx.cwd);

    try {
      if (ctx.writeRoots && ctx.writeRoots.length > 0) {
        const conf = await confine(ctx.writeRoots, filePath);
        if (!conf.ok) {
          return { success: false, data: conf.error, error: "OUTSIDE_WRITE_ROOTS" };
        }
      }

      let oldContent = "";
      let existedBefore = false;
      try {
        oldContent = await readFile(filePath, "utf-8");
        existedBefore = true;
      } catch {
        // 文件不存在，这是新建文件
      }

      await mkdir(dirname(filePath), { recursive: true });

      const content = args.content;
      await writeFileWithEol(filePath, oldContent, content);

      const diff = computeFileDiff(oldContent, content, filePath);
      diff.existedBefore = existedBefore;

      const lineCount = content.split("\n").length;
      const byteSize = Buffer.byteLength(content, "utf-8");

      const action = existedBefore ? "已修改" : "已创建";
      const diffSummary = existedBefore
        ? `，+${diff.additions} -${diff.deletions}`
        : `，+${diff.additions} 行（新建）`;

      const fileName = basename(filePath);
      const summary = existedBefore
        ? `📝 修改: ${fileName} (+${diff.additions} -${diff.deletions})`
        : `📝 新建: ${fileName} (+${diff.additions} 行)`;

      return {
        success: true,
        data: `文件${action}：${relative(ctx.cwd, filePath).replace(/\\/g, "/")}（${lineCount} 行，${byteSize} 字节${diffSummary}）`,
        summary,
        diff,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        data: `写入文件失败：${message}`,
        error: "WRITE_ERROR",
      };
    }
  },
};
