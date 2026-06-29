// ---------------------------------------------------------------------------
// 思考链展示工具
// ---------------------------------------------------------------------------

/** 独立框最多保留多少行；超过则折叠为单行省略提示 */
export const DEFAULT_REASONING_MAX_LINES = 8;

/**
 * 把多段思考链拼接为单段文本，段之间用空行分隔。
 * 自动过滤空段和纯空白段，避免产生空块。
 */
export function joinReasoningSegments(segments: string[]): string {
  return segments
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join("\n\n");
}

/**
 * 按行截断文本，超过 maxLines 时只保留前 maxLines 行。
 *
 * @returns
 *   - visible:     要展示的字符串（已用 \n 重组）
 *   - hiddenLines: 被省略的行数（0 表示未截断）
 *   - totalLines:  原始总行数
 *
 * @pure
 */
export function truncateReasoningLines(
  text: string,
  maxLines: number,
): { visible: string; hiddenLines: number; totalLines: number } {
  const lines = text.split("\n");
  if (lines.length <= maxLines) {
    return { visible: text, hiddenLines: 0, totalLines: lines.length };
  }
  return {
    visible: lines.slice(0, maxLines).join("\n"),
    hiddenLines: lines.length - maxLines,
    totalLines: lines.length,
  };
}
