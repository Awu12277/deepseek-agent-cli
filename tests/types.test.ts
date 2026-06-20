import { describe, it, expect } from "vitest";
import type { ChatMessage, ChatOptions, ChatChunk, Provider, ProviderToolCall, UsageInfo, ModelId } from "../src/provider/index.js";
import type { JSONSchema, ToolContext, ToolResult, Tool } from "../src/tool/index.js";
import type { Config, ProviderConfig, ToolConfig, PluginConfig } from "../src/config/index.js";

/**
 * Compile-time type sanity: these tests never execute.
 * They verify that the exported types are well-formed.
 */

describe("type exports (compile-time checks)", () => {
  it("ChatMessage shape is correct", () => {
    const msg: ChatMessage = { role: "user", content: "hello" };
    expect(msg.role).toBe("user");
    expect(msg.content).toBe("hello");
  });

  it("ChatOptions is optional-friendly", () => {
    const opts: ChatOptions = {};
    expect(opts).toEqual({});
  });

  it("ChatChunk can represent a finished chunk", () => {
    const chunk: ChatChunk = {
      content: "Hello",
      finishReason: "stop",
      usage: { promptTokens: 10, completionTokens: 5 },
    };
    expect(chunk.finishReason).toBe("stop");
    expect(chunk.usage?.promptTokens).toBe(10);
  });

  it("ChatChunk can represent tool calls", () => {
    const chunk: ChatChunk = {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [
        { id: "call_1", name: "read_file", arguments: "{\"path\": \"/src/main.ts\"}" },
      ],
    };
    expect(chunk.toolCalls).toHaveLength(1);
    expect(chunk.toolCalls?.[0]?.name).toBe("read_file");
  });

  it("UsageInfo can include cached prompt tokens", () => {
    const usage: UsageInfo = {
      promptTokens: 100,
      completionTokens: 50,
      cachedPromptTokens: 80,
    };
    expect(usage.cachedPromptTokens).toBe(80);
  });

  it("ProviderToolCall has required fields", () => {
    const tc: ProviderToolCall = {
      id: "call_abc123",
      name: "bash",
      arguments: "{\"command\": \"ls -la\"}",
    };
    expect(tc.id).toBe("call_abc123");
  });

  it("ToolResult can represent success and failure", () => {
    const ok: ToolResult = { success: true, data: "file content" };
    expect(ok.success).toBe(true);

    const err: ToolResult = { success: false, data: "", error: "file not found" };
    expect(err.success).toBe(false);
    expect(err.error).toBe("file not found");
  });

  it("JSONSchema has the required shape", () => {
    const schema: JSONSchema = {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    };
    expect(schema.type).toBe("object");
  });

  it("ToolContext includes cwd and optional signal", () => {
    const ctx: ToolContext = { cwd: "/home" };
    expect(ctx.cwd).toBe("/home");
  });

  it("Provider interface is structurally sound", () => {
    const mock: Provider = {
      name: "test",
      model: () => "test-model",
      countTokens: (text: string) => Math.ceil(text.length / 3),
      chat: async function* () {
        yield { content: "hi", finishReason: null };
      },
    };
    expect(mock.name).toBe("test");
    expect(mock.countTokens("hello")).toBe(2);
  });

  it("Tool interface is structurally sound", () => {
    const mock: Tool = {
      name: "echo",
      description: "echoes input",
      parameters: { type: "object", properties: {} },
      execute: async (_args: unknown, _ctx: ToolContext) => ({
        success: true,
        data: "pong",
      }),
    };
    expect(mock.name).toBe("echo");
  });

  it("Config interfaces are consistent", () => {
    const pc: ProviderConfig = { name: "deepseek", model: "deepseek-v4-flash" };
    const tc: ToolConfig = { name: "bash", enabled: true };
    const plc: PluginConfig = { name: "mcp-gh", command: "npx" };
    const cfg: Config = {
      defaultProvider: "deepseek",
      providers: [pc],
      tools: [tc],
      plugins: [plc],
    };
    expect(cfg.defaultProvider).toBe("deepseek");
    expect(cfg.providers).toHaveLength(1);
    expect(cfg.tools).toHaveLength(1);
    expect(cfg.plugins).toHaveLength(1);
  });

  it("ModelId type accepts valid values", () => {
    const flash: ModelId = "deepseek-v4-flash";
    const pro: ModelId = "deepseek-v4-pro";
    expect(flash).toBe("deepseek-v4-flash");
    expect(pro).toBe("deepseek-v4-pro");
  });

  it("ChatMessage can carry toolCalls", () => {
    const msg: ChatMessage = {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "call_1", name: "bash", arguments: "{\"command\": \"pwd\"}" },
      ],
    };
    expect(msg.toolCalls).toHaveLength(1);
  });
});
