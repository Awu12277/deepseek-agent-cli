// ---------------------------------------------------------------------------
// Agent 主循环单元测试
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach } from "vitest";
import type { Provider, ChatChunk, ChatMessage } from "../src/provider/index.js";
import type { AgentEvent } from "../src/agent/types.js";
import { Session } from "../src/agent/index.js";
import { buildSystemPrompt } from "../src/agent/system-prompt.js";
import {
  trimMessages,
  buildApiMessages,
  formatUsageSummary,
} from "../src/agent/message-builder.js";
import { CostTracker } from "../src/provider/cost-tracker.js";

// ---------------------------------------------------------------------------
// Mock Provider
// ---------------------------------------------------------------------------

/** 创建一个 mock Provider，返回预设的流式 chunks */
function createMockProvider(
  chunks: ChatChunk[],
  modelId = "deepseek-v4-flash",
): Provider {
  return {
    name: "mock",
    model: () => modelId,
    countTokens: (text: string) => Math.ceil(text.length / 3),
    chat: async function* (
      _messages: ChatMessage[],
      _opts?: unknown,
    ): AsyncIterable<ChatChunk> {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// system-prompt 测试
// ---------------------------------------------------------------------------

describe("buildSystemPrompt", () => {
  it("包含角色定义和模型信息", () => {
    const prompt = buildSystemPrompt({
      model: "deepseek-v4-flash",
      maxToolRounds: 15,
      cwd: "/home/user/project",
    });
    expect(prompt).toContain("dskcode");
    expect(prompt).toContain("deepseek-v4-flash");
    expect(prompt).toContain("/home/user/project");
  });

  it("包含时间上下文", () => {
    const prompt = buildSystemPrompt({
      model: "deepseek-v4-flash",
      maxToolRounds: 15,
      cwd: "/test",
    });
    expect(prompt).toContain("当前日期");
    expect(prompt).toContain("当前时间");
  });

  it("包含工具描述（当 tools 非空时）", () => {
    const prompt = buildSystemPrompt({
      model: "deepseek-v4-flash",
      maxToolRounds: 15,
      cwd: "/test",
      tools: [
        {
          name: "read_file",
          description: "读取文件内容",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      ],
    });
    expect(prompt).toContain("read_file");
    expect(prompt).toContain("读取文件内容");
    expect(prompt).toContain("当前可用的工具");
  });

  it("不包含工具描述（当 tools 为空时）", () => {
    const prompt = buildSystemPrompt({
      model: "deepseek-v4-flash",
      maxToolRounds: 15,
      cwd: "/test",
    });
    expect(prompt).not.toContain("当前可用的工具");
  });

  it("包含项目上下文（当提供时）", () => {
    const prompt = buildSystemPrompt({
      model: "deepseek-v4-flash",
      maxToolRounds: 15,
      cwd: "/test",
      projectContext: "这是一个 TypeScript CLI 项目",
    });
    expect(prompt).toContain("这是一个 TypeScript CLI 项目");
    expect(prompt).toContain("项目上下文");
  });

  it("包含行为约束", () => {
    const prompt = buildSystemPrompt({
      model: "deepseek-v4-flash",
      maxToolRounds: 15,
      cwd: "/test",
    });
    expect(prompt).toContain("行为约束");
  });

  it("包含回答格式约束", () => {
    const prompt = buildSystemPrompt({
      model: "deepseek-v4-flash",
      maxToolRounds: 15,
      cwd: "/test",
    });
    expect(prompt).toContain("回答格式");
    expect(prompt).toContain("反引号");
    expect(prompt).toContain("加粗");
  });

  it("包含工作流程说明", () => {
    const prompt = buildSystemPrompt({
      model: "deepseek-v4-flash",
      maxToolRounds: 15,
      cwd: "/test",
    });
    expect(prompt).toContain("工作流程");
    expect(prompt).toContain("15");
  });
});

// ---------------------------------------------------------------------------
// message-builder 测试
// ---------------------------------------------------------------------------

describe("buildApiMessages", () => {
  it("在消息历史前面插入 system prompt", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "你好" },
      { role: "assistant", content: "你好！有什么可以帮你的？" },
    ];

    const result = buildApiMessages("你是 dskcode", history);

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ role: "system", content: "你是 dskcode" });
    expect(result[1]).toEqual({ role: "user", content: "你好" });
    expect(result[2]).toEqual({ role: "assistant", content: "你好！有什么可以帮你的？" });
  });

  it("空历史时只返回 system prompt", () => {
    const result = buildApiMessages("你是 dskcode", []);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ role: "system", content: "你是 dskcode" });
  });
});

