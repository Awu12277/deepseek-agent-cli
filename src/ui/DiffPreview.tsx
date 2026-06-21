// ---------------------------------------------------------------------------
// Diff 预览组件 — 终端中渲染带色彩的 unified diff
// ---------------------------------------------------------------------------

import { Box, Text } from "ink";
import type { FileDiff } from "../tool/types.js";

interface DiffPreviewProps {
  /** FileDiff 对象 */
  diff: FileDiff;
}

/**
 * 解析 unified diff 文本，按行着色渲染。
 *
 * 颜色方案：
 * - `--- a/file` / `+++ b/file`  → 青色（文件头）
 * - `@@ ... @@`                  → 青色（hunk 头）
 * - `+` 添加行                   → 绿色
 * - `-` 删除行                   → 红色
 * - ` ` 上下文行                 → 灰色
 */
export function DiffPreview({ diff }: DiffPreviewProps) {
  const { patch, additions, deletions, existedBefore, filePath } = diff;

  // 无变更
  if (!patch || patch.length === 0) {
    return null;
  }

  const lines = patch.split("\n");
  const fileName = filePath.replace(/\\/g, "/").split("/").pop() ?? filePath;

  return (
    <Box flexDirection="column" marginTop={1}>
      {/* 摘要行 */}
      <Box flexDirection="row" gap={1}>
        <Text bold color="#00ffff">
          📝 {existedBefore ? "修改" : "新建"}:
        </Text>
        <Text bold>{fileName}</Text>
        <Text color="#555555">
          (+{additions} -{deletions})
        </Text>
      </Box>

      {/* Diff 内容 */}
      <Box flexDirection="column" marginLeft={2}>
        {lines.map((line, i) => (
          <DiffLine key={i} line={line} />
        ))}
      </Box>
    </Box>
  );
}

/** 渲染单行 diff 内容 */
function DiffLine({ line }: { line: string }) {
  // 文件头行
  if (line.startsWith("---") || line.startsWith("+++")) {
    return <Text color="#00cccc" bold>{line}</Text>;
  }

  // Hunk 头行 @@ -x,y +a,b @@
  if (line.startsWith("@@")) {
    // 将 @@ 标记和行号范围分别着色
    return <Text color="#00cccc">{line}</Text>;
  }

  // 添加行
  if (line.startsWith("+")) {
    return <Text color="#22c55e">{line}</Text>;
  }

  // 删除行
  if (line.startsWith("-")) {
    return <Text color="#ef4444">{line}</Text>;
  }

  // 上下文行（空格开头或空行）
  return <Text color="#6b7280">{line}</Text>;
}