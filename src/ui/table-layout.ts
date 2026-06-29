// ---------------------------------------------------------------------------
// Table layout — 纯计算模块（无 React/无 IO，方便单测）
//
// 设计目标：
// - 终端宽度自适应：不再硬编码最大宽度，改为读取 stdout.columns
// - 单 cell 超长时按视觉宽度换行（不截断），表格行高自适应
// - 中文字符宽度补全（0x3000 系列 CJK 标点 / ZWJ / 全角空格等）
// - 函数全 @pure，方便单测覆盖布局算法
//
// 函数注释规范见仓库根 AGENTS.md「函数注释规范」一节。
// ---------------------------------------------------------------------------

/** 表格列最小宽度（视觉宽度） */
export const TABLE_MIN_COL_WIDTH = 3;

/** 默认终端宽度（process.stdout.columns 不可用时的兜底） */
export const DEFAULT_TERM_WIDTH = 80;

/** 表格在终端里左右各留的边距（视觉宽度），避免贴边 */
export const TABLE_MARGIN = 2;

/** 对齐方式 */
export type Alignment = "left" | "center" | "right";

/** 表格布局选项 */
export interface TableLayoutOptions {
  /** 终端可用宽度（含 margin 前的总宽），默认 80 */
  termWidth?: number;
  /** 表格本身左右各留多少列（默认 2），留 0 可贴边 */
  outerMargin?: number;
}

/** 表格布局结果：所有要按行打印的字符串（含框线） */
export interface TableLayout {
  /** 总行数（含 top/mid/bot 框线） */
  lines: string[];
  /** 计算出的列宽（视觉宽度，含 margin 不含 │） */
  colWidths: number[];
  /** 表格总视觉宽度 */
  totalWidth: number;
}

// ---------------------------------------------------------------------------
// 视觉宽度
// ---------------------------------------------------------------------------

/**
 * 单个码点在终端里的显示宽度。
 *
 * CJK / 全角 / Emoji 算 2 格；其他算 1 格。
 *
 * @param cp — Unicode 码点
 * @returns 显示宽度
 */
function cpWidth(cp: number): number {
  if (
    (cp >= 0x1100 && cp <= 0x115F) || // Hangul Jamo
    cp === 0x2329 || cp === 0x232A ||
    (cp >= 0x2E80 && cp <= 0xA4CF) || // CJK Radicals ~ Yi
    (cp >= 0xA960 && cp <= 0xA97F) || // Hangul Extended
    (cp >= 0xAC00 && cp <= 0xD7AF) || // Hangul Syllables
    (cp >= 0xF900 && cp <= 0xFAFF) || // CJK Compat
    (cp >= 0xFE10 && cp <= 0xFE1F) || // Vertical forms
    (cp >= 0xFF01 && cp <= 0xFF60) || // Fullwidth ASCII / 标点
    (cp >= 0xFFE0 && cp <= 0xFFE6) || // Fullwidth signs
    (cp >= 0x1F000 && cp <= 0x1FFFF) || // Emoji / Symbols
    (cp >= 0x3000 && cp <= 0x303F) || // CJK Symbols & Punctuation（含「、。·」等）
    (cp >= 0x20000 && cp <= 0x2FFFF) // CJK Ext B~F + 罕用区
  ) {
    return 2;
  }
  // 控制字符不算宽度
  if (cp < 0x20 || (cp >= 0x7F && cp < 0xA0)) return 0;
  return 1;
}

/**
 * 字符串在终端里的视觉宽度。
 * 跳过零宽连接符（ZWJ 0x200D）和变体选择符（FE0F~FE0F）——这些是组合 emoji 的辅助字符，不占格。
 *
 * @param text — 任意字符串
 * @returns 视觉宽度
 */
export function visualWidth(text: string): number {
  let w = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    if (cp === 0x200D) continue;          // ZWJ
    if (cp >= 0xFE00 && cp <= 0xFE0F) continue; // Variation selectors
    w += cpWidth(cp);
  }
  return w;
}

// ---------------------------------------------------------------------------
// 字符串按视觉宽度切分
// ---------------------------------------------------------------------------

/**
 * 遍历字符串，产出「码点 + 视觉宽度增量」。用于 wrap / slice 的按视觉宽度操作。
 */
function* iterateChars(text: string): Generator<{ ch: string; width: number }> {
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    if (cp === 0x200D) continue;
    if (cp >= 0xFE00 && cp <= 0xFE0F) continue;
    yield { ch, width: cpWidth(cp) };
  }
}

/**
 * 在给定的视觉宽度限制内切分字符串为多行（不丢字符）。
 *
 * 策略：
 * - 在空格 / 零宽非断字点处优先换行；找不到则在任意字符处硬切
 * - 末行若仍超宽，逐字符截到 maxWidth
 *
 * @param text — 原文本（可含 CJK / 换行）
 * @param maxWidth — 每行最大视觉宽度
 * @returns 切分后的多行
 */
