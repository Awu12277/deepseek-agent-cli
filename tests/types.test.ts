import { describe, it, expect } from "vitest";
import type { ChatMessage, ChatOptions, ChatChunk, Provider } from "../src/provider/index.js";
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
      chat: async function* () {
        yield { content: "hi", finishReason: null };
      },
    };
    expect(mock.name).toBe("test");
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
    const pc: ProviderConfig = { name: "deepseek", model: "deepseek-chat" };
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
});
