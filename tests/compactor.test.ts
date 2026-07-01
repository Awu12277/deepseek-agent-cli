// ---------------------------------------------------------------------------
// 上下文压缩（Compactor）单元测试
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import type { ChatMessage, ChatChunk, Provider } from "../src/provider/index.js";
import {
  estimateMessagesTokens,
  getContextStats,
  shouldAutoCompact,
  compactContext,
  summarizeOldTurns,
  buildSummaryMessage,
  DEFAULT_AUTO_COMPACT_RATIO,
  DEFAULT_MIN_TURNS_TO_COMPACT,
  DEFAULT_PRESERVE_ROUNDS,
  SUMMARY_SENTINEL,
} from "../src/agent/compactor.js";
import { estimateTokens } from "../src/provider/models.js";

// ---------------------------------------------------------------------------
// Mock Provider
// ---------------------------------------------------------------------------

/**
 * 创建一个流式返回预设 chunks 的 mock Provider。
 * chunks 可空（空数组 = provider 立即结束，无任何 content）。
 */
function createMockProvider(
  chunks: ChatChunk[],
  modelId = "deepseek-v4-flash",
  onChat?: (messages: ChatMessage[]) => void,
): Provider {
  return {
    name: "mock",
    model: () => modelId,
    countTokens: (text: string) => estimateTokens(text),
    chat: async function* (
      messages: ChatMessage[],
    ): AsyncIterable<ChatChunk> {
      onChat?.(messages);
      for (const chunk of chunks) yield chunk;
    },
  };
}

/**
 * 创建一个调 chat 时抛错的 mock Provider。
 */
function createFailingProvider(errorMessage = "LLM 不可用"): Provider {
  return {
    name: "failing",
    model: () => "deepseek-v4-flash",
    countTokens: (text: string) => estimateTokens(text),
    chat: async function* (): AsyncIterable<ChatChunk> {
      throw new Error(errorMessage);
    },
  };
}

// ---------------------------------------------------------------------------
// 测试工具
// ---------------------------------------------------------------------------

/**
 * 构造 N 个回合的 messages，每个回合：1 user + 1 assistant（指定 content 长度）。
 */
function makeMessages(
  rounds: number,
  userContentLen: number,
  assistantContentLen: number,
): ChatMessage[] {
  const result: ChatMessage[] = [];
  for (let i = 0; i < rounds; i++) {
    result.push({ role: "user", content: "U".repeat(userContentLen) + i });
    result.push({
      role: "assistant",
      content: "A".repeat(assistantContentLen) + i,
    });
  }
  return result;
}

/** 一个含 tool_call + tool 配对的回合 */
function makeToolTurn(userText: string, toolName: string, toolOutput: string): ChatMessage[] {
  return [
    { role: "user", content: userText },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "c1", name: toolName, arguments: '{"path":"/tmp/x"}' },
      ],
    },
    { role: "tool", toolCallId: "c1", name: toolName, content: toolOutput },
  ];
}

// ---------------------------------------------------------------------------
// estimateMessagesTokens
// ---------------------------------------------------------------------------

describe("estimateMessagesTokens", () => {
  it("空数组返回 0", () => {
    expect(estimateMessagesTokens([])).toBe(0);
  });

  it("单条 user 消息返回非零正数", () => {
    const tokens = estimateMessagesTokens([{ role: "user", content: "你好世界" }]);
    expect(tokens).toBeGreaterThan(0);
  });

  it("tool_calls 的 name+arguments 计入 token", () => {
    const withoutTool: ChatMessage[] = [{ role: "user", content: "hi" }];
    const withTool: ChatMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "c1",
            name: "read_file",
            arguments: '{"path":"/a/very/long/file/path.ts"}',
          },
        ],
      },
    ];
    expect(estimateMessagesTokens(withTool)).toBeGreaterThan(
      estimateMessagesTokens(withoutTool),
    );
  });

  it("tool 角色的消息也算 token", () => {
    const tokens = estimateMessagesTokens([
      { role: "tool", toolCallId: "c1", name: "read_file", content: "文件内容…" },
    ]);
    expect(tokens).toBeGreaterThan(0);
  });

  it("中英文混合消息的 token 估算稳定", () => {
    // 构造足够长的内容，让 ceil 的差异体现出来
    // 10 个汉字 = 6 token（0.6/字），10 个字母 = 3 token（0.3/字）
    const t1 = estimateMessagesTokens([{ role: "user", content: "a".repeat(100) }]);
    const t2 = estimateMessagesTokens([{ role: "user", content: "中".repeat(100) }]);
    // 100×0.3=30 vs 100×0.6=60，CJK 应明显更高
    expect(t2).toBeGreaterThan(t1 * 1.5);
  });
});

