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
// 表格渲染
// ---------------------------------------------------------------------------

/** 表格最大总宽度 */
const TABLE_MAX_WIDTH = 90;
/** 表格列最小宽度 */
const TABLE_MIN_COL_WIDTH = 3;

/**
 * 计算单个字符在终端中的显示宽度。
 * CJK 文字、全角符号、emoji 占 2 格；其余占 1 格。
 */
function charWidth(ch: string): number {
  const cp = ch.codePointAt(0);
  if (cp === undefined) return 0;

  // CJK 相关范围
  if (
    (cp >= 0x1100 && cp <= 0x115F) || // Hangul Jamo
    cp === 0x2329 || cp === 0x232A ||
    (cp >= 0x2E80 && cp <= 0xA4CF) || // CJK Radicals ~ Yi
    (cp >= 0xA960 && cp <= 0xA97F) || // Hangul Extended
    (cp >= 0xAC00 && cp <= 0xD7AF) || // Hangul Syllables
    (cp >= 0xF900 && cp <= 0xFAFF) || // CJK Compat
    (cp >= 0xFE10 && cp <= 0xFE1F) || // Vertical forms
    (cp >= 0xFF01 && cp <= 0xFF60) || // Fullwidth
    (cp >= 0xFFE0 && cp <= 0xFFE6) ||
    (cp >= 0x1F000 && cp <= 0x1FFFF)   // Emoji / Symbols
  ) {
    return 2;
  }
  return 1;
}

/** 计算字符串在终端中的视觉宽度 */
function visualWidth(text: string): number {
  let w = 0;
  for (const ch of text) {
    w += charWidth(ch);
  }
  return w;
}

/** 用空格将字符串填充到目标视觉宽度 */
function padToWidth(text: string, targetWidth: number, align: "left" | "center" | "right"): string {
  const vw = visualWidth(text);
  const delta = targetWidth - vw;
  if (delta <= 0) return text;

  const leftPad = align === "right" ? delta : align === "center" ? Math.floor(delta / 2) : 0;
  const rightPad = delta - leftPad;

  return " ".repeat(leftPad) + text + " ".repeat(rightPad);
}

/** 解析表格一行为单元格数组 */
function parseTableCells(line: string): string[] {
  const t = line.trim();
  // 去掉首尾的 |，再按 | 切割
  const inner = t.slice(1, t.length - 1);
  return inner.split("|").map((c) => c.trim());
}

/** 从分隔行解析每列对齐方式 */
function parseAlignments(sepLine: string): Array<"left" | "center" | "right"> {
  const cells = parseTableCells(sepLine);
  return cells.map((c) => {
    const l = c.startsWith(":");
    const r = c.endsWith(":");
    if (l && r) return "center";
    if (r) return "right";
    return "left";
  });
}

/**
 * 渲染 Markdown 表格为终端框线表格。
 *
 * 输出示例：
 * ┌──────────┬──────────────────────────┬──────────────────────────┐
 * │ 位置     │ 原内容                   │ 新内容                   │
 * ├──────────┼──────────────────────────┼──────────────────────────┤
 * │ 第 12 行 │ interface FileDiffs {    │ interface Diffs {        │
 * └──────────┴──────────────────────────┴──────────────────────────┘
 */
function TableRenderer({ text }: { text: string }): ReactNode {
  const rawLines = text.split("\n").filter((l) => l.trim().length > 0);
  if (rawLines.length < 2) return <Text>{text}</Text>;

  // 找到分隔行
  let sepIdx = -1;
  for (let k = 0; k < rawLines.length; k++) {
    if (isTableSepRow(rawLines[k]!)) {
      sepIdx = k;
      break;
    }
  }
  if (sepIdx === -1) return <Text>{text}</Text>;

  // 表头（分隔行之前的所有行合并为一行，防止多行表头）
  const headerText = rawLines.slice(0, sepIdx).join("");
  const headerCells = parseTableCells(headerText);
  const alignments = parseAlignments(rawLines[sepIdx]!);
  const dataRows = rawLines.slice(sepIdx + 1).map(parseTableCells);

  const colCount = headerCells.length;

  // 计算每列最大视觉宽度
  const colMaxWidths = headerCells.map((_, ci) => {
    let max = visualWidth(headerCells[ci] ?? "");
    for (const row of dataRows) {
      const w = visualWidth(row[ci] ?? "");
      if (w > max) max = w;
    }
    return Math.max(max, TABLE_MIN_COL_WIDTH);
  });

  // 计算每列最终宽度（留 2 格边距 = 左右各 1 空格）
  const margin = 2;
  const totalMinWidth = colMaxWidths.reduce((s, w) => s + w + margin, 1); // +1 for leading │
  let colWidths: number[];
  if (totalMinWidth <= TABLE_MAX_WIDTH) {
    colWidths = colMaxWidths;
  } else {
    // 超出总宽 → 等比例缩减
    const available = TABLE_MAX_WIDTH - 1 - margin * colCount;
    const sum = colMaxWidths.reduce((s, w) => s + w, 0);
    colWidths = colMaxWidths.map((w) => Math.max(TABLE_MIN_COL_WIDTH, Math.floor((w / sum) * available)));
  }

  // 框线字符
  const H = "─";
  const makeSep = (l: string, m: string, r: string) =>
    l + colWidths.map((w) => H.repeat(w + margin)).join(m) + r;

  const topBorder = makeSep("┌", "┬", "┐");
  const midBorder = makeSep("├", "┼", "┤");
  const botBorder = makeSep("└", "┴", "┘");

  // 渲染一行单元格
  function rowLine(cells: string[], keyBase: string): ReactNode {
    return (
      <Text key={keyBase}>
        {"│"}
        {cells.map((cell, ci) => (
          <Text key={ci}>
            {" "}
            {padToWidth(cell.slice(0, colWidths[ci] ?? TABLE_MIN_COL_WIDTH), colWidths[ci] ?? TABLE_MIN_COL_WIDTH, alignments[ci] ?? "left")}
            {" "}│
          </Text>
        ))}
      </Text>
    );
  }

  const rows: ReactNode[] = [
    <Text key="top" color="#888888">{topBorder}</Text>,
    rowLine(headerCells, "hdr"),
    <Text key="mid" color="#888888">{midBorder}</Text>,
    ...dataRows.map((cells, ri) => rowLine(cells, `d${ri}`)),
    <Text key="bot" color="#888888">{botBorder}</Text>,
  ];

  return (
    <Box flexDirection="column" marginTop={1}>
      {rows}
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
