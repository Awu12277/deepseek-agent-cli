// ---------------------------------------------------------------------------
// grep 工具 — 文件内容正则搜索
// ---------------------------------------------------------------------------

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { ToolKind, type AgentTool, type ToolContext, type ToolResult } from "../types.js";
import { truncateOutput, stripMentionPrefix } from "../sandbox.js";

/** grep 工具的参数格式 */
export interface GrepArgs {
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

/** 单个匹配结果 */
interface GrepMatch {
  file: string;
  line: number;
  content: string;
}

/**
 * 递归遍历目录收集文件路径。
 */
async function collectFiles(
  dir: string,
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

    if (entry.isDirectory() && (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist")) {
      continue;
    }

    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      results.push(...await collectFiles(fullPath, extension, maxFiles - results.length));
    } else {
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
 */
export const grepTool: AgentTool<GrepArgs> = {
  name: "grep",
  kind: ToolKind.Read,
  description:
    "在文件内容中搜索正则表达式。返回匹配行的文件路径、行号和内容。支持大小写敏感、文件扩展名过滤。",
  parameters: {
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
  },

  async execute(args: GrepArgs, ctx: ToolContext): Promise<ToolResult> {
    if (!args?.pattern || typeof args.pattern !== "string") {
      return { success: false, data: "缺少必要参数 pattern", error: "INVALID_ARGS" };
    }

    const dir = args.directory ? stripMentionPrefix(args.directory) : undefined;
    const searchDir = dir
      ? (isAbsolute(dir) ? dir : join(ctx.cwd, dir))
      : ctx.cwd;
    const maxFiles = args.max_files ?? 200;

    try {
      const flags = args.case_sensitive ? "g" : "gi";
      const regex = new RegExp(args.pattern, flags);

      const dirStat = await stat(searchDir);
      if (!dirStat.isDirectory()) {
        return { success: false, data: `路径不是目录：${searchDir}`, error: "NOT_DIRECTORY" };
      }

      const files = await collectFiles(searchDir, args.include, maxFiles);
      const matches: GrepMatch[] = [];

      for (const filePath of files) {
        try {
          const content = await readFile(filePath, "utf-8");
          const lines = content.split("\n");
          const relPath = relative(searchDir, filePath);

          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i] ?? "")) {
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
          continue;
        }
      }

      if (matches.length === 0) {
        return {
          success: true,
          data: `未找到匹配 "${args.pattern}" 的内容`,
          summary: `🔍 "${args.pattern}" → 0 条命中`,
        };
      }

      const output = matches
        .map((m) => `${m.file}:${m.line}: ${m.content}`)
        .join("\n");

      const fileSet = new Set(matches.map((m) => m.file));
      const summary = `🔍 "${args.pattern}" → ${matches.length} 条命中 / ${fileSet.size} 个文件`;

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
