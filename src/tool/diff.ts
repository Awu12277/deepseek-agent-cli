// ---------------------------------------------------------------------------
// 文件差异计算 — Myers O(ND) 算法 + unified patch 生成
//
// Myers 算法与 Git 的 diff 引擎同款，产生最短编辑脚本（SES）。
// 时间复杂度 O((N+M)D)，空间复杂度 O(N+M)，其中 D 为编辑距离。
//
// 实现方式：非递归的 Myers 差分算法。
// 1. 正向搜索：找到从 (0,0) 到 (N,M) 的最短编辑路径
// 2. 回溯路径：从 (N,M) 回溯到 (0,0)，生成 DiffLine 序列
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
// EOL（行尾风格）检测
// ---------------------------------------------------------------------------

type EOFStyle = "lf" | "crlf" | "no-eol";

interface SplitResult {
  lines: string[];
  eol: string;
  eofStyle: EOFStyle;
}

function splitLines(text: string): SplitResult {
  if (text.length === 0) {
    return { lines: [], eol: "\n", eofStyle: "no-eol" };
  }

  const crlfIdx = text.indexOf("\r\n");
  const lfIdx = text.indexOf("\n");
  let eol: string;
  if (crlfIdx !== -1 && (lfIdx === -1 || crlfIdx <= lfIdx)) {
    eol = "\r\n";
  } else if (lfIdx !== -1) {
    eol = "\n";
  } else {
    eol = "\n";
  }

  const lines = text.split(eol);

  let eofStyle: EOFStyle;
  if (text.endsWith(eol)) {
    if (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }
    eofStyle = "lf";
  } else {
    eofStyle = "no-eol";
  }

  return { lines, eol, eofStyle };
}

// ---------------------------------------------------------------------------
// Myers 非递归差分算法
// ---------------------------------------------------------------------------

/**
 * 计算两个行数组之间的最短编辑脚本（SES）。
 *
 * 使用非递归 Myers 算法：
 * 1. 正向搜索 V 数组，记录每步的进度
 * 2. 到达终点后回溯路径生成 DiffLine 列表
 */
function computeLineDiff(oldLines: string[], newLines: string[]): DiffLine[] {
  const N = oldLines.length;
  const M = newLines.length;

  if (N === 0 && M === 0) return [];
  if (N === 0) return newLines.map((line) => ({ op: "add" as Op, line }));
  if (M === 0) return oldLines.map((line) => ({ op: "remove" as Op, line }));

  // 存储每一步的 V 快照，用于回溯
  const trace: Map<number, number>[] = [];

  const maxD = N + M;
  // V[k] = x position；初始化为 -1 表示未访问
  // eslint-disable-next-line unicorn/no-new-array, @typescript-eslint/no-unsafe-type-assertion
  const V: number[] = new Array(2 * maxD + 2).fill(-1) as number[];
  // k 的偏移量，使索引非负
  const offset = maxD;

  V[offset + 1] = 0;

  // 正向搜索：从 d=0 开始，逐层扩展
  for (let d = 0; d <= maxD; d++) {
    // 保存当前层的 V 快照
    const snapshot = new Map<number, number>();

    const kStart = -d;
    const kEnd = d;

    for (let k = kStart; k <= kEnd; k += 2) {
      const ki = k + offset;
      let x: number;

      if (k === -d || (k !== d && V[ki - 1]! < V[ki + 1]!)) {
        x = V[ki + 1]!;
      } else {
        x = V[ki - 1]! + 1;
      }

      let y = x - k;

      // 沿着对角线延伸
      while (x < N && y < M && oldLines[x] === newLines[y]) {
        x++;
        y++;
      }

      V[ki] = x;
      snapshot.set(k, x);

      // 到达终点
      if (x >= N && y >= M) {
        trace.push(snapshot);
        // 回溯路径
        return backtrack(trace, N, M, oldLines, newLines, offset);
      }
    }

    trace.push(snapshot);
  }

  // 不应该到达这里（总有解）
  return oldLines.map((line) => ({ op: "remove" as Op, line }))
    .concat(newLines.map((line) => ({ op: "add" as Op, line })));
}

/**
 * 从 trace 中回溯最短编辑路径，生成 DiffLine 列表。
 *
 * trace 存储了每一层 (d) 的 V 快照。
 * 从终点 (N, M) 开始，逆着路径逐层回溯到 (0, 0)。
 */
