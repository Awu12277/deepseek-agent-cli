// ---------------------------------------------------------------------------
// 文件差异计算 — LCS diff + unified patch 生成
// ---------------------------------------------------------------------------

import type { FileDiff } from "./types.js";

// ---------------------------------------------------------------------------
// 内部类型
// ---------------------------------------------------------------------------

/** 单行 diff 操作类型 */
type Op = "equal" | "add" | "remove";

/** 一行 diff 记录 */
interface DiffLine {
  op: Op;
  line: string;
}

/** unified diff 中的一个 hunk */
interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

// ---------------------------------------------------------------------------
// 公共 API
// ---------------------------------------------------------------------------

/**
 * 计算两个文本之间的 unified diff，返回 FileDiff 对象。
 *
 * @param oldContent 变更前文件内容（空字符串表示新建文件）
 * @param newContent 变更后文件内容（空字符串表示删除文件）
 * @param filePath    文件路径，用于 diff 头部标识
 * @returns           FileDiff 对象，其中 patch 为标准 unified diff 格式
 */
export function computeFileDiff(
  oldContent: string,
  newContent: string,
  filePath: string,
): FileDiff {
  // 无变更快速路径
  if (oldContent === newContent) {
    return {
      filePath,
      patch: "",
      existedBefore: oldContent.length > 0,
      additions: 0,
      deletions: 0,
    };
  }

  // 空文件 → 新建文件
  if (oldContent.length === 0) {
    const newLines = splitLines(newContent);
    const patch = formatNewFileDiff(newLines, filePath);
    return {
      filePath,
      patch,
      existedBefore: false,
      additions: newLines.length,
      deletions: 0,
    };
  }

  // 内容清空 → 删除文件
  if (newContent.length === 0) {
    const oldLines = splitLines(oldContent);
    const patch = formatDeletedFileDiff(oldLines, filePath);
    return {
      filePath,
      patch,
      existedBefore: true,
      additions: 0,
      deletions: oldLines.length,
    };
  }

  // 正常 diff
  const oldLines = splitLines(oldContent);
  const newLines = splitLines(newContent);

  const diffLines = computeLineDiff(oldLines, newLines);

  // 统计变更
  let additions = 0;
  let deletions = 0;
  for (const line of diffLines) {
    if (line.op === "add") additions++;
    if (line.op === "remove") deletions++;
  }

  // 生成分组 hunks
  const hunks = groupIntoHunks(diffLines);

  // 格式化为 unified diff
  const patch = formatUnifiedDiff(hunks, filePath);

  return {
    filePath,
    patch,
    existedBefore: true,
    additions,
    deletions,
  };
}

/**
 * 将文本按行分割，处理末尾换行。
 * "abc\ndef\n" → ["abc", "def"]
 * "abc\ndef"    → ["abc", "def"]
 */
function splitLines(text: string): string[] {
  const raw = text.split("\n");
  // 如果文本以 \n 结尾，split 产生最后一个空字符串，去掉它
  if (text.endsWith("\n") && raw.length > 0 && raw[raw.length - 1] === "") {
    return raw.slice(0, -1);
  }
  return raw;
}

// ---------------------------------------------------------------------------
// LCS diff 算法 — 基于最长公共子序列
// ---------------------------------------------------------------------------

/**
 * 使用 LCS 计算两段文本的行级 diff。
 * O(N*M) 时间复杂度，对于 Agent 修改的文件大小完全够用。
 */
