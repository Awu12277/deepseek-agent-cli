// ---------------------------------------------------------------------------
// ConversationLogger 单元测试
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationLogger, defaultLogsDir } from "../src/logger/index.js";
import type { LogEvent } from "../src/logger/index.js";

/**
 * 从一个多行块文本中解析出事件。
 * 块的第 1 行是标题（`[time] [type] @ file:line`），其后是 pretty JSON。
 */
function parseBlock(block: string): LogEvent {
  const lines = block.split("\n");
  // 找到第一个以 `{` 开头的行作为 JSON 起点
  const jsonStart = lines.findIndex((l) => l.trimStart().startsWith("{"));
  if (jsonStart < 0) throw new Error("无法在日志块中找到 JSON 起始行: " + block);
  const jsonText = lines.slice(jsonStart).join("\n");
  return JSON.parse(jsonText) as LogEvent;
}

/** 测试用的模拟项目路径 */
const FAKE_CWD = join(tmpdir(), "my-test-project");

describe("ConversationLogger", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "dskcode-log-"));
  });

  afterEach(async () => {
    try { await rm(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("禁用时不创建任何文件", async () => {
    const logger = new ConversationLogger("test-disabled", FAKE_CWD, {
      enabled: false,
      logsDir: tempDir,
    });
    expect(logger.enabled).toBe(false);
    expect(logger.logPath).toBe("");

    logger.logUserMessage("hello");
    await logger.flush();

    const entries = await readdir(tempDir).catch(() => []);
    expect(entries).toHaveLength(0);
  });

  it("以多行块格式写入日志，每块包含分隔线、标题与 pretty JSON", async () => {
    const logger = new ConversationLogger("test-basic", FAKE_CWD, { logsDir: tempDir });
    logger.logSessionStart("test-basic", FAKE_CWD, "deepseek-v4-flash", "code");
    logger.logUserMessage("你好");
    logger.logAssistantText("你好！有什么可以帮你的？", 0);
    logger.logTurnDone(100, 0);
    await logger.flush();

    const content = await readFile(logger.logPath, "utf-8");

    // 以分隔线切分事件块
    const SEPARATOR = "─".repeat(80);
    const blocks = content.split(SEPARATOR).map((b) => b.trim()).filter(Boolean);
    expect(blocks).toHaveLength(4);

    // 块结构：第 1 行 = 标题 `[time] [type] @ file:line`，其后是 pretty JSON
    const events = blocks.map(parseBlock);
    expect(events[0]?.type).toBe("session_start");
    expect(events[1]?.type).toBe("user_message");
    expect(events[2]?.type).toBe("assistant_text");
    expect(events[3]?.type).toBe("turn_done");

    const userMsg = events[1];
    if (userMsg.type === "user_message") {
      expect(userMsg.content).toBe("你好");
      expect(userMsg.ts).toBeGreaterThan(0);
      // 公共字段：time / loc 被自动填充
      expect(userMsg.time).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
      expect(userMsg.loc.file).toBeTruthy();
      expect(userMsg.loc.line).toBeGreaterThan(0);
    }
  });

  it("记录工具调用和结果", async () => {
    const logger = new ConversationLogger("test-tool", FAKE_CWD, { logsDir: tempDir });
    logger.logToolCall("read_file", "call_1", '{"path":"/src/main.ts"}', 0);
    logger.logToolResult("read_file", "call_1", true, "文件内容...", undefined, 50, 0);
    await logger.flush();

    const content = await readFile(logger.logPath, "utf-8");
    const SEPARATOR = "─".repeat(80);
    const blocks = content.split(SEPARATOR).map((b) => b.trim()).filter(Boolean);
    const events = blocks.map(parseBlock);

    expect(events[0]?.type).toBe("tool_call");
    expect(events[1]?.type).toBe("tool_result");

    const callEvent = events[0];
    if (callEvent.type === "tool_call") {
      expect(callEvent.name).toBe("read_file");
      expect(callEvent.callId).toBe("call_1");
      expect(callEvent.arguments).toBe('{"path":"/src/main.ts"}');
      expect(callEvent.round).toBe(0);
    }

    const resultEvent = events[1];
    if (resultEvent.type === "tool_result") {
      expect(resultEvent.success).toBe(true);
      expect(resultEvent.data).toBe("文件内容...");
      expect(resultEvent.elapsed).toBe(50);
    }
  });

  it("记录 usage 事件包含费用", async () => {
    const logger = new ConversationLogger("test-usage", FAKE_CWD, { logsDir: tempDir });
    logger.logUsage("deepseek-v4-flash", 100, 50, 80, 0.001, 0);
    await logger.flush();

    const content = await readFile(logger.logPath, "utf-8");
    const event = parseBlock(content);
    expect(event.type).toBe("usage");
    if (event.type === "usage") {
      expect(event.promptTokens).toBe(100);
      expect(event.completionTokens).toBe(50);
      expect(event.cachedPromptTokens).toBe(80);
      expect(event.cost).toBe(0.001);
      expect(event.round).toBe(0);
    }
  });

  it("记录错误事件包含堆栈", async () => {
    const logger = new ConversationLogger("test-error", FAKE_CWD, { logsDir: tempDir });
    const err = new Error("测试错误");
    logger.logError(err.message, err.stack);
    await logger.flush();

    const content = await readFile(logger.logPath, "utf-8");
    const event = parseBlock(content);
    expect(event.type).toBe("error");
    if (event.type === "error") {
      expect(event.message).toBe("测试错误");
      expect(event.stack).toBeDefined();
    }
  });

  it("长数据被截断", async () => {
    const logger = new ConversationLogger("test-truncate", FAKE_CWD, { logsDir: tempDir });
    const longData = "x".repeat(3000);
    logger.logToolResult("read_file", "call_1", true, longData, undefined, undefined, 0);
    await logger.flush();

    const content = await readFile(logger.logPath, "utf-8");
    const event = parseBlock(content);
    if (event.type === "tool_result") {
      expect(event.data.length).toBeLessThan(3000);
      expect(event.data).toContain("已截断");
    }
  });

  it("flush 后不再接受新事件", async () => {
    const logger = new ConversationLogger("test-close", FAKE_CWD, { logsDir: tempDir });
    logger.logUserMessage("before flush");
    await logger.flush();

    logger.logUserMessage("after flush");

    const content = await readFile(logger.logPath, "utf-8");
    const SEPARATOR = "─".repeat(80);
    const blocks = content.split(SEPARATOR).map((b) => b.trim()).filter(Boolean);
    expect(blocks).toHaveLength(1);
    const event = parseBlock(blocks[0]);
    expect(event.type).toBe("user_message");
    if (event.type === "user_message") {
      expect(event.content).toBe("before flush");
    }
  });

  it("每个事件块包含可读的时间标题行", async () => {
    const logger = new ConversationLogger("test-header", FAKE_CWD, { logsDir: tempDir });
    logger.logUserMessage("hi");
    await logger.flush();

    const content = await readFile(logger.logPath, "utf-8");
    // 标题行格式：`[YYYY-MM-DD HH:mm:ss.SSS] [type] @ file:line`
    const headerRe = /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\] \[user_message\] @ .+:\d+$/m;
    expect(content).toMatch(headerRe);
  });

  it("日志路径包含项目名分组目录", async () => {
    const logger = new ConversationLogger("test-path", FAKE_CWD, { logsDir: tempDir });
    // 路径应为 tempDir/my-test-project/test-path.jsonl
    expect(logger.logPath).toContain("my-test-project");
    expect(logger.logPath).toContain("test-path.jsonl");
    logger.logUserMessage("test");
    await logger.flush();
  });

  it("不同项目名的会话写入各自的项目分组目录", async () => {
    const logger1 = new ConversationLogger("session-a", join(tmpdir(), "project-alpha"), { logsDir: tempDir });
    const logger2 = new ConversationLogger("session-b", join(tmpdir(), "project-beta"), { logsDir: tempDir });

    logger1.logUserMessage("from alpha");
    logger2.logUserMessage("from beta");

    await Promise.all([logger1.flush(), logger2.flush()]);

    // 验证目录结构：tempDir 下有 project-alpha 和 project-beta 两个子目录
    const subDirs = await readdir(tempDir);
    expect(subDirs).toContain("project-alpha");
    expect(subDirs).toContain("project-beta");

    const content1 = await readFile(logger1.logPath, "utf-8");
    const content2 = await readFile(logger2.logPath, "utf-8");

    // 文本内容以 JSON 字符串形式写入，直接搜索（pretty 模式下引号不会被转义为 \"）
    expect(content1).toContain('"from alpha"');
    expect(content2).toContain('"from beta"');
  });

  it("同一项目的多个会话写入同一个项目分组目录", async () => {
    const logger1 = new ConversationLogger("session-1", FAKE_CWD, { logsDir: tempDir });
    const logger2 = new ConversationLogger("session-2", FAKE_CWD, { logsDir: tempDir });

    logger1.logUserMessage("from session 1");
    logger2.logUserMessage("from session 2");

    await Promise.all([logger1.flush(), logger2.flush()]);

    // 两个日志文件都在同一个项目目录下
    const projectDir = join(tempDir, "my-test-project");
    const files = await readdir(projectDir);
    expect(files).toContain("session-1.jsonl");
    expect(files).toContain("session-2.jsonl");

    const content1 = await readFile(logger1.logPath, "utf-8");
    const content2 = await readFile(logger2.logPath, "utf-8");

    // 内容以 JSON 字符串形式存在（pretty 模式下引号不会被转义）
    expect(content1).toContain('"from session 1"');
    expect(content2).toContain('"from session 2"');
    expect(content1).not.toContain('"from session 2"');
    expect(content2).not.toContain('"from session 1"');
  });

  it("flushAll 刷新所有活跃实例", async () => {
    const logger1 = new ConversationLogger("flush-1", FAKE_CWD, { logsDir: tempDir });
    const logger2 = new ConversationLogger("flush-2", FAKE_CWD, { logsDir: tempDir });

    logger1.logUserMessage("msg1");
    logger2.logUserMessage("msg2");

    await ConversationLogger.flushAll();

    const content1 = await readFile(logger1.logPath, "utf-8");
    const content2 = await readFile(logger2.logPath, "utf-8");
    // 文本以 JSON 字符串写入（pretty 模式下引号不会被转义）
    expect(content1).toContain('"msg1"');
    expect(content2).toContain('"msg2"');
  });

  it("defaultLogsDir 返回用户目录下的 .dskcode/logs", () => {
    const dir = defaultLogsDir();
    expect(dir).toContain(".dskcode");
    expect(dir).toContain("logs");
  });
});
