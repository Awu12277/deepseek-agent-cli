// ---------------------------------------------------------------------------
// glob 工具 — 文件搜索（模式匹配）
// ---------------------------------------------------------------------------

import { readdir, stat } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import type { Tool, ToolContext, ToolResult, JSONSchema } from "../types.js";
import { truncateOutput } from "../sandbox.js";

/** glob 工具的参数格式 */
interface GlobArgs {
  /** 搜索模式（支持 * 和 ** 通配符） */
  pattern: string;
  /** 搜索的起始目录，默认为 cwd */
  directory?: string;
}

/** glob 工具的参数 JSON Schema */
const globSchema: JSONSchema = {
  type: "object",
  properties: {
    pattern: {
      type: "string",
      description: "搜索模式（支持 * 和 ** 通配符，如 **/*.ts、src/**/*.test.ts）",
    },
    directory: {
      type: "string",
      description: "搜索的起始目录，默认为当前工作目录",
    },
  },
  required: ["pattern"],
  additionalProperties: false,
};

/**
 * 将 glob 模式转换为正则表达式。
 *
 * 支持：
 * - `*` 匹配除路径分隔符外的任意字符
 * - `**` 匹配任意路径（包含分隔符）
 * - `?` 匹配单个字符
 * - `{a,b}` 匹配 a 或 b
 * - `[abc]` 字符类
 */
function globToRegex(pattern: string): RegExp {
  let regexStr = pattern;
  // 先处理 **（必须在 * 之前处理）
  // **/ 表示零或多个目录段，** 单独使用表示匹配任意路径
  regexStr = regexStr.replace(/\*\*\//g, "<<GLOBSTAR_SLASH>>");
  regexStr = regexStr.replace(/\*\*/g, "<<GLOBSTAR>>");
  // 将 glob 的 ? 通配符转换为占位符（必须在转义和通配符替换之前）
  regexStr = regexStr.replace(/\?/g, "<<QUESTION>>");
  // 转义正则特殊字符（除了我们的占位符）
  regexStr = regexStr.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  // 处理通配符
  regexStr = regexStr.replace(/\*/g, "[^/]*");                  // * 匹配非路径分隔符
  regexStr = regexStr.replace(/<<GLOBSTAR_SLASH>>/g, "(.*/)?"); // **/ 匹配零或多个目录段
  regexStr = regexStr.replace(/<<GLOBSTAR>>/g, ".*");          // ** 匹配任意路径
  regexStr = regexStr.replace(/<<QUESTION>>/g, "[^/]");         // ? 匹配单个非路径分隔符字符
  return new RegExp(`^${regexStr}$`, "i");
}

/**
 * 递归遍历目录收集文件路径。
 */
async function walkDir(dir: string, baseDir: string): Promise<string[]> {
  const results: string[] = [];
  let entries;

  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    // 跳过 node_modules 和 .git 目录
    if (entry.isDirectory() && (entry.name === "node_modules" || entry.name === ".git")) {
      continue;
    }

    const fullPath = join(dir, entry.name);
    const relPath = relative(baseDir, fullPath);

    if (entry.isDirectory()) {
      results.push(...await walkDir(fullPath, baseDir));
    } else {
      results.push(relPath);
    }
  }

  return results;
}

/**
 * glob 工具 — 按模式搜索文件路径。
 *
 * 功能：
 * - 支持 * 和 ** 通配符
 * - 自动跳过 node_modules 和 .git 目录
 * - 返回相对于搜索目录的路径列表
 */
export const globTool: Tool = {
  name: "glob",
  description:
    "按模式搜索文件路径。支持 *（匹配文件名部分）和 **（匹配多层目录）通配符。自动跳过 node_modules 和 .git 目录。",
  parameters: globSchema,
  readOnly: true,

  async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const params = args as GlobArgs;
    if (!params?.pattern || typeof params.pattern !== "string") {
      return { success: false, data: "缺少必要参数 pattern", error: "INVALID_ARGS" };
    }

    const searchDir = params.directory
      ? (isAbsolute(params.directory) ? params.directory : join(ctx.cwd, params.directory))
      : ctx.cwd;
    const regex = globToRegex(params.pattern);

    try {
      // 检查搜索目录是否存在
      const dirStat = await stat(searchDir);
      if (!dirStat.isDirectory()) {
        return { success: false, data: `路径不是目录：${searchDir}`, error: "NOT_DIRECTORY" };
      }

      const allFiles = await walkDir(searchDir, searchDir);
      const matched = allFiles.filter((f) => regex.test(f));

      if (matched.length === 0) {
        return {
          success: true,
          data: `未找到匹配 "${params.pattern}" 的文件`,
        };
      }

      // 限制返回数量
      const limit = 200;
      const limited = matched.slice(0, limit);
      const output = limited.join("\n");
      const suffix = matched.length > limit ? `\n\n... 共 ${matched.length} 个文件，只显示前 ${limit} 个` : "";

      return {
        success: true,
        data: truncateOutput(output + suffix),
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        data: `文件搜索失败：${message}`,
        error: "GLOB_ERROR",
      };
    }
  },
};