export function wrapByWidth(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [text];

  // 先按 \n 切，再对每段做视觉宽度 wrap
  const out: string[] = [];
  for (const para of text.split("\n")) {
    if (para.length === 0) {
      out.push("");
      continue;
    }
    const wrapped = wrapOneLine(para, maxWidth);
    for (const w of wrapped) out.push(w);
  }
  return out.length === 0 ? [""] : out;
}

function wrapOneLine(text: string, maxWidth: number): string[] {
  if (visualWidth(text) <= maxWidth) return [text];

  const lines: string[] = [];
  let current = "";
  let currentW = 0;
  // 候选断点：在最近的「空格后」处换行（保留英文 / 拼音整词）
  let breakCandidate = -1; // current 中最后一个空格的位置
  let breakCandidateW = 0;

  for (const { ch, width } of iterateChars(text)) {
    if (ch === " " || ch === "\t") {
      // 记录断点：若后续再加字符会超宽，就在这里切
      breakCandidate = current.length;
      breakCandidateW = currentW + width;
      current += ch;
      currentW += width;
      continue;
    }
    if (currentW + width > maxWidth) {
      // 需要换行
      if (breakCandidate > 0) {
        // 在上一个空格处切
        const split = current.slice(0, breakCandidate).replace(/[ \t]+$/, "");
        lines.push(split);
        const rest = current.slice(breakCandidate).replace(/^[ \t]+/, "");
        current = rest + ch;
        currentW = visualWidth(current);
        breakCandidate = -1;
        breakCandidateW = 0;
      } else {
        // 硬切：当前字符单独成行
        lines.push(current);
        current = ch;
        currentW = width;
      }
    } else {
      current += ch;
      currentW += width;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

// ---------------------------------------------------------------------------
// 表格布局
// ---------------------------------------------------------------------------

/**
 * 把单行单元格按列宽换行成等高的多行，返回每行最终显示的字符串数组。
 * 不足行用空格补齐。
 *
 * @param cells — 单元格内容
 * @param colWidths — 每列宽度（视觉宽度）
 * @param alignments — 每列对齐方式
 * @returns 与原 cells 等长的、可能含多行的字符串数组
 */
function wrapRowCells(
  cells: string[],
  colWidths: number[],
  alignments: Alignment[],
): string[][] {
  return cells.map((cell, ci) => {
    const w = colWidths[ci] ?? TABLE_MIN_COL_WIDTH;
    const lines = wrapByWidth(cell, w);
    return lines.map((l) => padToWidth(l, w, alignments[ci] ?? "left"));
  });
}

/**
 * 按视觉宽度和对齐方式把字符串填充到目标宽度。
 *
 * @param text — 原文本
 * @param targetWidth — 目标视觉宽度
 * @param align — 对齐方式
 * @returns 填充后的字符串
 */
export function padToWidth(
  text: string,
  targetWidth: number,
  align: Alignment = "left",
): string {
  const vw = visualWidth(text);
  const delta = targetWidth - vw;
  if (delta <= 0) return text;
  const leftPad = align === "right" ? delta : align === "center" ? Math.floor(delta / 2) : 0;
  const rightPad = delta - leftPad;
  return " ".repeat(leftPad) + text + " ".repeat(rightPad);
}

/**
 * 解析 Markdown 表格一行为单元格数组。
 *
 * @param line — 类似 `| a | b |` 的行
 * @returns 单元格内容数组
 */
export function parseTableCells(line: string): string[] {
  const t = line.trim();
  if (!t.startsWith("|") || !t.endsWith("|")) return [];
  const inner = t.slice(1, t.length - 1);
  return inner.split("|").map((c) => c.trim());
}

/**
 * 从分隔行（如 `| :--- | :---: | ---: |`）解析每列对齐方式。
 *
 * @param sepLine — 分隔行
 * @returns 每列的对齐方式数组
 */
export function parseAlignments(sepLine: string): Alignment[] {
  return parseTableCells(sepLine).map((c) => {
    const l = c.startsWith(":");
    const r = c.endsWith(":");
    if (l && r) return "center";
    if (r) return "right";
    return "left";
  });
}

/**
 * 把多行原表格内容（含表头 / 分隔行 / 数据行）布局成终端框线表格。
 *
 * 行为：
 * 1. 列宽优先用各列最长 cell 的视觉宽度
 * 2. 超出终端可用宽度 → 等比缩列宽，下限 TABLE_MIN_COL_WIDTH
 * 3. 单 cell 仍超过列宽 → 在列内按视觉宽度 wrap 成多行；表格行高 = 该行最大 wrap 行数
 * 4. 内容绝不截断（不像 slice）
 *
 * @param text — 表格原始多行文本（含分隔行）
 * @param options — 布局选项
 * @returns 布局结果（已包含 top / mid / bot 框线）
 */
export function layoutTable(text: string, options: TableLayoutOptions = {}): TableLayout {
  const termWidth = options.termWidth ?? DEFAULT_TERM_WIDTH;
  const outerMargin = options.outerMargin ?? 0; // 表格整体在终端中的左右边距，由调用方负责
  const usable = Math.max(termWidth - outerMargin, 20);

  const rawLines = text.split("\n").filter((l) => l.trim().length > 0);
  if (rawLines.length < 2) {
    return { lines: rawLines, colWidths: [], totalWidth: 0 };
  }

  // 找分隔行
  let sepIdx = -1;
  for (let k = 0; k < rawLines.length; k++) {
    const t = (rawLines[k] ?? "").trim();
    if (/^\|[-: |]+\|$/.test(t) && t.includes("-")) {
      sepIdx = k;
      break;
    }
  }
  if (sepIdx === -1) {
    return { lines: rawLines, colWidths: [], totalWidth: 0 };
  }

  // 解析表头、对齐、数据行
  const headerCells = parseTableCells(rawLines.slice(0, sepIdx).join(""));
  const alignments = parseAlignments(rawLines[sepIdx] ?? "");
  const dataRows = rawLines.slice(sepIdx + 1).map(parseTableCells);
  const colCount = headerCells.length;
  if (colCount === 0) {
    return { lines: rawLines, colWidths: [], totalWidth: 0 };
  }

  // 每列最大视觉宽度
  const colMaxWidths: number[] = [];
  for (let ci = 0; ci < colCount; ci++) {
    let max = visualWidth(headerCells[ci] ?? "");
    for (const row of dataRows) {
      const w = visualWidth(row[ci] ?? "");
      if (w > max) max = w;
    }
    colMaxWidths.push(Math.max(max, TABLE_MIN_COL_WIDTH));
  }

  // 列宽决策：usable 内尽量用 colMaxWidths，超出再等比缩
  const margin = TABLE_MARGIN;
  const totalMinWidth = colMaxWidths.reduce((s, w) => s + w + margin, 1); // +1 for leading │
  let colWidths: number[];
  if (totalMinWidth <= usable) {
    colWidths = colMaxWidths;
  } else {
    // 等比缩
    const available = usable - 1 - margin * colCount;
    const sum = colMaxWidths.reduce((s, w) => s + w, 0);
    colWidths = colMaxWidths.map((w) =>
      Math.max(TABLE_MIN_COL_WIDTH, Math.floor((w / sum) * available)),
    );
    // 修正舍入误差：若总宽仍超，再缩最后一列
    let total = colWidths.reduce((s, w) => s + w + margin, 1);
    while (total > usable && colWidths.length > 0) {
      const last = colWidths.length - 1;
      const cur = colWidths[last] ?? TABLE_MIN_COL_WIDTH;
      if (cur <= TABLE_MIN_COL_WIDTH) break;
      colWidths[last] = cur - 1;
      total = colWidths.reduce((s, w) => s + w + margin, 1);
    }
  }

  // 框线字符
  const H = "─";
  const makeSep = (l: string, m: string, r: string) =>
    l + colWidths.map((w) => H.repeat(w + margin)).join(m) + r;

  const topBorder = makeSep("┌", "┬", "┐");
  const midBorder = makeSep("├", "┼", "┤");
  const botBorder = makeSep("└", "┴", "┘");

  // 渲染一行（含 wrap）
  function buildRow(cells: string[]): string[] {
    const wrapped = wrapRowCells(cells, colWidths, alignments);
    const rowHeight = Math.max(1, ...wrapped.map((lines) => lines.length));
    const lines: string[] = [];
    for (let li = 0; li < rowHeight; li++) {
      // 数据行总视觉宽 = "│" + sum(" " + segment + " ") + "│" + 各列中间额外的"│"
      // 简化：每列拼 " " + segment + " │"，末列单独拼 " " + segment + "│"
      let row = "│";
      for (let ci = 0; ci < colCount; ci++) {
        const cellLines = wrapped[ci] ?? [];
        const segment = cellLines[li] ?? " ".repeat(colWidths[ci] ?? TABLE_MIN_COL_WIDTH);
        row += " " + segment + " ";
        if (ci < colCount - 1) row += "│";
      }
      row += "│";
      lines.push(row);
    }
    return lines;
  }

  const headerRow = buildRow(headerCells);
  const dataRowsOut = dataRows.map(buildRow);
  const totalWidth = colWidths.reduce((s, w) => s + w + margin, 1);

  return {
    lines: [
      topBorder,
      ...headerRow,
      midBorder,
      ...dataRowsOut.flat(),
      botBorder,
    ],
    colWidths,
    totalWidth,
  };
}

/**
 * 探测当前进程 stdout 宽度（同步、SSR 安全）。失败时返回 undefined。
 */
export function detectTermWidth(): number | undefined {
  const c = (process.stdout as { columns?: number } | undefined)?.columns;
  return typeof c === "number" && c > 0 ? c : undefined;
}
