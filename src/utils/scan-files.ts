// ---------------------------------------------------------------------------
// 递归扫描项目源码文件（排除 node_modules 等非源码目录）
// 启动时调用一次，结果缓存为扁平路径数组传给 UI
// ---------------------------------------------------------------------------

import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

/** 需要跳过的目录名（任何层级） */
const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  ".dskcode",
  ".claude",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".nx",
  "coverage",
  ".cache",
  ".nyc_output",
  ".vscode",
  ".idea",
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  "target",
  "vendor",
  "bower_components",
  "jspm_packages",
]);

/** 只索引这些源码扩展名 */
const SOURCE_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".vue", ".svelte", ".astro",
  ".css", ".scss", ".less",
  ".html",
  ".json",
  ".md",
  ".yaml", ".yml",
  ".toml",
]);

/**
 * 递归扫描 dir 下的所有文件，返回相对于 baseDir 的路径数组。
 *
 * 优化手段：
 *  - readdir withFileTypes 省掉 stat 调用（减少一半 syscall）
 *  - 同层目录的 readdir 用 Promise.all 并行
 *  - 跳过以 . 开头的隐藏目录和已知非源码目录
 *
 * 性能预期（SSD）：
 *    1,000 文件 → ~15ms
 *   10,000 文件 → ~150ms
 *   50,000 文件 → ~800ms
 */
export async function scanProjectFiles(
  baseDir: string,
  dir?: string,
): Promise<string[]> {
  const currentDir = dir ?? baseDir;

  let entries;
  try {
    entries = await readdir(currentDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  const dirs: string[] = [];

  for (const entry of entries) {
    const name = entry.name;
    if (IGNORE_DIRS.has(name) || name.startsWith(".")) continue;

    if (entry.isDirectory()) {
      dirs.push(name);
    } else if (entry.isFile()) {
      const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
      if (SOURCE_EXTS.has(ext)) {
        files.push(relative(baseDir, join(currentDir, name)));
      }
    }
  }

  // 同层子目录并行扫描
  const nested = await Promise.all(
    dirs.map((d) => scanProjectFiles(baseDir, join(currentDir, d))),
  );

  for (const n of nested) {
    files.push(...n);
  }

  return files;
}
