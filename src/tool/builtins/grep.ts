// ---------------------------------------------------------------------------
// grep 工具 — 文件内容正则搜索
// ---------------------------------------------------------------------------

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import type { Tool, ToolContext, ToolResult, JSONSchema } from "../types.js";
import { truncateOutput } from "../sandbox.js";

/** grep 工具的参数格式 */
interface GrepArgs {
  /** 正则表达式模式 */
  pattern: string;
  /** 搜索的目录路径，默认为 cwd */
  directory?: string;
  /** 文件扩展名过滤（如 "ts"、"json"），不含点号 */
  include?: string;
  /** 是否大小写敏感，默认 false */
  case_sensitive?: boolean;
  /** 最大搜索文件数，默认 200 */
  max_files?: number;
}

/** grep 工具的参数 JSON Schema */
const grepSchema: JSONSchema = {
  type: "object",
  properties: {
    pattern: {
      type: "string",
      description: "正则表达式搜索模式",
    },
    directory: {
      type: "string",
      description: "搜索的目录路径，默认为当前工作目录",
    },
    include: {
      type: "string",
      description: "文件扩展名过滤（如 ts、json），不含点号",
    },
    case_sensitive: {
      type: "boolean",
      description: "是否大小写敏感，默认 false",
    },
    max_files: {
      type: "number",
      description: "最大搜索文件数，默认 200",
    },
  },
  required: ["pattern"],
  additionalProperties: false,
};

/** 单个匹配结果 */
interface GrepMatch {
  /** 相对文件路径 */
  file: string;
  /** 行号（1-based） */
  line: number;
  /** 匹配行内容 */
  content: string;
}

/**
 * 递归遍历目录收集文件路径。
 */
async function collectFiles(
  dir: string,
  baseDir: string,
  extension?: string,
  maxFiles = 200,
): Promise<string[]> {
  const results: string[] = [];
  let entries;

  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (results.length >= maxFiles) break;

    // 跳过常见忽略目录
    if (entry.isDirectory() && (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist")) {
      continue;
    }

    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      results.push(...await collectFiles(fullPath, baseDir, extension, maxFiles - results.length));
    } else {
      // 如果指定了扩展名过滤，只匹配对应扩展名的文件
      if (extension && !entry.name.endsWith(`.${extension}`)) {
        continue;
      }
      results.push(fullPath);
    }
  }

  return results;
}

/**
 * grep 工具 — 在文件内容中搜索正则表达式匹配。
 *
 * 功能：
 * - 正则表达式搜索
 * - 支持大小写敏感/不敏感
 * - 支持文件扩展名过滤
 * - 返回匹配行的文件路径、行号和内容
 * - 自动跳过 node_modules、.git、dist 目录
 */
export const grepTool: Tool = {
  name: "grep",
  description:
    "在文件内容中搜索正则表达式。返回匹配行的文件路径、行号和内容。支持大小写敏感、文件扩展名过滤。",
  parameters: grepSchema,
  readOnly: true,

  async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const params = args as GrepArgs;
    if (!params?.pattern || typeof params.pattern !== "string") {
      return { success: false, data: "缺少必要参数 pattern", error: "INVALID_ARGS" };
    }

    const searchDir = params.directory
      ? (isAbsolute(params.directory) ? params.directory : join(ctx.cwd, params.directory))
      : ctx.cwd;
    const maxFiles = params.max_files ?? 200;

    try {
      // 编译正则表达式
      const flags = params.case_sensitive ? "g" : "gi";
      const regex = new RegExp(params.pattern, flags);

      // 检查搜索目录
      const dirStat = await stat(searchDir);
      if (!dirStat.isDirectory()) {
        return { success: false, data: `路径不是目录：${searchDir}`, error: "NOT_DIRECTORY" };
      }

      // 收集文件并搜索
      const files = await collectFiles(searchDir, searchDir, params.include, maxFiles);
      const matches: GrepMatch[] = [];

      for (const filePath of files) {
        try {
          const content = await readFile(filePath, "utf-8");
          const lines = content.split("\n");
          const relPath = relative(searchDir, filePath);

          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i]!)) {
              // 重置 lastIndex（因为用了 g 标志）
              regex.lastIndex = 0;
              matches.push({
                file: relPath,
                line: i + 1,
                content: lines[i]!,
              });
              if (matches.length >= 500) break;
            }
          }

          if (matches.length >= 500) break;
        } catch {
          // 跳过无法读取的文件（如二进制文件）
          continue;
        }
      }

      if (matches.length === 0) {
        return {
          success: true,
          data: `未找到匹配 "${params.pattern}" 的内容`,
          summary: `🔍 "${params.pattern}" → 0 条命中`,
        };
      }

      // 格式化输出
      const output = matches
        .map((m) => `${m.file}:${m.line}: ${m.content}`)
        .join("\n");

      // 按文件汇总，UI 摘要不暴露具体行内容
      const fileSet = new Set(matches.map((m) => m.file));
      const summary = `🔍 "${params.pattern}" → ${matches.length} 条命中 / ${fileSet.size} 个文件`;

      return {
        success: true,
        data: truncateOutput(output),
        summary,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        data: `内容搜索失败：${message}`,
        error: "GREP_ERROR",
      };
    }
  },
};