function backtrack(
  trace: Map<number, number>[],
  N: number,
  M: number,
  oldLines: string[],
  newLines: string[],
  _offset: number,
): DiffLine[] {
  const result: DiffLine[] = [];

  let x = N;
  let y = M;

  // 从最后一层回溯到第 1 层（第 0 层只有初始蛇行，没有实际移动）
  for (let d = trace.length - 1; d >= 1; d--) {
    const k = x - y;

    // 从 trace[d-1] 中查找上一步的 x 位置
    // 注意：trace[d] 存的是本层结果，前一层的数据在 trace[d-1] 中
    const prevSnapshot = trace[d - 1]!;
    const prevKDown = prevSnapshot.get(k - 1);
    const prevKUp = prevSnapshot.get(k + 1);

    let prevK: number;
    if (k === -d) {
      // 只能在 k+1 方向
      prevK = k + 1;
    } else if (k === d) {
      // 只能在 k-1 方向
      prevK = k - 1;
    } else if ((prevKDown ?? -1) < (prevKUp ?? -1)) {
      // k+1 方向的 V 值更大，从那里过来（删除）
      prevK = k + 1;
    } else {
      // k-1 方向的 V 值更大，从那里过来（添加）
      prevK = k - 1;
    }

    const prevX = prevSnapshot.get(prevK) ?? 0;
    const prevY = prevX - prevK;

    // ===== 从 (prevX, prevY) 到 (x, y) 的回溯路径 =====

    if (prevK === k - 1) {
      // prevK = k-1 → V[k-1] 被使用 → x = V[k-1] + 1 → 垂直移动（删除）
      // 路径: (prevX, prevY) → (prevX+1, prevY) [删除] → 蛇行 [(prevX+2, prevY+1), ...]
      // 回溯: 先走蛇行(相等行), 再走删除行

      // 第一步：蛇行（相等行），从 (x,y) 回到 (prevX+1, prevY)
      while (x > prevX + 1 && y > prevY) {
        x--;
        y--;
        result.unshift({ op: "equal", line: oldLines[x]! });
      }

      // 第二步：删除行
      if (x > prevX) {
        x--;
        result.unshift({ op: "remove", line: oldLines[x]! });
      }
    } else {
      // prevK = k+1 → V[k+1] 被使用 → x = V[k+1] → 水平移动（添加）
      // 路径: (prevX, prevY) → (prevX, prevY+1) [添加] → 蛇行 [(prevX+1, prevY+2), ...]
      // 回溯: 先走蛇行(相等行), 再走添加行

      // 第一步：蛇行（相等行），从 (x,y) 回到 (prevX, prevY+1)
      while (x > prevX && y > prevY + 1) {
        x--;
        y--;
        result.unshift({ op: "equal", line: oldLines[x]! });
      }

      // 第二步：添加行
      if (y > prevY) {
        y--;
        result.unshift({ op: "add", line: newLines[y]! });
      }
    }
  }

  // 处理初始蛇行：从 (0, 0) 到当前 (x, y) 的相等行
  // 逆向（从 (x, y) 到 (1, 1) 到 (0, 0) 回溯）
  while (x > 0 && y > 0) {
    x--;
    y--;
    result.unshift({ op: "equal", line: oldLines[x]! });
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
 */
function groupIntoHunks(diffLines: DiffLine[]): DiffHunk[] {
  if (diffLines.length === 0) return [];

  // 找出所有变更行的索引
  const changeIndices: number[] = [];
  for (let i = 0; i < diffLines.length; i++) {
    const line = diffLines[i]!;
    if (line.op !== "equal") {
      changeIndices.push(i);
    }
  }

  if (changeIndices.length === 0) return [];

  // 将相近的变更行分组
  const groups: number[][] = [[changeIndices[0]!]];

  for (let idx = 1; idx < changeIndices.length; idx++) {
    const lastGroup = groups[groups.length - 1]!;
    const prevIdx = lastGroup[lastGroup.length - 1]!;
    const currIdx = changeIndices[idx]!;

    let gap = 0;
    for (let k = prevIdx + 1; k < currIdx; k++) {
      const line = diffLines[k]!;
      if (line.op === "equal") gap++;
    }

    if (gap <= 2 * CONTEXT_LINES) {
      lastGroup.push(currIdx);
    } else {
      groups.push([currIdx]);
    }
  }

  // 为每个分组生成 hunk
  const hunks: DiffHunk[] = [];

  for (const group of groups) {
    const firstChangeIdx = group[0]!;
    const lastChangeIdx = group[group.length - 1]!;

    const startIdx = Math.max(0, firstChangeIdx - CONTEXT_LINES);
    const endIdx = Math.min(diffLines.length - 1, lastChangeIdx + CONTEXT_LINES);

    const lines = diffLines.slice(startIdx, endIdx + 1);

    let oldLine = 0;
    let newLine = 0;
    for (let i = 0; i < startIdx; i++) {
      const line = diffLines[i]!;
      if (line.op === "equal" || line.op === "remove") oldLine++;
      if (line.op === "equal" || line.op === "add") newLine++;
    }

    let oldCount = 0;
    let newCount = 0;
    for (const diffLine of lines) {
      if (diffLine.op === "equal" || diffLine.op === "remove") oldCount++;
      if (diffLine.op === "equal" || diffLine.op === "add") newCount++;
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

function formatUnifiedDiff(hunks: DiffHunk[], filePath: string): string {
  if (hunks.length === 0) return "";

  const parts: string[] = [];
  const fileName = extractFileName(filePath);

  parts.push(`--- a/${fileName}`);
  parts.push(`+++ b/${fileName}`);

  for (const hunk of hunks) {
    parts.push(
      `@@ -${String(hunk.oldStart)},${String(hunk.oldCount)} +${String(hunk.newStart)},${String(hunk.newCount)} @@`,
    );

    for (const diffLine of hunk.lines) {
      switch (diffLine.op) {
        case "equal":
          parts.push(` ${diffLine.line}`);
          break;
        case "remove":
          parts.push(`-${diffLine.line}`);
          break;
        case "add":
          parts.push(`+${diffLine.line}`);
          break;
      }
    }
  }

  return parts.join("\n");
}

function formatNewFileDiff(lines: string[], filePath: string): string {
  const fileName = extractFileName(filePath);
  const parts: string[] = [];

  parts.push(`--- /dev/null`);
  parts.push(`+++ b/${fileName}`);
  parts.push(`@@ -0,0 +1,${String(lines.length)} @@`);

  for (const line of lines) {
    parts.push(`+${line}`);
  }

  return parts.join("\n");
}

function formatDeletedFileDiff(lines: string[], filePath: string): string {
  const fileName = extractFileName(filePath);
  const parts: string[] = [];

  parts.push(`--- a/${fileName}`);
  parts.push(`+++ /dev/null`);
  parts.push(`@@ -1,${String(lines.length)} +0,0 @@`);

  for (const line of lines) {
    parts.push(`-${line}`);
  }

  return parts.join("\n");
}

function extractFileName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  return normalized.split("/").pop() ?? filePath;
}

// ---------------------------------------------------------------------------
// 公共 API
// ---------------------------------------------------------------------------

/**
 * 计算两个文本之间的 unified diff，返回 FileDiff 对象。
 *
 * 使用 Myers O(ND) 算法产生最短编辑脚本，与 Git 的 diff 引擎同款。
 * 自动检测并保留原始文件的行尾风格（LF / CRLF）。
 */
export function computeFileDiff(
  oldContent: string,
  newContent: string,
  filePath: string,
): FileDiff {
  if (oldContent === newContent) {
    return {
      filePath,
      patch: "",
      existedBefore: oldContent.length > 0,
      additions: 0,
      deletions: 0,
    };
  }

  if (oldContent.length === 0) {
    const split = splitLines(newContent);
    const patch = formatNewFileDiff(split.lines, filePath);
    return {
      filePath,
      patch,
      existedBefore: false,
      additions: split.lines.length,
      deletions: 0,
    };
  }

  if (newContent.length === 0) {
    const split = splitLines(oldContent);
    const patch = formatDeletedFileDiff(split.lines, filePath);
    return {
      filePath,
      patch,
      existedBefore: true,
      additions: 0,
      deletions: split.lines.length,
    };
  }

  const oldSplit = splitLines(oldContent);
  const newSplit = splitLines(newContent);

  const diffLines = computeLineDiff(oldSplit.lines, newSplit.lines);

  let additions = 0;
  let deletions = 0;
  for (const line of diffLines) {
    if (line.op === "add") additions++;
    if (line.op === "remove") deletions++;
  }

  const hunks = groupIntoHunks(diffLines);
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
 * 将文件变更应用于原内容，返回新的文件内容。
 */
export function applyChange(
  kind: "edit" | "create" | "delete",
  oldContent: string,
  newContent: string,
): string {
  if (kind === "delete") return "";
  if (kind === "create") return newContent;
  return newContent;
}
