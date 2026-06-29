// ---------------------------------------------------------------------------
// HighlightedText — AI 回复文本高亮渲染
//
// 支持四种语法：
//   `` `code` ``          → 天蓝色（代码标识符、文件路径）
//   `**bold**`            → 紫色（强调内容，如"第 12 行"）
//   ```...``` 代码块       → 独立块渲染，diff 内容自动绿/红着色
//   | col | col | 表格     → 框线表格，自动对齐
// 流式传输中未闭合的标记自动降级为纯文本，不会闪烁。
// ---------------------------------------------------------------------------

import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { detectTermWidth, layoutTable } from "./table-layout.js";

/** 解析后的文本段类型 */
type SegmentType = "plain" | "code" | "bold" | "code_block" | "table";

interface Segment {
  text: string;
  type: SegmentType;
}

// ---------------------------------------------------------------------------
// 第 0 遍：提取三反引号代码块
// ---------------------------------------------------------------------------

/**
 * 在全文中查找 ```...``` 代码块，将其标记为 "code_block" 类型。
 * 代码块之外的内容保持 "plain" 类型，后续交给 bold/code 解析。
 *
 * 未闭合的三反引号降级为纯文本（流式传输安全）。
 */
function parseCodeBlocks(text: string): Segment[] {
  const segments: Segment[] = [];
  let current = 0;

  while (current < text.length) {
    const openIdx = text.indexOf("```", current);

    if (openIdx === -1) {
      segments.push({ text: text.slice(current), type: "plain" });
      break;
    }

    if (openIdx > current) {
      segments.push({ text: text.slice(current, openIdx), type: "plain" });
    }

    const closeIdx = text.indexOf("```", openIdx + 3);

    if (closeIdx === -1) {
      // 未闭合 → 降级为纯文本
      segments.push({ text: text.slice(openIdx), type: "plain" });
      break;
    }

    // 提取代码块内容（含开头的语言标识行）
    const codeContent = text.slice(openIdx + 3, closeIdx);
    segments.push({ text: codeContent, type: "code_block" });
    current = closeIdx + 3;
  }

  return segments;
}

// ---------------------------------------------------------------------------
// 第 0.5 遍：Markdown 表格检测（在 plain 段内）
// ---------------------------------------------------------------------------

/** 判断一行是不是表格行（以 | 开头并以 | 结尾） */
function isTableRow(line: string): boolean {
  const t = line.trim();
  return /^\|.+\|$/.test(t);
}

/** 判断一行是不是表格分隔行（|:---:|:---:| 等） */
function isTableSepRow(line: string): boolean {
  const t = line.trim();
  // 字符类需包含 | 以匹配多列分隔行，如 |---|---|
  return /^\|[-: |]+\|$/.test(t) && t.includes("-");
}

/**
 * 在 plain 文本中检测 Markdown 表格块（连续的 `|...|` 行），标记为 "table" 类型。
 *
 * 表格判定条件：
 * 1. 开头行是表格行
 * 2. 第二行是分隔行（含 `-`）
 * 3. 第三行也是表格行
 */
