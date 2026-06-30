// ---------------------------------------------------------------------------
// Reflector — 失败归因 → 改写下一轮 prompt
//
// 设计原则：
// - 纯类：输入（工具执行结果 + 历史 + 上下文）→ 输出（反射列表 / 拼装后的 prompt）
// - 不持有 Session / messages 状态
// - 5 条规则（按优先级检查，先匹配先返回，单条目不重复触发）：
//     R1 连续失败   — 同一工具连续 ≥threshold 次相同错误码失败
//     R2 文件不存在 — TOOL_NOT_FOUND 或 ENOENT / not found / No such file
//     R2.5 文本未找到 — TEXT_NOT_FOUND / TEXT_MULTIPLE_MATCHES（编辑工具高频失败）
//     R3 权限拒绝   — GATE_DENIED 或 EACCES / permission / denied
//     R4 写根外     — kind ∈ Edit/Delete/Move 且错误码为 OUTSIDE_WRITE_ROOTS
// - 注入策略：拼到 system prompt 尾部，不修改 messages
//
// 函数注释规范见仓库根 AGENTS.md「函数注释规范」一节。
// ---------------------------------------------------------------------------

import { ToolKind, type ToolResult } from "../tool/types.js";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 反射类别（与日志里的 category 字段对齐） */
export type ReflectionCategory =
  | "repeated_failure"
  | "file_not_found"
  | "text_not_found"
  | "permission_denied"
  | "out_of_write_root";

/** 单条反射 */
export interface Reflection {
  /** 给 LLM 看的中文提示 */
  hint: string;
  /** 反射分类（用于日志 / 调试） */
  category: ReflectionCategory;
  /** 命中的工具名（便于 UI 展示） */
  toolName: string;
}

/** Reflector 配置 */
export interface ReflectorOptions {
  /** 触发 R1 需要的最小连续失败次数（默认 2） */
  repeatThreshold?: number;
  /** 注入到 prompt 的最大反射数（默认 5） */
  maxReflections?: number;
  /** 单条 hint 的最大字符数（默认 800） */
  maxHintChars?: number;
}

/** analyze() 接收的单条工具结果 */
export interface AnalyzeItem {
  /** 工具名 */
  name: string;
  /** 工具执行结果 */
  result: ToolResult;
  /** 工具分类（从 registry 拿，未注册时为 Other） */
  kind: ToolKind;
  /** 该工具在本轮之前的失败历史（仅失败项；用于 R1） */
  recentSameTool: Array<{ success: boolean; error?: string }>;
}

/** analyze() 接收的上下文 */
export interface AnalyzeContext {
  /** 写工具允许的根目录列表（用于 R4 hint） */
  writeRoots: string[];
  /** 当前工作目录（用于 R2 hint） */
  cwd: string;
}

// ---------------------------------------------------------------------------
// Reflector
// ---------------------------------------------------------------------------

/**
 * Reflector：把本轮工具执行的失败结果归因为结构化反射，拼到下一轮 prompt。
 *
 * 行为：
 * - analyze：每个失败项最多产生 1 条反射（按 R1 → R2 → R3 → R4 顺序检查，先命中先用）
 * - injectIntoPrompt：把反射数组拼成"反思"section 追加到 system prompt 末尾
 *
 * 不写 messages，不调 LLM，不持有可变状态。
 */
export class Reflector {
  /** 触发 R1 需要的最小连续失败次数 */
  readonly #repeatThreshold: number;
  /** 注入到 prompt 的最大反射数 */
  readonly #maxReflections: number;
  /** 单条 hint 的最大字符数 */
  readonly #maxHintChars: number;

  /**
   * 构造一个 Reflector。
   *
   * @param options — 限流与阈值配置
   * @pure 仅保存配置
   */
  constructor(options: ReflectorOptions = {}) {
    this.#repeatThreshold = options.repeatThreshold ?? 2;
    this.#maxReflections = options.maxReflections ?? 5;
    this.#maxHintChars = options.maxHintChars ?? 800;
  }

