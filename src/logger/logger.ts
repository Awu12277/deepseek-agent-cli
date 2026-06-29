// ---------------------------------------------------------------------------
// 对话日志记录器 — 将用户与 AI 的完整交互过程写入人类可读的日志文件
//
// 设计要点：
// 1. 每条事件输出为"分隔线 + 标题行 + pretty JSON + 空行"的多行块，
//    方便人眼直接阅读；同时 pretty JSON 仍可被机器按段解析。
// 2. 异步写入，错误静默处理，绝不影响主对话流程
// 3. 按会话 ID 分文件，一个会话一个日志文件
// 4. 工具结果数据截断到 MAX_DATA_LEN，避免日志文件膨胀
// 5. 写入操作串行化（队列），保证事件顺序与实际发生顺序一致
// 6. 自动从 V8 栈中提取调用方文件:行号，并写入人类可读的本地时间字符串
// ---------------------------------------------------------------------------

import { mkdir, appendFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, basename, relative, sep } from "node:path";
import type { LogEvent, LogEventInput } from "./types.js";

/** logger 源文件所在的目录名，用于从栈中过滤掉 logger 内部帧 */
const LOGGER_DIR = "logger";

/** 工具结果数据的最大记录长度（超出截断并标记） */
const MAX_DATA_LEN = 2000;

/** 写入队列最大长度，超过则丢弃最旧的事件（防止极端情况下无限堆积） */
const MAX_QUEUE = 500;

/** 默认日志根目录：~/.dskcode/logs */
export function defaultLogsDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "~";
  return join(home, ".dskcode", "logs");
}

/** ConversationLogger 构造选项 */
export interface ConversationLoggerOptions {
  /** 是否启用日志记录，默认 true */
  enabled?: boolean;
  /**
   * 日志根目录，默认 ~/.dskcode/logs。
   * 实际日志路径为 `<logsDir>/<项目名>/<sessionId>.jsonl`。
   * 测试中可指定临时目录。
   */
  logsDir?: string;
}

/**
 * 从工作目录提取项目名（用于日志分组）。
 * 取 cwd 的 basename，根目录等边界情况兜底为 "_root"。
 */
function projectNameFromCwd(cwd: string): string {
  const name = basename(cwd);
  return name || "_root";
}

/**
 * 对话日志记录器。
 *
 * 每个会话创建一个实例，日志写入 `~/.dskcode/logs/<项目名>/<sessionId>.jsonl`。
 * 所有写入操作异步串行执行，调用方无需 await（fire-and-forget）。
 */
export class ConversationLogger {
  /** 所有活跃的 logger 实例（用于退出时统一 flush） */
  static readonly #instances = new Set<ConversationLogger>();

