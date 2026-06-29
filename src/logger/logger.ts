// ---------------------------------------------------------------------------
// 对话日志记录器 — 将用户与 AI 的完整交互过程写入 JSONL 日志文件
//
// 设计要点：
// 1. JSONL 格式（每行一个 JSON 对象），便于机器解析和流式追加
// 2. 异步写入，错误静默处理，绝不影响主对话流程
// 3. 按会话 ID 分文件，一个会话一个日志文件
// 4. 工具结果数据截断到 MAX_DATA_LEN，避免日志文件膨胀
// 5. 写入操作串行化（队列），保证事件顺序与实际发生顺序一致
// ---------------------------------------------------------------------------

import { mkdir, appendFile } from "node:fs/promises";
import { join, basename } from "node:path";
import type { LogEvent } from "./types.js";

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
   * 内部将事件序列化为 JSON 并追加到日志文件。
   * 写入操作串行排队，保证事件顺序。调用方无需 await。
   */
  log(event: LogEvent): void {
    if (!this.#enabled || this.#closed) return;

    // 队列过长时丢弃最旧事件，防止内存无限增长
    if (this.#queueLen >= MAX_QUEUE) return;

    this.#queueLen++;
    this.#queue = this.#queue
      .then(() => this.#writeLine(event))
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

  /** 将一行 JSON 写入日志文件 */
  async #writeLine(event: LogEvent): Promise<void> {
    const dir = join(this.#logPath, "..");
    await mkdir(dir, { recursive: true });
    const line = JSON.stringify(event) + "\n";
    await appendFile(this.#logPath, line, "utf-8");
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