  /**
   * 分析一批工具执行结果，返回要注入的反射列表。
   *
   * 行为：
   * - 成功项直接跳过
   * - 失败项按 R1 → R2 → R3 → R4 顺序检查，先命中先用，单条目最多产生 1 条
   * - 总数超过 maxReflections 时截断到前 N 条
   *
   * @param items — 本轮工具执行结果列表
   * @param ctx — 上下文（writeRoots / cwd，用于生成 hint）
   * @returns 反射列表（可能为空；最多 maxReflections 条）
   *
   * @pure 不修改任何状态
   */
  analyze(items: ReadonlyArray<AnalyzeItem>, ctx: AnalyzeContext): Reflection[] {
    const reflections: Reflection[] = [];
    for (const item of items) {
      if (item.result.success) continue;
      const r =
        this.#ruleRepeatedFailure(item) ??
        this.#ruleFileNotFound(item) ??
        this.#ruleTextNotFound(item) ??
        this.#rulePermissionDenied(item) ??
        this.#ruleOutOfWriteRoot(item, ctx.writeRoots);
      if (r) reflections.push(r);
      if (reflections.length >= this.#maxReflections) break;
    }
    return reflections;
  }

  /**
   * 把反射列表拼成"反思"section，追加到 system prompt 末尾。
   *
   * 输出格式：
   * ```
   * {原 prompt}
   *
   * ## ⚠️ 上一轮工具调用的反思
   * - 工具 `<tool>`：<hint>
   * - 工具 `<tool>`：<hint>
   * ```
   *
   * @param systemPrompt — 原始 system prompt
   * @param reflections — 反射列表（空数组时原样返回）
   * @returns 拼装后的新 prompt
   *
   * @pure 不修改入参
   */
  injectIntoPrompt(systemPrompt: string, reflections: Reflection[]): string {
    if (reflections.length === 0) return systemPrompt;
    const lines = reflections.map((r) => {
      const hint = this.#truncate(r.hint);
      return `- 工具 \`${r.toolName}\` 失败：${hint}`;
    });
    const section = [
      "## ⚠️ 上一轮工具调用的反思",
      "以下是本轮工具执行失败的原因分析。请在下一次调用前先解决这些问题，不要重复相同的错误调用。",
      ...lines,
    ].join("\n");
    return systemPrompt + "\n\n" + section;
  }

  // -------------------------------------------------------------------------
  // 规则实现（按 R1 → R2 → R3 → R4 顺序）
  // -------------------------------------------------------------------------

  /**
   * R1 连续失败：同一工具连续 ≥#repeatThreshold 次相同错误码失败。
   *
   * @pure 仅读入参
   */
  #ruleRepeatedFailure(item: AnalyzeItem): Reflection | null {
    const recent = item.recentSameTool;
    if (recent.length < this.#repeatThreshold) return null;
    const lastN = recent.slice(-this.#repeatThreshold);
    const first = lastN[0]!;
    if (!lastN.every((r) => !r.success && r.error === first.error)) {
      return null;
    }
    const errText = first.error ?? "未知错误";
    return {
      category: "repeated_failure",
      toolName: item.name,
      hint: `你已连续 ${this.#repeatThreshold} 次调用 \`${item.name}\` 失败（错误：${errText}）。请先 \`read_file\` 看清现场或换其他工具，不要继续同样的错误调用。`,
    };
  }

  /**
   * R2 文件不存在：TOOL_NOT_FOUND 错误码 或 data 含 ENOENT / not found / No such file。
   *
   * @pure 仅读入参
   */
  #ruleFileNotFound(item: AnalyzeItem): Reflection | null {
    const isToolNotFound = item.result.error === "TOOL_NOT_FOUND";
    const data = item.result.data ?? "";
    const hasKeyword =
      data.includes("ENOENT") ||
      data.includes("No such file") ||
      /\bnot found\b/i.test(data);
    if (!isToolNotFound && !hasKeyword) return null;
    return {
      category: "file_not_found",
      toolName: item.name,
      hint: `\`${item.name}\` 失败：文件不存在。请先用 \`ls\` / \`glob\` 看一下目录结构，或确认路径拼写（当前工作目录见 system prompt）。`,
    };
  }

  /**
   * R2.5 文本未找到：edit_file / multi_edit 报 TEXT_NOT_FOUND 或 TEXT_MULTIPLE_MATCHES。
   *
   * 这是编辑工具最高频的失败。工具内部已对 CRLF 做归一化，仍报此错通常是
   * old_text 与当前文件内容不一致（缩进 / 已被改过 / 多次出现）。给一条明确
   * 的「重新读文件、逐字复制」指引，避免模型用同一份旧 old_text 反复重试。
   *
   * @pure 仅读入参
   */
  #ruleTextNotFound(item: AnalyzeItem): Reflection | null {
    const isTextErr =
      item.result.error === "TEXT_NOT_FOUND" ||
      item.result.error === "TEXT_MULTIPLE_MATCHES";
    if (!isTextErr) return null;
    const multiple = item.result.error === "TEXT_MULTIPLE_MATCHES";
    const hint = multiple
      ? `\`${item.name}\`：old_text 在文件中出现多次。请补充上下文让 old_text 唯一，或改用 multi_edit 的 replaceAll。`
      : `\`${item.name}\`：未找到 old_text。请重新 \`read_file\` 看当前内容，逐字复制要替换的片段（注意缩进与空格）；行尾已做 CRLF 归一化，无需手写 \\r\\n。`;
    return {
      category: "text_not_found",
      toolName: item.name,
      hint,
    };
  }