describe("trimMessages", () => {
  it("不裁剪短消息历史", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "你好" },
      { role: "assistant", content: "你好！" },
    ];

    const [trimmed, wasTrimmed] = trimMessages(messages, {
      model: "deepseek-v4-flash",
      reservedForOutput: 4096,
      systemPrompt: "system",
      preserveRecentRounds: 10,
    });

    expect(trimmed).toHaveLength(2);
    expect(wasTrimmed).toBe(false);
  });

  it("保留 system prompt 空间", () => {
    const messages: ChatMessage[] = [{ role: "user", content: "short" }];

    const prompt = "sys";
    const [trimmed] = trimMessages(messages, {
      model: "deepseek-v4-flash",
      reservedForOutput: 4096,
      systemPrompt: prompt,
      preserveRecentRounds: 10,
    });

    // 消息应该保留（上下文窗口 1M tokens，远大于需要）
    expect(trimmed.length).toBeGreaterThanOrEqual(1);
  });
});

describe("formatUsageSummary", () => {
  it("格式化基本的 token 使用量", () => {
    const summary = formatUsageSummary({
      promptTokens: 100,
      completionTokens: 50,
    });
    expect(summary).toContain("100");
    expect(summary).toContain("50");
    expect(summary).toContain("150");
  });

  it("包含缓存命中率（当有缓存命中时）", () => {
    const summary = formatUsageSummary({
      promptTokens: 100,
      completionTokens: 50,
      cachedPromptTokens: 80,
    });
    expect(summary).toContain("80.0%");
  });

  it("不包含缓存命中率（当缓存为 0 时）", () => {
    const summary = formatUsageSummary({
      promptTokens: 100,
      completionTokens: 50,
    });
    expect(summary).not.toContain("缓存命中");
  });
});

// ---------------------------------------------------------------------------
// Session 测试
// ---------------------------------------------------------------------------

