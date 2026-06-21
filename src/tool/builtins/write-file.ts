// ---------------------------------------------------------------------------
// write_file 工具 — 创建或覆盖文件
// ---------------------------------------------------------------------------

import { writeFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Tool, ToolContext, ToolResult, JSONSchema } from "../types.js";
import { resolvePath } from "../sandbox.js";
import { computeFileDiff } from "../diff.js";

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
    "创建或覆盖文件。如果父目录不存在会自动创建。适用于创建新文件或完全替换文件内容。",
  parameters: writeFileSchema,

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
      await writeFile(filePath, content, "utf-8");

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

      return {
        success: true,
        data: `文件${action}：${filePath}（${lineCount} 行，${byteSize} 字节${diffSummary}）`,
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