  /**
   * R3 权限拒绝：GATE_DENIED 错误码 或 data 含 EACCES / permission / denied（不区分大小写）。
   *
   * @pure 仅读入参
   */
  #rulePermissionDenied(item: AnalyzeItem): Reflection | null {
    const isGateDenied = item.result.error === "GATE_DENIED";
    const data = item.result.data ?? "";
    const hasKeyword =
      data.includes("EACCES") || /\bpermission\b/i.test(data) || /\bdenied\b/i.test(data);
    if (!isGateDenied && !hasKeyword) return null;
    return {
      category: "permission_denied",
      toolName: item.name,
      hint: `\`${item.name}\` 被权限系统拒绝。请检查：1) 路径是否在允许根目录内；2) 是否需要切换授权模式；3) 改用其他不需要权限的工具。`,
    };
  }

  /**
   * R4 写根外：kind ∈ Edit/Delete/Move 且错误码为 OUTSIDE_WRITE_ROOTS。
   *
   * 仅在工具本身明确报「路径超出写根」时才命中。旧实现只要写类工具失败就
   * 触发，会把 TEXT_NOT_FOUND / EXECUTION_ERROR 等误报为「写根外」，注入
   * 误导性提示（见会话日志 e65f0205 round 13：edit_file 因 CRLF 失配返回
   * TEXT_NOT_FOUND，却被反射为 out_of_write_root）。
   *
   * @pure 仅读入参
   */
  #ruleOutOfWriteRoot(item: AnalyzeItem, writeRoots: readonly string[]): Reflection | null {
    const isWriteKind =
      item.kind === ToolKind.Edit ||
      item.kind === ToolKind.Delete ||
      item.kind === ToolKind.Move;
    if (!isWriteKind) return null;
    if (item.result.error !== "OUTSIDE_WRITE_ROOTS") return null;
    const primary = writeRoots[0] ?? "<未配置>";
    return {
      category: "out_of_write_root",
      toolName: item.name,
      hint: `\`${item.name}\` 是写操作但目标路径不在允许的根目录内。请改用 \`${primary}\` 下的路径，或调整项目的 \`writeRoots\` 配置。`,
    };
  }

  /**
   * 截断超长 hint，末尾加省略号。
   *
   * @pure 字符串处理
   */
  #truncate(text: string): string {
    if (text.length <= this.#maxHintChars) return text;
    return text.slice(0, this.#maxHintChars - 3) + "...";
  }
}