function parseTables(text: string): Segment[] {
  const lines = text.split("\n");
  const result: Segment[] = [];
  let plainBuf = "";

  function flushPlain() {
    if (plainBuf) {
      result.push({ text: plainBuf, type: "plain" });
      plainBuf = "";
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";

    if (
      isTableRow(line) &&
      i + 1 < lines.length &&
      isTableSepRow(lines[i + 1] ?? "") &&
      i + 2 < lines.length &&
      isTableRow(lines[i + 2] ?? "")
    ) {
      flushPlain();

      // 收集所有连续的表格行（含分隔行）
      const tableLineList: string[] = [];
      let j = i;
      while (j < lines.length && isTableRow(lines[j] ?? "")) {
        tableLineList.push(lines[j]!);
        j++;
      }

      result.push({ text: tableLineList.join("\n"), type: "table" });
      i = j - 1;
    } else {
      if (plainBuf) plainBuf += "\n" + line;
      else plainBuf = line;
    }
  }

  flushPlain();
  return result;
}

// ---------------------------------------------------------------------------
// 第 1 遍：**bold** 解析（与之前相同）
// ---------------------------------------------------------------------------

/**
 * 按 `**...**` 对拆分为段。
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

// ---------------------------------------------------------------------------
// 第 2 遍：`code` 解析（处理 plain 和 bold 段内的单反引号对）
// ---------------------------------------------------------------------------

/**
 * 在纯文本中查找成对的单反引号，返回 [plain, code, plain, ...] 段序列。
 *
 * - 只处理 `...` 单反引号对；多反引号序列降级为纯文本。
 * - 未闭合的反引号降级为纯文本。
 */
function parseInlineCode(text: string): Segment[] {
  const result: Segment[] = [];
  let current = 0;

  while (current < text.length) {
    const openIdx = text.indexOf("`", current);

    if (openIdx === -1) {
      result.push({ text: text.slice(current), type: "plain" });
      break;
    }

    if (openIdx > current) {
      result.push({ text: text.slice(current, openIdx), type: "plain" });
    }

    // 计算连续反引号的数量
    let runLength = 1;
    while (
      openIdx + runLength < text.length &&
      text[openIdx + runLength] === "`"
    ) {
      runLength++;
    }

    if (runLength === 1) {
      // 单反引号对 → code 段
      const closeIdx = text.indexOf("`", openIdx + 1);

      if (closeIdx === -1) {
        result.push({ text: text.slice(openIdx), type: "plain" });
        break;
      }

      result.push({ text: text.slice(openIdx + 1, closeIdx), type: "code" });
      current = closeIdx + 1;
    } else {
      // 多反引号序列（```、`` 等）保持原样
      result.push({
        text: text.slice(openIdx, openIdx + runLength),
        type: "plain",
      });
      current = openIdx + runLength;
    }
  }

  return result;
}

/**
 * 在 plain 和 bold 段内按 `` `...` `` 对拆分为 code 段。
 *
 * - **plain** 段内的 code → 标蓝，剩余部分保持默认色
 * - **bold** 段内的 code → 标蓝，剩余部分保持紫色
 * - 多反引号序列（```` ```code``` ````、`` ``code`` `` 等）统一降级为纯文本
 * - code_block / table 段直接透传
 */
function parseCodePairs(segments: Segment[]): Segment[] {
  const result: Segment[] = [];

  for (const seg of segments) {
    if (seg.type === "code_block" || seg.type === "table") {
      result.push(seg);
      continue;
    }

    // 对 plain 和 bold 的内容都做反引号解析
    const parts = parseInlineCode(seg.text);

    for (const part of parts) {
      if (part.type === "code") {
        // 反引号内容始终标蓝
        result.push(part);
      } else if (seg.type === "bold") {
        // bold 段内非反引号部分 → 保持紫色
        result.push({ text: part.text, type: "bold" });
      } else {
        // plain 段内非反引号部分 → 保持默认色
        result.push(part);
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// 代码块渲染
// ---------------------------------------------------------------------------

/** 添加行绿色 */
const DIFF_ADD_COLOR = "#22c55e";
/** 删除行红色 */
const DIFF_DEL_COLOR = "#ef4444";
/** Hunk 头青色 */
const DIFF_HUNK_COLOR = "#00cccc";

/**
 * 渲染三反引号代码块的内容，对 diff 风格的内容行着色。
 *
 * 代码块内的第一行若为纯文本（非 `+`/`-`/`@@`/空格开头），
 * 视为语言标识（如 "diff"、"python"），用灰色标出。
 */
function CodeBlockRenderer({ code }: { code: string }): ReactNode {
  const lines = code.split("\n");

  // 判断第一行是否为语言标识行
  const firstLine = lines[0] ?? "";
  const hasLangLine =
    firstLine.trim().length > 0 &&
    !firstLine.startsWith("+") &&
    !firstLine.startsWith("-") &&
    !firstLine.startsWith("@@") &&
    !firstLine.startsWith(" ");

  const lang = hasLangLine ? firstLine : undefined;
  const codeLines = hasLangLine ? lines.slice(1) : lines;

  // 空内容
  if (codeLines.length === 0) {
    return hasLangLine ? (
      <Box marginLeft={2}>
        <Text color="#888888">┌ {lang}</Text>
      </Box>
    ) : null;
  }

  return (
    <Box flexDirection="column" marginLeft={2} marginTop={1}>
      {lang && <Text color="#888888">┌ {lang}</Text>}
      {codeLines.map((line, i) => {
        if (line.startsWith("+")) {
          return (
            <Text key={i} color={DIFF_ADD_COLOR}>
              {line}
            </Text>
          );
        }
        if (line.startsWith("-")) {
          return (
            <Text key={i} color={DIFF_DEL_COLOR}>
              {line}
            </Text>
          );
        }
        if (line.startsWith("@@")) {
          return (
            <Text key={i} color={DIFF_HUNK_COLOR}>
              {line}
            </Text>
          );
        }
        // 上下文行或非 diff 代码行
        return <Text key={i}>{line}</Text>;
      })}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// 表格渲染（计算逻辑已抽到 table-layout.ts，本文件仅负责把结果印到 Ink）
// ---------------------------------------------------------------------------

/**
 * 渲染 Markdown 表格为终端框线表格。
 *
 * 输出示例（终端宽度足够时）：
 * ┌──────────┬──────────────────────────┬──────────────────────────┐
 * │ 位置     │ 原内容                   │ 新内容                   │
 * ├──────────┼──────────────────────────┼──────────────────────────┤
 * │ 第 12 行 │ interface FileDiffs {    │ interface Diffs {        │
 * └──────────┴──────────────────────────┴──────────────────────────┘
 *
 * 行为：
 * - 列宽跟随终端宽度自适应（不再硬编码 90）
 * - 单 cell 超长时按视觉宽度自动换行；表格行高 = 该行最大 wrap 行数
 * - 内容不会被截断丢失（不像之前的 cell.slice）
 * - 终端宽度未知时使用 80 列兜底
 */
function TableRenderer({ text }: { text: string }): ReactNode {
  const termWidth = detectTermWidth();
  const layout = layoutTable(text, { termWidth });

  // 无效输入（无分隔行）→ 降级为纯文本
  if (layout.colWidths.length === 0) {
    return <Text>{text}</Text>;
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      {layout.lines.map((line, i) => {
        // 框线（top / mid / bot）用灰色；数据行用默认色
        const isFirst = i === 0;
        const isLast = i === layout.lines.length - 1;
        const isMid = !isFirst && !isLast && line.startsWith("├");
        const color = isFirst || isLast || isMid ? "#888888" : undefined;
        return (
          <Text key={i} color={color}>{line}</Text>
        );
      })}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Emoji 检测 — 跳过图标字符的颜色包裹
// ---------------------------------------------------------------------------

/** 匹配 emoji 相关 code point 的正则 */
const EMOJI_CP_RE = /[\u{1F000}-\u{1FFFF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{2600}-\u{27BF}\u{231A}-\u{23FF}\u{2934}\u{2935}\u{25AA}-\u{25FE}\u{2B50}\u{2B55}\u{00A9}\u{00AE}\u{2122}\u{3030}\u{303D}\u{3297}\u{3299}]/u;

/**
 * 检测一个 grapheme cluster 是否属于 emoji 或图标字符。
 * 此类字符在 bold 渲染中应跳过颜色包裹，避免终端渲染异常。
 */
function isEmojiCluster(text: string): boolean {
  return EMOJI_CP_RE.test(text);
}

/**
 * 将文本按 grapheme cluster 分割，标记每个 cluster 是否为 emoji。
 * 降级策略：若 Intl.Segmenter 不可用，将整个文本视为纯文本。
 */
function splitEmojiClusters(
  text: string,
): Array<{ text: string; isEmoji: boolean }> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const segmenter = new (Intl as any).Segmenter("en", {
      granularity: "grapheme",
    });
    const segments = [...segmenter.segment(text)];
    return segments.map((s) => ({
      text: s.segment,
      isEmoji: isEmojiCluster(s.segment),
    }));
  } catch {
    // 降级：整个文本作为一个纯文本块
    return [{ text, isEmoji: false }];
  }
}

/**
 * 渲染 bold（紫色）文本，对 emoji 字符跳过颜色包裹。
 */
function renderBoldText(text: string, key: number | string): ReactNode {
  const clusters = splitEmojiClusters(text);

  // 不含 emoji — 简单路径（和之前一致）
  if (clusters.length === 1 && !clusters[0]!.isEmoji) {
    return (
      <Text key={key} color={BOLD_COLOR}>
        {text}
      </Text>
    );
  }

  // 合并相邻的同类 cluster 减少嵌套
  const groups: Array<{ text: string; isEmoji: boolean }> = [];
  for (const c of clusters) {
    const last = groups[groups.length - 1];
    if (last && last.isEmoji === c.isEmoji) {
      last.text += c.text;
    } else {
      groups.push({ text: c.text, isEmoji: c.isEmoji });
    }
  }

  return (
    <Text key={key}>
      {groups.map((g, i) =>
        g.isEmoji ? (
          g.text
        ) : (
          <Text key={i} color={BOLD_COLOR}>
            {g.text}
          </Text>
        ),
      )}
    </Text>
  );
}

// ---------------------------------------------------------------------------
// 高亮颜色常量
// ---------------------------------------------------------------------------

/** 行内代码高亮色 — 天蓝 */
const CODE_COLOR = "#00BFFF";
/** 加粗强调色 — 紫色 */
const BOLD_COLOR = "#A855F7";

// ---------------------------------------------------------------------------
// 主组件
// ---------------------------------------------------------------------------

interface HighlightedTextProps {
  children: string;
}

/**
 * 渲染 AI 回复文本，支持四种标记高亮：
 * - `` `code` ``        → 天蓝色
 * - `**bold**`          → 紫色
 * - ```` ```diff ````   → 独立块，`+` 绿色 / `-` 红色 / `@@` 青色
 * - `| ... |` Markdown  → 框线表格
 */
export function HighlightedText({ children: text }: HighlightedTextProps): ReactNode {
  // 第 0 遍：提取 ```...``` 代码块
  const codeBlockSegments = parseCodeBlocks(text);

  // 第 0.5 遍：在非代码块的 plain 段中检测 Markdown 表格
  const tableSegments: Segment[] = [];
  for (const seg of codeBlockSegments) {
    if (seg.type === "code_block") {
      tableSegments.push(seg);
    } else {
      tableSegments.push(...parseTables(seg.text));
    }
  }

  // 第 1 遍：在 inline plain 段内解析 **bold**
  const boldSegments: Segment[] = [];
  for (const seg of tableSegments) {
    if (seg.type === "code_block" || seg.type === "table") {
      boldSegments.push(seg);
    } else {
      boldSegments.push(...parseBoldPairs(seg.text));
    }
  }

  // 第 2 遍：在 inline plain 段内解析 `code`
  const segments = parseCodePairs(boldSegments);

  // 检查是否包含块级元素
  const hasBlock = segments.some(
    (s) => s.type === "code_block" || s.type === "table",
  );

  // ---- 无块级元素：纯内联渲染 ----
  if (!hasBlock) {
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
            return renderBoldText(seg.text, i);
          }
          return seg.text;
        })}
      </Text>
    );
  }

  // ---- 有块级元素：分组渲染（inline 组 + 块级渲染） ----
  const rendered: ReactNode[] = [];
  let inlineGroup: Segment[] = [];

  function flushInline(groupIdx: number) {
    if (inlineGroup.length === 0) return;
    const isSimpleInline =
      inlineGroup.length === 1 && inlineGroup[0]!.type === "plain";
    if (isSimpleInline) {
      rendered.push(
        <Text key={groupIdx} wrap="wrap">
          {inlineGroup[0]!.text}
        </Text>,
      );
    } else {
      rendered.push(
        <Text key={groupIdx} wrap="wrap">
          {inlineGroup.map((seg, j) => {
            if (seg.type === "code") {
              return (
                <Text key={j} color={CODE_COLOR}>
                  {seg.text}
                </Text>
              );
            }
            if (seg.type === "bold") {
              return renderBoldText(seg.text, j);
            }
            return seg.text;
          })}
        </Text>,
      );
    }
    inlineGroup = [];
  }

  for (const seg of segments) {
    if (seg.type === "code_block") {
      flushInline(rendered.length);
      rendered.push(
        <CodeBlockRenderer key={`b${rendered.length}`} code={seg.text} />,
      );
    } else if (seg.type === "table") {
      flushInline(rendered.length);
      rendered.push(
        <TableRenderer key={`t${rendered.length}`} text={seg.text} />,
      );
    } else {
      inlineGroup.push(seg);
    }
  }
  flushInline(rendered.length);

  return <Box flexDirection="column">{rendered}</Box>;
}
