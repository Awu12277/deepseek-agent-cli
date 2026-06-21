/**
 * 工具系统集成测试 — 验证工具注册、执行、Session 集成的完整链路
 */
import { describe, it, expect, beforeEach } from "vitest";
import { ToolRegistry } from "../src/tool/registry.js";
import { builtinTools } from "../src/tool/builtins/index.js";
import { readFileTool } from "../src/tool/builtins/read-file.js";
import { bashTool } from "../src/tool/builtins/bash.js";
import { editFileTool } from "../src/tool/builtins/edit-file.js";
import { writeFileTool } from "../src/tool/builtins/write-file.js";
import { lsTool } from "../src/tool/builtins/ls.js";
import { Session } from "../src/agent/index.js";
import { CostTracker } from "../src/provider/cost-tracker.js";
import type { Provider, ChatChunk, ChatMessage } from "../src/provider/index.js";
import type { ToolContext } from "../src/tool/types.js";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// 工具上下文工厂
// ---------------------------------------------------------------------------
function createTestContext(cwd?: string): ToolContext {
  return { cwd: cwd ?? process.cwd(), signal: undefined, timeout: 5000 };
}

// ---------------------------------------------------------------------------
// 注册表集成测试
// ---------------------------------------------------------------------------
describe("工具系统集成测试", () => {
  it("ToolRegistry 注册所有内置工具并通过名称执行", async () => {
    const registry = new ToolRegistry();
    registry.registerAll(builtinTools);

    // 验证注册
    expect(registry.list().length).toBe(8);
    expect(registry.names()).toContain("read_file");
    expect(registry.names()).toContain("write_file");
    expect(registry.names()).toContain("edit_file");
    expect(registry.names()).toContain("bash");
    expect(registry.names()).toContain("glob");
    expect(registry.names()).toContain("grep");
    expect(registry.names()).toContain("ls");
    expect(registry.names()).toContain("fetch");

    // 通过 registry 执行 read_file
    const ctx = createTestContext();
    const result = await registry.execute("read_file", { path: join(process.cwd(), "package.json") }, ctx);
    expect(result.success).toBe(true);
    expect(result.data).toContain("dskcode");
  });

  it("Session 与 ToolRegistry 集成 — 工具调用链路完整", async () => {
    // 创建带工具的 Session
    const registry = new ToolRegistry();
    registry.registerAll(builtinTools);

    // Mock: 第一轮返回工具调用，第二轮返文本回答
    let callCount = 0;
    const mockProvider: Provider = {
      name: "mock",
      model: () => "deepseek-v4-flash",
      countTokens: (text: string) => Math.ceil(text.length / 3),
      chat: async function* (_messages: ChatMessage[]): AsyncIterable<ChatChunk> {
        callCount++;
        if (callCount === 1) {
          // 第一轮：请求读取 package.json
          yield {
            content: "让我看看你的项目配置",
            finishReason: null,
          };
          yield {
            content: "",
            finishReason: "tool_calls",
            toolCalls: [
              {
                id: "call_int_test_1",
                name: "read_file",
                arguments: JSON.stringify({ path: "package.json" }),
              },
            ],
          };
          yield {
            content: "",
            finishReason: null,
            usage: { promptTokens: 100, completionTokens: 50 },
          };
        } else {
          // 第二轮：根据工具结果回答
          yield { content: "这是一个 dskcode 项目。", finishReason: "stop" };
          yield {
            content: "",
            finishReason: null,
            usage: { promptTokens: 200, completionTokens: 30 },
          };
        }
      },
    };

    const costTracker = new CostTracker({ budgetLimit: 0, tokenBudgetLimit: 0 });
    const session = new Session(mockProvider, registry, costTracker, {
      cwd: process.cwd(),
    });

    const events: Array<{ type: string; data?: unknown }> = [];
    for await (const event of session.chat("看看我的项目")) {
      events.push({ type: event.type, data: event });
    }

    // 验证事件链路:
    // 1. text_delta (模型第一个回复)
    // 2. tool_calls (模型请求执行 read_file)
    // 3. tool_result (read_file 执行结果)
    // 4. text_delta (模型最终回复)
    // 5. done
    const toolCallsEvent = events.find((e) => e.type === "tool_calls");
    expect(toolCallsEvent).toBeDefined();

    const toolResultEvent = events.find((e) => e.type === "tool_result");
    expect(toolResultEvent).toBeDefined();
    if (toolResultEvent && toolResultEvent.type === "tool_result") {
      const result = toolResultEvent.data as { name: string; result: { success: boolean; data: string } };
      expect(result.name).toBe("read_file");
      expect(result.result.success).toBe(true);
      expect(result.result.data).toContain("dskcode");
    }

    // 第二轮应该有文本回复
    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toBeDefined();

    // 应该调用了 2 轮 Provider
    expect(callCount).toBe(2);
  });

  it("edit_file 集成测试 — 实际创建、编辑、验证文件", async () => {
    const testDir = join(tmpdir(), "dskcode-integration-edit");
    await mkdir(testDir, { recursive: true });
    const testFile = join(testDir, "config.txt");

    try {
      // 1. 创建文件
      const writeResult = await writeFileTool.execute(
        { path: testFile, content: "name: test\nversion: 1.0\n" },
        createTestContext(),
      );
      expect(writeResult.success).toBe(true);

      // 2. 修改文件
      const editResult = await editFileTool.execute(
        { path: testFile, old_text: "version: 1.0", new_text: "version: 2.0" },
        createTestContext(),
      );
      expect(editResult.success).toBe(true);

      // 3. 验证修改结果
      const readResult = await readFileTool.execute(
        { path: testFile },
        createTestContext(),
      );
      expect(readResult.success).toBe(true);
      expect(readResult.data).toContain("version: 2.0");
      expect(readResult.data).not.toContain("version: 1.0");
    } finally {
      await rm(testDir, { recursive: true }).catch(() => {});
    }
  });

  it("ls 集成测试 — 列出临时目录", async () => {
    const testDir = join(tmpdir(), "dskcode-integration-ls");
    await mkdir(testDir, { recursive: true });
    await writeFile(join(testDir, "hello.txt"), "hello", "utf-8");
    await writeFile(join(testDir, "world.ts"), "world", "utf-8");

    try {
      const result = await lsTool.execute({ path: testDir }, createTestContext());
      expect(result.success).toBe(true);
      expect(result.data).toContain("hello.txt");
      expect(result.data).toContain("world.ts");
    } finally {
      await rm(testDir, { recursive: true }).catch(() => {});
    }
  });

  it("bash 集成测试 — 执行 node 命令", async () => {
    const result = await bashTool.execute(
      { command: "node -e \"console.log('integration test ok')\"" },
      createTestContext(),
    );
    expect(result.success).toBe(true);
    expect(result.data).toContain("integration test ok");
  });

  it("注册表禁用 — 被禁用的工具不可执行", async () => {
    const registry = new ToolRegistry();
    registry.registerAll(builtinTools);

    // 禁用 bash
    registry.disable("bash");

    const result = await registry.execute("bash", { command: "echo test" }, createTestContext());
    expect(result.success).toBe(false);
    expect(result.error).toBe("TOOL_NOT_FOUND");
  });
});