function computeLineDiff(oldLines: string[], newLines: string[]): DiffLine[] {
  const N = oldLines.length;
  const M = newLines.length;

  // 构建 LCS 表
  const dp: number[][] = [];
  for (let i = 0; i <= N; i++) {
    dp[i] = new Array(M + 1).fill(0) as number[];
  }

  for (let i = 1; i <= N; i++) {
    for (let j = 1; j <= M; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i]![j] = dp[i - 1]![j - 1]! + 1;
      } else {
        dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
      }
    }
  }

  // 回溯 LCS，生成 diff
  const result: DiffLine[] = [];
  let i = N;
  let j = M;

  while (i > 0 || j > 0) {
    const oldLine = i > 0 ? oldLines[i - 1] : undefined;
    const newLine = j > 0 ? newLines[j - 1] : undefined;

    if (i > 0 && j > 0 && oldLine !== undefined && newLine !== undefined && oldLine === newLine) {
      result.unshift({ op: "equal", line: oldLine });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      result.unshift({ op: "add", line: newLines[j - 1]! });
      j--;
    } else {
      result.unshift({ op: "remove", line: oldLines[i - 1]! });
      i--;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Hunk 分组
// ---------------------------------------------------------------------------

/** 上下文行数（unified diff 标准 3 行） */
const CONTEXT_LINES = 3;

/**
 * 将 diff 行列表分组为 hunks。
 * 两个变更区域之间如果有超过 2*CONTEXT_LINES 行的间隔，则分成不同 hunk。
 */
function groupIntoHunks(diffLines: DiffLine[]): DiffHunk[] {
  if (diffLines.length === 0) return [];

  // 找出所有变更行的索引
  const changeIndices: number[] = [];
  for (let i = 0; i < diffLines.length; i++) {
    if (diffLines[i]!.op !== "equal") {
      changeIndices.push(i);
    }
  }

  if (changeIndices.length === 0) return [];

  // 将相近的变更行分组：间隔 <= 2*CONTEXT_LINES 的归入同一组
  const groups: number[][] = [[changeIndices[0] as number]];

  for (let idx = 1; idx < changeIndices.length; idx++) {
    const prevIdx = groups[groups.length - 1]![groups[groups.length - 1]!.length - 1] as number;
    const currIdx = changeIndices[idx] as number;

    // 计算两个变更之间的间隔（相等行数）
    let gap = 0;
    for (let k = prevIdx + 1; k < currIdx; k++) {
      if (diffLines[k]!.op === "equal") gap++;
    }

    if (gap <= 2 * CONTEXT_LINES) {
      groups[groups.length - 1]!.push(currIdx);
    } else {
      groups.push([currIdx]);
    }
  }

  // 为每个分组生成 hunk
  const hunks: DiffHunk[] = [];

  for (const group of groups) {
    const firstChangeIdx = group[0] as number;
    const lastChangeIdx = group[group.length - 1] as number;

    // 包含上下文行的起止索引
    const startIdx = Math.max(0, firstChangeIdx - CONTEXT_LINES);
    const endIdx = Math.min(diffLines.length - 1, lastChangeIdx + CONTEXT_LINES);

    const lines = diffLines.slice(startIdx, endIdx + 1);

    // 计算 hunk 之前的旧行号和新行号
    let oldLine = 0;
    let newLine = 0;
    for (let i = 0; i < startIdx; i++) {
      const op = diffLines[i]!.op;
      if (op === "equal" || op === "remove") oldLine++;
      if (op === "equal" || op === "add") newLine++;
    }

    let oldCount = 0;
    let newCount = 0;
    for (const line of lines) {
      if (line.op === "equal" || line.op === "remove") oldCount++;
      if (line.op === "equal" || line.op === "add") newCount++;
    }

    hunks.push({
      oldStart: oldLine + 1,
      oldCount,
      newStart: newLine + 1,
      newCount,
      lines,
    });
  }

  return hunks;
}

// ---------------------------------------------------------------------------
// Unified diff 格式化
// ---------------------------------------------------------------------------

/**
 * 将 hunks 格式化为标准 unified diff 文本。
 */
function formatUnifiedDiff(hunks: DiffHunk[], filePath: string): string {
  if (hunks.length === 0) return "";

  const parts: string[] = [];
  const fileName = extractFileName(filePath);

  parts.push(`--- a/${fileName}`);
  parts.push(`+++ b/${fileName}`);

  for (const hunk of hunks) {
    parts.push(`@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`);

    for (const line of hunk.lines) {
      switch (line.op) {
        case "equal":
          parts.push(` ${line.line}`);
          break;
        case "remove":
          parts.push(`-${line.line}`);
          break;
        case "add":
          parts.push(`+${line.line}`);
          break;
      }
    }
  }

  return parts.join("\n");
}

/**
 * 格式化新建文件的 diff。
 */
function formatNewFileDiff(lines: string[], filePath: string): string {
  const fileName = extractFileName(filePath);
  const parts: string[] = [];

  parts.push(`--- /dev/null`);
  parts.push(`+++ b/${fileName}`);
  parts.push(`@@ -0,0 +1,${lines.length} @@`);

  for (const line of lines) {
    parts.push(`+${line}`);
  }

  return parts.join("\n");
}

/**
 * 格式化删除文件的 diff。
 */
function formatDeletedFileDiff(lines: string[], filePath: string): string {
  const fileName = extractFileName(filePath);
  const parts: string[] = [];

  parts.push(`--- a/${fileName}`);
  parts.push(`+++ /dev/null`);
  parts.push(`@@ -1,${lines.length} +0,0 @@`);

  for (const line of lines) {
    parts.push(`-${line}`);
  }

  return parts.join("\n");
}

/**
 * 从路径中提取文件名（处理 Windows 和 Unix 路径）。
 */
function extractFileName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  return normalized.split("/").pop() ?? filePath;
}