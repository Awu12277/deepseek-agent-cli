// ---------------------------------------------------------------------------
// HighlightedText — AI 回复文本高亮渲染
//
// 支持两种语法：
//   `` `code` ``  → 天蓝色（代码标识符、文件路径）
//   `**bold**`   → 紫色（强调内容，如"第 12 行"）
// 流式传输中未闭合的标记自动降级为纯文本，不会闪烁。
// ---------------------------------------------------------------------------

import { Text } from "ink";
import type { ReactNode } from "react";

/** 解析后的文本段类型 */
type SegmentType = "plain" | "code" | "bold";

interface Segment {
  text: string;
  type: SegmentType;
}

/**
 * 第一遍：按 `**...**` 对拆分为段。
 * 未闭合的 `**`（流式传输中）降级为纯文本。
 */
function parseBoldPairs(text: string): Segment[] {
  const segments: Segment[] = [];
  let current = 0;

  while (current < text.length) {
    const openIdx = text.indexOf("**", current);

    if (openIdx === -1) {
      segments.push({ text: text.slice(current), type: "plain" });
      break;
    }

    // ** 前的纯文本
    if (openIdx > current) {
      segments.push({ text: text.slice(current, openIdx), type: "plain" });
    }

    const closeIdx = text.indexOf("**", openIdx + 2);

    // 未闭合 → 降级为纯文本
    if (closeIdx === -1) {
      segments.push({ text: text.slice(openIdx), type: "plain" });
      break;
    }

    // 成对 **...** 内的内容 → bold
    segments.push({ text: text.slice(openIdx + 2, closeIdx), type: "bold" });
    current = closeIdx + 2;
  }

  return segments;
}

/**
 * 第二遍：在 plain 段内按 `` `...` `` 对拆分为 code 段。
 * 未闭合的反引号降级为纯文本。
 */
function parseCodePairs(segments: Segment[]): Segment[] {
  const result: Segment[] = [];

  for (const seg of segments) {
    if (seg.type !== "plain") {
      result.push(seg);
      continue;
    }

    let current = 0;
    const text = seg.text;

    while (current < text.length) {
      const openIdx = text.indexOf("`", current);

      if (openIdx === -1) {
        result.push({ text: text.slice(current), type: "plain" });
        break;
      }

      if (openIdx > current) {
        result.push({ text: text.slice(current, openIdx), type: "plain" });
      }

      const closeIdx = text.indexOf("`", openIdx + 1);

      if (closeIdx === -1) {
        result.push({ text: text.slice(openIdx), type: "plain" });
        break;
      }

      result.push({ text: text.slice(openIdx + 1, closeIdx), type: "code" });
      current = closeIdx + 1;
    }
  }

  return result;
}

/** 代码高亮色 — 天蓝 */
const CODE_COLOR = "#00BFFF";
/** 加粗强调色 — 紫色 */
const BOLD_COLOR = "#A855F7";

interface HighlightedTextProps {
  children: string;
}

/**
 * 渲染 AI 回复文本，支持两种内联标记高亮：
 * - `` `code` `` → 天蓝色
 * - `**bold**`  → 紫色
 *
 * 用法：
 * ```tsx
 * <HighlightedText>已完成。`test.ts` 中 **第 12 行** 的修改。</HighlightedText>
 * ```
 * 渲染结果：
 *   已完成。<Text color="#00BFFF">test.ts</Text> 中
 *   <Text color="#A855F7">第 12 行</Text> 的修改。
 */
export function HighlightedText({ children: text }: HighlightedTextProps): ReactNode {
  // 先解析 **bold**，再在 plain 段内解析 `code`
  const boldSegments = parseBoldPairs(text);
  const segments = parseCodePairs(boldSegments);

  // 纯文本捷径：不嵌套 Text 提高渲染性能
  const isSimple = segments.length === 1 && segments[0]!.type === "plain";
  if (isSimple) {
    return <Text wrap="wrap">{text}</Text>;
  }

  return (
    <Text wrap="wrap">
      {segments.map((seg, i) => {
        if (seg.type === "code") {
          return (
            <Text key={i} color={CODE_COLOR}>
              {seg.text}
            </Text>
          );
        }
        if (seg.type === "bold") {
          return (
            <Text key={i} color={BOLD_COLOR}>
              {seg.text}
            </Text>
          );
        }
        return seg.text;
      })}
    </Text>
  );
}
