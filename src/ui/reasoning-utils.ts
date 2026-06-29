// ---------------------------------------------------------------------------
// 思考链展示工具
// ---------------------------------------------------------------------------

/** 独立框最多保留多少行；超过则折叠为单行省略提示 */
export const DEFAULT_REASONING_MAX_LINES = 8;

/**
 * 把多段思考链拼接为单段文本，段之间用单换行连接（不空行）。
 *
 * 配合“滚动窗口”使用：思考内容越多越空行越浪费一行，改为紧凑连接，
 * 整个思考信息统一在一个框内呈现。自动过滤空段和纯空白段。
 */
export function joinReasoningSegments(segments: string[]): string {
  return segments
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join("\n");
}

/**
 * 按行"滚动"截断文本，超过 maxLines 时保留**末尾** maxLines 行（最新思考），
 * 丢弃开头的旧行。与终端自动滚屏语义一致。
 *
 * @returns
 *   - visible:     要展示的字符串（已用 \n 重组）
 *   - hiddenLines: 被滚出窗口的旧行数（0 表示未截断；保留供未来统计 / 调试）
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
    visible: lines.slice(-maxLines).join("\n"),
    hiddenLines: lines.length - maxLines,
    totalLines: lines.length,
  };
}