  /**
   * 刷新所有活跃 logger 实例的缓冲，确保事件落盘。
   * 进程退出前调用。
   */
  static async flushAll(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const logger of ConversationLogger.#instances) {
      promises.push(logger.flush());
    }
    await Promise.allSettled(promises);
  }

  readonly #logPath: string;
  readonly #enabled: boolean;
  #queue: Promise<void> = Promise.resolve();
  #queueLen = 0;
  #closed = false;

  constructor(sessionId: string, cwd: string, options?: ConversationLoggerOptions) {
    this.#enabled = options?.enabled ?? true;
    if (!this.#enabled) {
      this.#logPath = "";
      return;
    }
    const baseDir = options?.logsDir ?? defaultLogsDir();
    const projectName = projectNameFromCwd(cwd);
    this.#logPath = join(baseDir, projectName, `${sessionId}.jsonl`);
    ConversationLogger.#instances.add(this);
  }

  /** 日志文件完整路径（禁用时返回空字符串） */
  get logPath(): string {
    return this.#logPath;
  }

  /** 是否启用日志记录 */
  get enabled(): boolean {
    return this.#enabled;
  }

  /**
   * 记录一个事件。
   *
   * 内部将事件序列化为 pretty JSON 并以多行块的形式追加到日志文件。
   * 写入操作串行排队，保证事件顺序。调用方无需 await。
   */
  log(event: LogEventInput): void {
    if (!this.#enabled || this.#closed) return;

    // 队列过长时丢弃最旧事件，防止内存无限增长
    if (this.#queueLen >= MAX_QUEUE) return;

    // 自动注入可读时间与调用方位置（栈捕获）
    const enriched: LogEvent = {
      ...event,
      time: event.time ?? formatTime(event.ts),
      loc: event.loc ?? captureCallerLocation(),
    };

    this.#queueLen++;
    this.#queue = this.#queue
      .then(() => this.#writeBlock(enriched))
      .catch(() => { /* 日志写入失败静默忽略 */ })
      .finally(() => this.#queueLen--);
  }

  /**
   * 关闭日志记录器。
   *
   * 标记关闭，不再接受新事件，但会等待队列中已有事件写入完成。
   * 返回的 Promise resolve 后保证所有已 log 的事件都已落盘。
   */
  async flush(): Promise<void> {
    this.#closed = true;
    await this.#queue.catch(() => {});
    ConversationLogger.#instances.delete(this);
  }

  /** 将一条事件以多行块的形式写入日志文件 */
  async #writeBlock(event: LogEvent): Promise<void> {
    const dir = join(this.#logPath, "..");
    await mkdir(dir, { recursive: true });
    const block = formatBlock(event);
    await appendFile(this.#logPath, block, "utf-8");
  }

  // -----------------------------------------------------------------------
  // 便捷方法 — 封装常见事件类型，减少调用方样板代码
  // -----------------------------------------------------------------------

  /** 记录会话开始 */
  logSessionStart(sessionId: string, cwd: string, model: string, mode: string): void {
    this.log({ ts: Date.now(), type: "session_start", sessionId, cwd, model, mode });
  }

  /** 记录用户消息 */
  logUserMessage(content: string): void {
    this.log({ ts: Date.now(), type: "user_message", content });
  }

  /** 记录助手文本（一轮中模型输出的完整文本） */
  logAssistantText(content: string, round: number): void {
    this.log({ ts: Date.now(), type: "assistant_text", content, round });
  }

  /** 记录工具调用 */
  logToolCall(name: string, callId: string, args: string, round: number): void {
    this.log({ ts: Date.now(), type: "tool_call", name, callId, arguments: args, round });
  }

  /** 记录工具结果 */
  logToolResult(
    name: string,
    callId: string,
    success: boolean,
    data: string,
    error: string | undefined,
    elapsed: number | undefined,
    round: number,
  ): void {
    this.log({
      ts: Date.now(),
      type: "tool_result",
      name,
      callId,
      success,
      data: truncate(data),
      ...(error ? { error } : {}),
      ...(elapsed !== undefined ? { elapsed } : {}),
      round,
    });
  }

  /** 记录 Token 用量与费用 */
  logUsage(
    model: string,
    promptTokens: number,
    completionTokens: number,
    cachedPromptTokens: number | undefined,
    cost: number,
    round: number,
  ): void {
    this.log({
      ts: Date.now(),
      type: "usage",
      model,
      promptTokens,
      completionTokens,
      ...(cachedPromptTokens !== undefined ? { cachedPromptTokens } : {}),
      cost,
      round,
    });
  }

  /** 记录错误 */
  logError(message: string, stack?: string): void {
    this.log({ ts: Date.now(), type: "error", message, ...(stack ? { stack } : {}) });
  }

  /** 记录一轮对话完成 */
  logTurnDone(elapsed: number, toolRounds: number): void {
    this.log({ ts: Date.now(), type: "turn_done", elapsed, toolRounds });
  }

  /** 记录会话结束 */
  logSessionEnd(elapsed: number): void {
    this.log({ ts: Date.now(), type: "session_end", elapsed });
  }

  /** 记录反射（工具失败归因注入到下一轮 prompt 时） */
  logReflections(items: Array<{ category: string; toolName: string; hint: string }>): void {
    this.log({ ts: Date.now(), type: "reflection", items });
  }
}

/**
 * 截断过长的字符串，超出部分用占位符标记。
 */
function truncate(text: string): string {
  if (text.length <= MAX_DATA_LEN) return text;
  return text.slice(0, MAX_DATA_LEN) + `...[已截断，原始长度 ${text.length}]`;
}

// ---------------------------------------------------------------------------
// 时间格式化
// ---------------------------------------------------------------------------

/** 把毫秒时间戳格式化为 `YYYY-MM-DD HH:mm:ss.SSS`（本地时区） */
function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.` +
    `${pad(d.getMilliseconds(), 3)}`
  );
}

// ---------------------------------------------------------------------------
// 调用方位置捕获（V8 栈解析）
// ---------------------------------------------------------------------------

/**
 * 缓存项目根目录：用于将栈中绝对路径转换为项目相对路径。
 * 第一次调用时基于 import.meta.url 推断。
 */
let projectRootCache: string | null = null;
function getProjectRoot(): string {
  if (projectRootCache !== null) return projectRootCache;
  try {
    // 当前 logger.ts 的 URL，形如 file:///D:/projects/.../ts-version/src/logger/logger.ts
    const here = fileURLToPath(import.meta.url);
    // 向上找 src/ 的父目录作为项目根
    const segments = here.split(sep);
    const srcIdx = segments.lastIndexOf("src");
    projectRootCache = srcIdx > 0 ? segments.slice(0, srcIdx).join(sep) : here;
  } catch {
    projectRootCache = "";
  }
  return projectRootCache;
}

/**
 * 匹配 V8 栈帧的 `at ... (file:line:col)` 或 `at file:line:col`。
 * 捕获组：1=文件路径（可能为 file:// URL），2=行号。
 */
const STACK_FRAME_RE = /\s+at\s+.+?\((.+):(\d+):\d+\)|\s+at\s+(.+):(\d+):\d+/;

/**
 * 从 V8 栈中查找第一个不在 logger 目录下的栈帧，返回其文件:行号。
 * 如果解析失败，返回 `{ file: "<unknown>", line: 0 }`。
 */
function captureCallerLocation(): { file: string; line: number } {
  let stack: string | undefined;
  try {
    const err = new Error();
    Error.captureStackTrace?.(err, captureCallerLocation);
    stack = err.stack;
  } catch {
    return { file: "<unknown>", line: 0 };
  }
  if (!stack) return { file: "<unknown>", line: 0 };

  const root = getProjectRoot();
  const lines = stack.split("\n");

  for (const raw of lines) {
    const m = STACK_FRAME_RE.exec(raw);
    if (!m) continue;
    const filePath = m[1] ?? m[3] ?? "";
    const lineNo = Number(m[2] ?? m[4] ?? "0");
    if (!filePath) continue;

    // 跳过 logger 目录内部的帧
    const normalized = filePath.replace(/^file:\/\/\//, "").replace(/^file:\/\//, "");
    if (normalized.includes(`${sep}${LOGGER_DIR}${sep}`) || normalized.endsWith(`${sep}${LOGGER_DIR}`)) {
      continue;
    }
    // 跳过 node_modules
    if (normalized.includes(`${sep}node_modules${sep}`)) continue;

    let rel = normalized;
    if (root && normalized.startsWith(root)) {
      rel = normalized.slice(root.length).replace(/^[/\\]/, "") || basename(normalized);
    }
    return { file: rel || basename(normalized), line: lineNo };
  }
  return { file: "<unknown>", line: 0 };
}

// ---------------------------------------------------------------------------
// 多行块格式化
// ---------------------------------------------------------------------------

/** 分隔线宽度 */
const SEPARATOR_WIDTH = 80;
const SEPARATOR = "─".repeat(SEPARATOR_WIDTH);

/**
 * 将事件渲染为多行文本块：
 *
 * ────────...
 * [2026-06-29 14:30:45.123] [user_message] @ src/agent/index.ts:253
 * {
 *   "ts": 1782702446439,
 *   "time": "2026-06-29 14:30:45.123",
 *   "loc": { "file": "src/agent/index.ts", "line": 253 },
 *   "type": "user_message",
 *   "content": "你好"
 * }
 *
 * （末尾保留一个空行）
 */
function formatBlock(event: LogEvent): string {
  const header = `[${event.time}] [${event.type}] @ ${event.loc.file}:${event.loc.line}`;
  const body = JSON.stringify(event, null, 2);
  return `${SEPARATOR}\n${header}\n${body}\n\n`;
}