// ---------------------------------------------------------------------------
// getContextStats
// ---------------------------------------------------------------------------

describe("getContextStats", () => {
  it("空消息：messageCount=0, ratio=0", () => {
    const s = getContextStats([], 1000);
    expect(s.messageCount).toBe(0);
    expect(s.estimatedTokens).toBe(0);
    expect(s.ratio).toBe(0);
    expect(s.headroom).toBe(1000);
  });

  it("短消息：ratio < 0.01", () => {
    const s = getContextStats([{ role: "user", content: "hi" }], 1_000_000);
    expect(s.ratio).toBeLessThan(0.01);
    expect(s.headroom).toBeGreaterThan(999_000);
  });

  it("超长消息：ratio > 1, headroom 为负", () => {
    // 1000 字符 × 0.3 = 300 token + 10 overhead ≈ 310 / 条；2000 条 ≈ 620_000
    const msgs = makeMessages(2000, 1000, 0);
    const s = getContextStats(msgs, 1_000_000);
    expect(s.ratio).toBeGreaterThan(0.5);
    // 不强制 > 1（1M 窗口足够），但 headroom 应小于 500_000
    expect(s.headroom).toBeLessThan(500_000);
  });

  it("正确计算 contextWindow 比例", () => {
    const msgs = makeMessages(100, 100, 0); // ~100*40 = 4000 token
    const s = getContextStats(msgs, 10_000);
    expect(s.contextWindow).toBe(10_000);
    expect(s.ratio).toBeGreaterThan(0.3);
    expect(s.ratio).toBeLessThan(0.6);
  });
});

// ---------------------------------------------------------------------------
// shouldAutoCompact
// ---------------------------------------------------------------------------

