// ---------------------------------------------------------------------------
// glob 工具 — 文件搜索（模式匹配）
// ---------------------------------------------------------------------------

import { readdir, stat } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { ToolKind, type AgentTool, type ToolContext, type ToolResult } from "../types.js";
import { truncateOutput } from "../sandbox.js";

/** glob 工具的参数格式 */
export interface GlobArgs {
  /** 搜索模式（支持 * 和 ** 通配符） */
  pattern: string;
  /** 搜索的起始目录，默认为 cwd */
  directory?: string;
}

/**
 * 将 glob 模式转换为正则表达式。
 */
function globToRegex(pattern: string): RegExp {
  let regexStr = pattern;
  regexStr = regexStr.replace(/\*\*\//g, "<<GLOBSTAR_SLASH>>");
  regexStr = regexStr.replace(/\*\*/g, "<<GLOBSTAR>>");
  regexStr = regexStr.replace(/\?/g, "<<QUESTION>>");
  regexStr = regexStr.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  regexStr = regexStr.replace(/\*/g, "[^/]*");
  regexStr = regexStr.replace(/<<GLOBSTAR_SLASH>>/g, "(.*/)?");
  regexStr = regexStr.replace(/<<GLOBSTAR>>/g, ".*");
  regexStr = regexStr.replace(/<<QUESTION>>/g, "[^/]");
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
export const globTool: AgentTool<GlobArgs> = {
  name: "glob",
  kind: ToolKind.Read,
  description:
    "按模式搜索文件路径。支持 *（匹配文件名部分）和 **（匹配多层目录）通配符。自动跳过 node_modules 和 .git 目录。",
  parameters: {
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
  },

  async execute(args: GlobArgs, ctx: ToolContext): Promise<ToolResult> {
    if (!args?.pattern || typeof args.pattern !== "string") {
      return { success: false, data: "缺少必要参数 pattern", error: "INVALID_ARGS" };
    }

    const searchDir = args.directory
      ? (isAbsolute(args.directory) ? args.directory : join(ctx.cwd, args.directory))
      : ctx.cwd;
    const regex = globToRegex(args.pattern);

    try {
      const dirStat = await stat(searchDir);
      if (!dirStat.isDirectory()) {
        return { success: false, data: `路径不是目录：${searchDir}`, error: "NOT_DIRECTORY" };
      }

      const allFiles = await walkDir(searchDir, searchDir);
      const matched = allFiles.filter((f) => regex.test(f));

      if (matched.length === 0) {
        return {
          success: true,
          data: `未找到匹配 "${args.pattern}" 的文件`,
          summary: `${args.pattern} → 0 个文件`,
        };
      }

      const limit = 200;
      const limited = matched.slice(0, limit);
      const output = limited.join("\n");
      const suffix = matched.length > limit ? `\n\n... 共 ${matched.length} 个文件，只显示前 ${limit} 个` : "";

      return {
        success: true,
        data: truncateOutput(output + suffix),
        summary: `${args.pattern} → ${matched.length} 个文件`,
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