describe("Session", () => {
  let costTracker: CostTracker;

  beforeEach(() => {
    costTracker = new CostTracker({ budgetLimit: 0, tokenBudgetLimit: 0 });
  });

  it("单轮对话：纯文本回复", async () => {
    const chunks: ChatChunk[] = [
      { content: "你好", finishReason: null },
      { content: "！有", finishReason: null },
      { content: "什么可以帮你的？", finishReason: "stop" },
      {
        content: "",
        finishReason: null,
        usage: { promptTokens: 10, completionTokens: 20 },
      },
    ];

    const provider = createMockProvider(chunks);
    const session = new Session(provider, [], costTracker);

    const events: AgentEvent[] = [];
    for await (const event of session.chat("你好")) {
      events.push(event);
    }

    // 应该有文本增量事件
    const textDeltas = events.filter((e) => e.type === "text_delta");
    expect(textDeltas.length).toBe(3);

    // 应该有 done 事件
    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toBeDefined();
    if (doneEvent && doneEvent.type === "done") {
      expect(doneEvent.elapsed).toBeGreaterThanOrEqual(0);
    }

    // 应该有 usage 事件
    const usageEvent = events.find((e) => e.type === "usage");
    expect(usageEvent).toBeDefined();

    // 消息历史应该包含 user + assistant
    expect(session.messages).toHaveLength(2);
    expect(session.messages[0]).toEqual({ role: "user", content: "你好" });
  });

  it("单轮对话：工具调用回复", async () => {
    // 模拟工具调用场景：
    // 第一轮：模型返回工具调用
    // 第二轮：模型基于工具结果返回最终回答
    let callCount = 0;
    const toolCallProvider: Provider = {
      name: "mock",
      model: () => "deepseek-v4-flash",
      countTokens: (text: string) => Math.ceil(text.length / 3),
      chat: async function* (
        _messages: ChatMessage[],
        _opts?: unknown,
      ): AsyncIterable<ChatChunk> {
        callCount++;
        if (callCount === 1) {
          // 第一轮：返回工具调用
          yield { content: "让我查看一下这个文件", finishReason: null };
          yield {
            content: "",
            finishReason: "tool_calls",
            toolCalls: [
              { id: "call_1", name: "read_file", arguments: '{"path":"/src/main.ts"}' },
            ],
          };
          yield {
            content: "",
            finishReason: null,
            usage: { promptTokens: 50, completionTokens: 30 },
          };
        } else {
          // 第二轮：基于工具结果返回最终回答
          yield { content: "文件内容如下", finishReason: "stop" };
          yield {
            content: "",
            finishReason: null,
            usage: { promptTokens: 100, completionTokens: 50 },
          };
        }
      },
    };

    const session = new Session(toolCallProvider, [], costTracker);

    const events: AgentEvent[] = [];
    for await (const event of session.chat("看看 main.ts")) {
      events.push(event);
    }

    // 应该有工具调用事件
    const toolCallsEvent = events.find((e) => e.type === "tool_calls");
    expect(toolCallsEvent).toBeDefined();

    // 应该有工具结果事件（read_file 未注册，所以返回错误）
    const toolResultEvent = events.find((e) => e.type === "tool_result");
    expect(toolResultEvent).toBeDefined();
    if (toolResultEvent && toolResultEvent.type === "tool_result") {
      expect(toolResultEvent.name).toBe("read_file");
      expect(toolResultEvent.result.success).toBe(false);
    }

    // 第二轮的文本回答应该也被接收
    const textDeltas = events.filter((e) => e.type === "text_delta");
    expect(textDeltas.length).toBeGreaterThan(1); // 至少有第一轮和第二轮的文本

    // 应该有 done 事件
    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toBeDefined();
  });

  it("错误处理：Provider 抛出异常", async () => {
    const errorProvider: Provider = {
      name: "error",
      model: () => "deepseek-v4-flash",
      countTokens: () => 0,
      // eslint-disable-next-line require-yield
      chat: async function* () {
        throw new Error("网络连接失败");
      },
    };

    const session = new Session(errorProvider, [], costTracker);

    const events: AgentEvent[] = [];
    for await (const event of session.chat("你好")) {
      events.push(event);
    }

    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    if (errorEvent && errorEvent.type === "error") {
      expect(errorEvent.error.message).toBe("网络连接失败");
    }
  });

  it("reset 清空消息历史", async () => {
    const chunks: ChatChunk[] = [{ content: "好的", finishReason: "stop" }];

    const provider = createMockProvider(chunks);
    const session = new Session(provider, [], costTracker);

    for await (const _event of session.chat("你好")) {
      // 消费事件
    }

    expect(session.messages.length).toBeGreaterThan(0);

    session.reset();

    expect(session.messages).toHaveLength(0);
  });

  it("多轮对话保持上下文", async () => {
    // 第一轮
    const chunks1: ChatChunk[] = [{ content: "你好", finishReason: "stop" }];
    // 第二轮
    const chunks2: ChatChunk[] = [{ content: "当然可以", finishReason: "stop" }];

    let callCount = 0;
    const multiProvider: Provider = {
      name: "multi",
      model: () => "deepseek-v4-flash",
      countTokens: () => 0,
      chat: async function* (_messages: ChatMessage[]) {
        callCount++;
        const chunks = callCount === 1 ? chunks1 : chunks2;
        for (const chunk of chunks) {
          yield chunk;
        }
      },
    };

    const session = new Session(multiProvider, [], costTracker);

    // 第一轮
    for await (const _event of session.chat("你好")) {
      // 消费
    }

    // 第二轮
    for await (const _event of session.chat("帮我写个函数")) {
      // 消费
    }

    // 消息历史应包含 4 条消息：2 个 user + 2 个 assistant
    expect(session.messages).toHaveLength(4);
    expect(session.messages[0].role).toBe("user");
    expect(session.messages[1].role).toBe("assistant");
    expect(session.messages[2].role).toBe("user");
    expect(session.messages[3].role).toBe("assistant");
  });

  it("应将 reasoning_content 转译为 reasoning_delta 事件", async () => {
    // thinking 模式下模型会同时返回 reasoning_content 和 content。
    // 验证 Session 不会把 reasoning 和 content 混在同一个 text_delta 里。
    const chunks: ChatChunk[] = [
      { content: "", reasoningContent: "让我先思考", finishReason: null },
      { content: "", reasoningContent: "一下这个问题", finishReason: null },
      { content: "答案是 42", finishReason: "stop" },
      {
        content: "",
        finishReason: null,
        usage: { promptTokens: 10, completionTokens: 20 },
      },
    ];

    const provider = createMockProvider(chunks);
    const session = new Session(provider, [], costTracker);

    const events: AgentEvent[] = [];
    for await (const event of session.chat("9.11 和 9.8 哪个大？")) {
      events.push(event);
    }

    const reasoningDeltas = events.filter((e) => e.type === "reasoning_delta");
    expect(reasoningDeltas).toHaveLength(2);
    if (reasoningDeltas[0] && reasoningDeltas[0].type === "reasoning_delta") {
      expect(reasoningDeltas[0].content).toBe("让我先思考");
    }
    if (reasoningDeltas[1] && reasoningDeltas[1].type === "reasoning_delta") {
      expect(reasoningDeltas[1].content).toBe("一下这个问题");
    }

    const textDeltas = events.filter((e) => e.type === "text_delta");
    expect(textDeltas).toHaveLength(1);
    if (textDeltas[0] && textDeltas[0].type === "text_delta") {
      expect(textDeltas[0].content).toBe("答案是 42");
    }

    // 消息历史只存最终答案，不污染 CoT
    expect(session.messages).toHaveLength(2);
    const assistant = session.messages[1]!;
    expect(assistant.role).toBe("assistant");
    expect(assistant.content).toBe("答案是 42");
  });

  it("多轮思考：reasoning → tool_call → reasoning 都能被转译为独立 reasoning_delta 事件", async () => {
    // 验证多轮推理 + 调工具场景下，每一段 CoT 都独立发出（不合并、不丢失）。
    // 第一轮：reasoning1 + 调工具
    // 第二轮：reasoning2 + 最终答案
    let callCount = 0;
    const provider: Provider = {
      name: "mock",
      model: () => "deepseek-v4-flash",
      countTokens: (text: string) => Math.ceil(text.length / 3),
      chat: async function* (_messages: ChatMessage[]) {
        callCount++;
        if (callCount === 1) {
          yield { content: "", reasoningContent: "先调查项目结构", finishReason: null };
          yield { content: "", reasoningContent: "，看看有哪些文件", finishReason: null };
          yield {
            content: "",
            finishReason: "tool_calls",
            toolCalls: [{ id: "call_1", name: "ls", arguments: '{"path":"."}' }],
          };
          yield {
            content: "",
            finishReason: null,
            usage: { promptTokens: 10, completionTokens: 5 },
          };
        } else {
          yield { content: "", reasoningContent: "看完结果后总结：", finishReason: null };
          yield { content: "项目共 5 个源文件", finishReason: "stop" };
          yield {
            content: "",
            finishReason: null,
            usage: { promptTokens: 30, completionTokens: 10 },
          };
        }
      },
    };

    const session = new Session(provider, [], costTracker);
    const events: AgentEvent[] = [];
    for await (const event of session.chat("看看项目结构")) {
      events.push(event);
    }

    // 3 个 reasoning_delta 独立发出
    const reasoningDeltas = events
      .filter(
        (e): e is { type: "reasoning_delta"; content: string } =>
          e.type === "reasoning_delta",
      )
      .map((e) => e.content);
    expect(reasoningDeltas).toEqual([
      "先调查项目结构",
      "，看看有哪些文件",
      "看完结果后总结：",
    ]);

    // 调了 1 次工具
    expect(events.filter((e) => e.type === "tool_calls")).toHaveLength(1);
    expect(events.filter((e) => e.type === "tool_result")).toHaveLength(1);
  });
});
