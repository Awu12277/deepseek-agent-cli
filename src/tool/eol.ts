// ---------------------------------------------------------------------------
// 行尾（EOL）风格检测与保留 — 写工具统一使用此模块
// ---------------------------------------------------------------------------
//
// 解决问题：原文件为 CRLF（Windows 项目常态）时，写工具若直接 writeFile
// 新内容（往往以 LF 编码），会导致整文件 EOL 翻转，git diff 全文件飘红，
// AI 看到大量"假改动"后陷入修复循环。此模块提供公共的 EOL 检测与落盘封装。
//
// 设计要点：
// - 检测策略与 diff.ts 的 splitLines 保持一致：首个 CRLF 早于首个 LF → CRLF
// - 对原内容做 EOL 探测，按探测结果统一新内容的行尾
// - 保留原文件是否以行尾符结尾（trailing newline）的特征

import { writeFile } from "node:fs/promises";

/**
 * 检测文本的行尾风格。
 *
 * 与 diff.ts 的 splitLines 探测策略一致：
 * - 找到最早出现的换行符位置；若最早的是 \r\n 则判为 CRLF，否则 LF
 *
 * @returns 行尾字符串："\r\n" 或 "\n"；空文本默认 "\n"
 */
export function detectEol(text: string): string {
  if (text.length === 0) return "\n";

  const crlfIdx = text.indexOf("\r\n");
  const lfIdx = text.indexOf("\n");

  if (crlfIdx !== -1 && (lfIdx === -1 || crlfIdx <= lfIdx)) {
    return "\r\n";
  }
  return "\n";
}

/**
 * 检测文本是否以行尾符结尾（trailing newline）。
 */
export function hasTrailingNewline(text: string): boolean {
  return text.endsWith("\n") || text.endsWith("\r\n");
}

/**
 * 按给定 EOL 规整文本，并保留与原内容一致的"是否以行尾结尾"特征。
 *
 * 规整步骤：
 * 1. 先统一拆成行片段（兼容现有 \r\n 与 \n 混合）
 * 2. 用目标 EOL 重新拼接
 * 3. 若原内容以行尾结尾但规整后没有，补一个；反之不补
 *
 * 用于写入前对 newContent 做归一化，保证不在 EOL 上产生噪声 diff。
 *
 * @param originalContent 原文件内容（用于探测 EOL 风格与尾行尾特征）
 * @param newContent      待写入的新内容
 * @returns               应实际落盘的内容
 */
export function normalizeEol(originalContent: string, newContent: string): string {
  const targetEol = detectEol(originalContent);

  // 拆行：兼容混合 \r\n / \n；先把 \r\n 统一成 \n 再按 \n 拆
  const lines = newContent.replace(/\r\n/g, "\n").split("\n");

  // 判断原内容是否以行尾符结尾
  const originalHasTrailing = hasTrailingNewline(originalContent);

  // newContent 经 replace+split 后，行尾结尾会在末尾多一个空行元素
  // 如 "a\nb\n" → ["a","b",""]，"a\nb" → ["a","b"]
  const newHasTrailing = lines.length > 0 && lines[lines.length - 1] === "";

  // 若新内容原本就带尾行尾，split 出的末尾空字符串保留即可
  // 若新内容不带尾行尾，但原内容带，则补一个
  let result = lines.join(targetEol);
  if (originalHasTrailing && !newHasTrailing) {
    result += targetEol;
  }
  // 若新内容带尾行尾但原内容不带：去掉末尾 EOL
  if (!originalHasTrailing && newHasTrailing) {
    // result 此时末尾恰有一个 targetEol，截悼
    if (result.endsWith(targetEol)) {
      result = result.slice(0, -targetEol.length);
    }
  }

  return result;
}

/**
 * 写文件并保留原文件的 EOL 风格与尾行尾特征。
 *
 * - 原内容存在时：按原 EOL 归一化新内容后写入
 * - 原内容不存在（新建文件）：LF + 保留新内容自带的尾行尾特征
 *
 * 所有写工具（write_file / edit_file / multi_edit / delete_range）应统一走此函数，
 * 避免 EOL 翻转造成的全文件 diff 风暴。
 *
 * @param filePath        目标文件绝对路径
 * @param originalContent 原文件内容；文件不存在时传空字符串
 * @param newContent      新内容
 */
export async function writeFileWithEol(
  filePath: string,
  originalContent: string,
  newContent: string,
): Promise<void> {
  const content =
    originalContent.length > 0
      ? normalizeEol(originalContent, newContent)
      : newContent;
  await writeFile(filePath, content, "utf-8");
}