describe("shouldAutoCompact", () => {
  const baseOpts = (provider: Provider = createMockProvider([])) => ({
    contextWindow: 1_000_000,
    provider,
  });

  it("回合数 < minTurns：不压缩", () => {
    // 5 个回合（< 默认 8）
    const msgs = makeMessages(5, 100, 100);
    expect(shouldAutoCompact(msgs, baseOpts())).toBe(false);
  });

  it("回合数足够但 ratio < 阈值：不压缩", () => {
    // 10 个回合但每条 1 字符，总 token 远小于 0.85 × 1_000_000
    const msgs = makeMessages(10, 1, 1);
    expect(shouldAutoCompact(msgs, baseOpts())).toBe(false);
  });

  it("回合数足够且 ratio >= 阈值：压缩", () => {
    // 10 回合 × (500+500) 字符 = 20 条 × 320 token ≈ 6400 token / 1000 窗口 = 6.4 远超阈值
    const msgs = makeMessages(10, 500, 500);
    expect(
      shouldAutoCompact(msgs, { ...baseOpts(), contextWindow: 1000 }),
    ).toBe(true);
  });

  it("自定义 minTurnsToCompact 生效", () => {
    // 3 回合（超小窗口下 token 足）默认 minTurns=8 → 不压缩
    const msgs = makeMessages(3, 500, 500);
    expect(
      shouldAutoCompact(msgs, { ...baseOpts(), contextWindow: 1000 }),
    ).toBe(false);
    // minTurns=2 → 走 ratio 判断 → 3 回合 × 2 条 × 320 = 1920 token / 1000 = 1.92 > 0.85
    expect(
      shouldAutoCompact(msgs, {
        ...baseOpts(),
        contextWindow: 1000,
        minTurnsToCompact: 2,
      }),
    ).toBe(true);
  });

  it("自定义 autoCompactRatio 生效", () => {
    const msgs = makeMessages(10, 100, 100);
    // ratio ≈ 200/1000 = 0.2
    // 默认 0.85 → 不压缩
    expect(shouldAutoCompact(msgs, { ...baseOpts(), contextWindow: 1000 })).toBe(false);
    // 调到 0.1 → 压缩
    expect(
      shouldAutoCompact(msgs, {
        ...baseOpts(),
        contextWindow: 1000,
        autoCompactRatio: 0.1,
      }),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// compactContext — 边界
// ---------------------------------------------------------------------------

describe("compactContext — 边界", () => {
  it("短消息不压缩：返回原 messages（顺序不变），droppedTurns=0", async () => {
    const msgs = makeMessages(3, 10, 10);
    const provider = createMockProvider([]);
    const result = await compactContext(msgs, {
      contextWindow: 1_000_000,
      provider,
    });
    expect(result.droppedTurns).toBe(0);
    expect(result.keptTurns).toBe(3);
    expect(result.summary).toBe("");
    // 顺序不变
    expect(result.messages).toEqual(msgs);
  });

  it("消息数量少：即使接近上限也不压缩（minTurns 限制）", async () => {
    // 5 个回合 + 极小窗口 → ratio 很高但回合数不足
    const msgs = makeMessages(5, 100, 100);
    const result = await compactContext(msgs, {
      contextWindow: 100,
      provider: createMockProvider([]),
    });
    expect(result.droppedTurns).toBe(0);
    expect(result.keptTurns).toBe(5);
  });

  it("保留区内全部保留：所有回合都在 preserveRecentRounds 内不压缩", async () => {
    // 6 回合、保留 6 → 0 个可压
    const msgs = makeMessages(6, 10, 10);
    const result = await compactContext(msgs, {
      contextWindow: 1_000_000,
      preserveRecentRounds: 6,
      provider: createMockProvider([]),
    });
    expect(result.droppedTurns).toBe(0);
    expect(result.keptTurns).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// compactContext — 实际压缩
// ---------------------------------------------------------------------------

describe("compactContext — 实际压缩", () => {
  it("超长历史：返回压缩后的 messages 数组，首条为 system 摘要消息", async () => {
    const msgs = makeMessages(20, 50, 50);
    const provider = createMockProvider([
      { content: "用户做了", finishReason: null },
      { content: "20 轮操作。", finishReason: "stop" },
    ]);
    const result = await compactContext(msgs, {
      contextWindow: 1_000_000,
      preserveRecentRounds: 6,
      minTurnsToCompact: 8,
      provider,
    });

    expect(result.droppedTurns).toBe(14); // 20 - 6 = 14
    expect(result.keptTurns).toBe(6);
    expect(result.messages.length).toBeGreaterThan(0);
    // 首条应是 system 角色
    expect(result.messages[0]!.role).toBe("system");
  });

  it("压缩后：summary 消息 content 包含 [history-summary] 前缀", async () => {
    const msgs = makeMessages(20, 50, 50);
    const provider = createMockProvider([
      { content: "测试摘要内容。", finishReason: "stop" },
    ]);
    const result = await compactContext(msgs, {
      contextWindow: 1_000_000,
      preserveRecentRounds: 6,
      minTurnsToCompact: 8,
      provider,
    });
    expect(result.summary).toBe("测试摘要内容。");
    expect(result.messages[0]!.content).toContain(SUMMARY_SENTINEL);
  });

  it("压缩后：保留最后 N 个回合的完整内容", async () => {
    const msgs = makeMessages(20, 50, 50);
    // 末回合的最后一条 assistant content 含 "MARKER_LAST"
    const lastIdx = msgs.length - 1;
    msgs[lastIdx] = {
      role: "assistant",
      content: "MARKER_LAST " + "A".repeat(50),
    };
    const provider = createMockProvider([
      { content: "summary", finishReason: "stop" },
    ]);
    const result = await compactContext(msgs, {
      contextWindow: 1_000_000,
      preserveRecentRounds: 6,
      minTurnsToCompact: 8,
      provider,
    });
    // 末条消息必须保留
    const lastMsg = result.messages[result.messages.length - 1]!;
    expect(lastMsg.content).toContain("MARKER_LAST");
  });

  it("压缩后：token 估算显著下降", async () => {
    const msgs = makeMessages(50, 200, 200); // 100 条消息
    const provider = createMockProvider([
      { content: "短摘要", finishReason: "stop" },
    ]);
    const result = await compactContext(msgs, {
      contextWindow: 1_000_000,
      preserveRecentRounds: 6,
      minTurnsToCompact: 8,
      provider,
    });
    expect(result.afterTokens).toBeLessThan(result.beforeTokens);
    // 至少应砍掉 80% 的 token
    expect(result.afterTokens / result.beforeTokens).toBeLessThan(0.3);
  });

  it("压缩后：保留最近回合的 tool_call + tool 配对完整", async () => {
    // 构造：10 个回合，前 4 个是普通回合，后 6 个是 tool 回合
    const plain = makeMessages(4, 10, 10);
    const toolTurns: ChatMessage[][] = [];
    for (let i = 0; i < 6; i++) {
      toolTurns.push(makeToolTurn(`用户问 ${i}`, "read_file", `文件内容 ${i}`));
    }
    const msgs: ChatMessage[] = [...plain, ...toolTurns.flat()];

    const provider = createMockProvider([
      { content: "summary", finishReason: "stop" },
    ]);
    const result = await compactContext(msgs, {
      contextWindow: 1_000_000,
      preserveRecentRounds: 6,
      minTurnsToCompact: 8,
      provider,
    });

    // 检查保留区内：每个 tool 回合的 tool_call + tool 配对都还在
    const kept = result.messages.slice(1); // 去掉首条 summary
    // 找 tool 消息，其前一条 assistant 必须有 toolCalls
    for (let i = 0; i < kept.length; i++) {
      const m = kept[i]!;
      if (m.role === "tool") {
        const prev = kept[i - 1];
        expect(prev?.role).toBe("assistant");
        expect(prev?.toolCalls?.some((tc) => tc.id === m.toolCallId)).toBe(true);
      }
    }
  });

  it("压缩后：末回合对应的 tool 配对完整（最后一个 user + tool_call + tool）", async () => {
    // 10 回合：8 个普通 + 最后 2 个回合是 tool 回合
    const plain = makeMessages(8, 10, 10);
    const lastToolTurn = makeToolTurn("最终问题", "bash", "执行成功");
    const msgs: ChatMessage[] = [...plain, ...lastToolTurn];

    const provider = createMockProvider([
      { content: "sum", finishReason: "stop" },
    ]);
    const result = await compactContext(msgs, {
      contextWindow: 1_000_000,
      preserveRecentRounds: 6,
      minTurnsToCompact: 8,
      provider,
    });

    // 验证末三条：user + assistant(toolCalls) + tool
    const last3 = result.messages.slice(-3);
    expect(last3[0]!.role).toBe("user");
    expect(last3[1]!.role).toBe("assistant");
    expect(last3[1]!.toolCalls).toBeDefined();
    expect(last3[2]!.role).toBe("tool");
    expect(last3[2]!.toolCallId).toBe("c1");
  });

  it("失败兜底：provider.chat 抛错时 compact 不抛错，summary 用 fallback", async () => {
    const msgs = makeMessages(20, 30, 30);
    const provider = createFailingProvider("网络断");
    const result = await compactContext(msgs, {
      contextWindow: 1_000_000,
      preserveRecentRounds: 6,
      minTurnsToCompact: 8,
      provider,
    });
    expect(result.droppedTurns).toBe(14);
    // summary 包含 fallback 标记
    expect(result.summary).toContain("本地摘要");
    // summary 仍可放入 messages
    expect(result.messages[0]!.role).toBe("system");
    expect(result.messages[0]!.content).toContain("本地摘要");
  });

  it("压缩后：调用 provider.chat 时传入的消息包含 system 摘要指令 + user 历史", async () => {
    let capturedMessages: ChatMessage[] = [];
    const provider = createMockProvider(
      [{ content: "ok", finishReason: "stop" }],
      "deepseek-v4-flash",
      (msgs) => {
        capturedMessages = msgs;
      },
    );
    const msgs = makeMessages(15, 30, 30);
    await compactContext(msgs, {
      contextWindow: 1_000_000,
      preserveRecentRounds: 6,
      minTurnsToCompact: 8,
      provider,
    });
    expect(capturedMessages).toHaveLength(2);
    expect(capturedMessages[0]!.role).toBe("system");
    expect(capturedMessages[1]!.role).toBe("user");
    // user content 应包含回合分隔符
    expect(capturedMessages[1]!.content).toContain("回合");
  });
});

// ---------------------------------------------------------------------------
// summarizeOldTurns
// ---------------------------------------------------------------------------

describe("summarizeOldTurns", () => {
  it("成功：返回 LLM 生成的完整字符串", async () => {
    const provider = createMockProvider([
      { content: "第一段", finishReason: null },
      { content: "第二段", finishReason: "stop" },
    ]);
    const turns: ChatMessage[][] = [
      [{ role: "user", content: "问题 1" }],
      [{ role: "user", content: "问题 2" }],
    ];
    const summary = await summarizeOldTurns(turns, {
      contextWindow: 1_000_000,
      provider,
    });
    expect(summary).toBe("第一段第二段");
  });

  it("空 turns 数组返回空串（不调 LLM）", async () => {
    let called = false;
    const provider = createMockProvider([], "deepseek-v4-flash", () => {
      called = true;
    });
    const summary = await summarizeOldTurns([], {
      contextWindow: 1_000_000,
      provider,
    });
    expect(summary).toBe("");
    expect(called).toBe(false);
  });

  it("失败：返回 fallback 摘要（包含 user 消息前 60 字）", async () => {
    const provider = createFailingProvider();
    const turns: ChatMessage[][] = [
      [{ role: "user", content: "我想重构登录模块" }],
      [{ role: "user", content: "再加一个测试" }],
    ];
    const summary = await summarizeOldTurns(turns, {
      contextWindow: 1_000_000,
      provider,
    });
    expect(summary).toContain("本地摘要");
    expect(summary).toContain("我想重构登录模块");
  });

  it("LLM 返回空字符串时 fallback", async () => {
    const provider = createMockProvider([
      { content: "  ", finishReason: "stop" },
    ]);
    const turns: ChatMessage[][] = [
      [{ role: "user", content: "重要问题" }],
    ];
    const summary = await summarizeOldTurns(turns, {
      contextWindow: 1_000_000,
      provider,
    });
    // 空字符串 + trim 为空 → fallback
    expect(summary).toContain("本地摘要");
    expect(summary).toContain("重要问题");
  });
});

// ---------------------------------------------------------------------------
// buildSummaryMessage
// ---------------------------------------------------------------------------

describe("buildSummaryMessage", () => {
  it("返回单条 system 消息，content 以 [history-summary] 开头", () => {
    const msg = buildSummaryMessage("这是摘要内容");
    expect(msg.role).toBe("system");
    expect(msg.content).toBe(`${SUMMARY_SENTINEL}\n这是摘要内容`);
  });

  it("空摘要也能正常返回", () => {
    const msg = buildSummaryMessage("");
    expect(msg.role).toBe("system");
    expect(msg.content).toBe(`${SUMMARY_SENTINEL}\n`);
  });
});

// ---------------------------------------------------------------------------
// 默认值常量校验
// ---------------------------------------------------------------------------

describe("默认常量", () => {
  it("默认值合理", () => {
    expect(DEFAULT_AUTO_COMPACT_RATIO).toBe(0.85);
    expect(DEFAULT_PRESERVE_ROUNDS).toBe(6);
    expect(DEFAULT_MIN_TURNS_TO_COMPACT).toBe(8);
  });
});
