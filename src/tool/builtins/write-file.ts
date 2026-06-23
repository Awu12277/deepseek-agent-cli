// ---------------------------------------------------------------------------
// write_file 工具 — 创建或覆盖文件
// ---------------------------------------------------------------------------

import { mkdir, readFile } from "node:fs/promises";
import { dirname, relative, basename } from "node:path";
import type { Tool, ToolContext, ToolResult, JSONSchema } from "../types.js";
import { resolvePath, confine } from "../sandbox.js";
import { computeFileDiff } from "../diff.js";
import { writeFileWithEol } from "../eol.js";

/** write_file 工具的参数格式 */
interface WriteFileArgs {
  /** 文件路径（相对于 cwd 或绝对路径） */
  path: string;
  /** 要写入的文件内容 */
  content: string;
}

/** write_file 工具的参数 JSON Schema */
const writeFileSchema: JSONSchema = {
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
};

/**
 * write_file 工具 — 创建或覆盖文件。
 *
 * 功能：
 * - 自动创建中间目录
 * - 返回写入的行数和字节数
 */
export const writeFileTool: Tool = {
  name: "write_file",
  description:
    "创建或覆盖文件。如果父目录不存在会自动创建。适用于创建新文件或完全替换文件内容。请勿用此工具创建 _temp_、_debug_ 等用于诊断/调试的临时文件——如需诊断请改用 bash 工具内联脚本（node -e）。",
  parameters: writeFileSchema,
  readOnly: false,

  async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const params = args as WriteFileArgs;
    if (!params?.path || typeof params.path !== "string") {
      return { success: false, data: "缺少必要参数 path", error: "INVALID_ARGS" };
    }
    if (params.content === undefined || params.content === null) {
      return { success: false, data: "缺少必要参数 content", error: "INVALID_ARGS" };
    }

    const filePath = resolvePath(params.path, ctx.cwd);

    try {
      // 写入范围安全检查：确保目标在允许根目录内
      if (ctx.writeRoots && ctx.writeRoots.length > 0) {
        const conf = await confine(ctx.writeRoots, filePath);
        if (!conf.ok) {
          return { success: false, data: conf.error, error: "OUTSIDE_WRITE_ROOTS" };
        }
      }

      // 写入前快照旧内容（文件可能不存在）
      let oldContent = "";
      let existedBefore = false;
      try {
        oldContent = await readFile(filePath, "utf-8");
        existedBefore = true;
      } catch {
        // 文件不存在，这是新建文件
      }

      // 确保父目录存在
      await mkdir(dirname(filePath), { recursive: true });

      const content = String(params.content);
      // 按原文件 EOL 风格落盘，避免 CRLF/LF 翻转造成噪声 diff
      await writeFileWithEol(filePath, oldContent, content);

      // 计算文件变更 diff
      const diff = computeFileDiff(oldContent, content, filePath);
      diff.existedBefore = existedBefore;

      const lineCount = content.split("\n").length;
      const byteSize = Buffer.byteLength(content, "utf-8");

      // 构建包含 diff 摘要的返回信息
      const action = existedBefore ? "已修改" : "已创建";
      const diffSummary = existedBefore
        ? `，+${diff.additions} -${diff.deletions}`
        : `，+${diff.additions} 行（新建）`;

      // UI 一行摘要：状态 + 文件名 + 增删行数，避免暴露完整路径之外的信息
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