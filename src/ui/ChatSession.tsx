// ---------------------------------------------------------------------------
// 交互式聊天会话组件 — 接入 Agent 主循环，实现流式对话
// ---------------------------------------------------------------------------

import { Box, Text, useInput, Static } from "ink";
import TextInput from "ink-text-input";
import { useEffect, useState, useCallback, useRef } from "react";
import { useDoubleCtrlC } from "./useDoubleCtrlC.js";
import { CYBER_PALETTE, LOGO_LINES } from "./DskcodeSplash.js";
import { Spinner } from "./Spinner.js";
import { AssistantMessage } from "./AssistantMessage.js";
import { CostTracker, formatMoney } from "../provider/cost-tracker.js";
import type { ProviderToolCall, UsageInfo, ModelId } from "../provider/index.js";
import { createProvider } from "../provider/index.js";
import { Session } from "../agent/index.js";
import type { AgentEvent } from "../agent/types.js";

/** 命令处理结果的类型，支持文本响应和动作跳转 */
export type CommandAction =
  | { kind: "text"; content: string }
  | { kind: "exit" }
  | { kind: "clear" }
  | { kind: "navigate"; target: "game" | "stock" };

export interface ChatCommand {
  desc: string;
  handler: () => CommandAction;
}

/** 命令注册表，支持动态注册新命令 */
const commandRegistry = new Map<string, ChatCommand>();

/** 注册一个命令 */
export function registerCommand(name: string, cmd: ChatCommand): void {
  commandRegistry.set(name, cmd);
}

/** 获取所有已注册命令（用于 /help 生成帮助文本） */
function getRegisteredCommands(): Map<string, ChatCommand> {
  return commandRegistry;
}

// 注册内置命令
registerCommand("/exit", { desc: "退出对话", handler: () => ({ kind: "exit" }) });
registerCommand("/quit", { desc: "退出对话", handler: () => ({ kind: "exit" }) });
registerCommand("/help", {
  desc: "显示帮助信息",
  handler: () => {
    const commands = getRegisteredCommands();
    const lines = ["可用命令："];
    for (const [name, cmd] of commands) {
      lines.push(`  ${name.padEnd(16)}${cmd.desc}`);
    }
    return { kind: "text", content: lines.join("\n") };
  },
});
registerCommand("/clear", { desc: "清空对话历史", handler: () => ({ kind: "clear" }) });
registerCommand("/version", { desc: "显示版本信息", handler: () => ({ kind: "text", content: "dskcode v0.1.10" }) });
registerCommand("/game", { desc: "启动游戏", handler: () => ({ kind: "navigate", target: "game" }) });
registerCommand("/stock", { desc: "查看股票行情", handler: () => ({ kind: "navigate", target: "stock" }) });

/** 流式输出时，输入框随机展示的占位符列表 */
const STREAMING_PLACEHOLDERS = [
  "让子弹飞一会儿...",
  "马上就好...",
  "正在憋大招...",
  "稍等一下下~",
  "码字中...",
  "脑子转得飞快...",
];

/** 空闲时输入框随机展示的占位符列表 */
const IDLE_PLACEHOLDERS = [
  "想干啥？直接说~",
  "来吧，吩咐点啥",
  "随时待命...",
  "戳这里开聊 👇",
  "等你开口...",
  "尽管使唤~",
];

function pickRandom<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

/** 单条已完成的助手消息 */
interface CompletedAssistant {
  content: string;
  toolCalls?: ProviderToolCall[];
  usage?: UsageInfo;
  elapsed?: number;
  cost?: number;
  model?: string;
}

/** 单条显示消息 */
interface DisplayMessage {
  role: "user" | "assistant";
  content: string;
  /** 已完成的助手消息详情（仅在 role=assistant 时） */
  assistantDetail?: CompletedAssistant;
}

interface ChatSessionProps {
  providerCount: number;
  toolCount: number;
  verbose: boolean;
  apiKey?: string;
  baseUrl?: string;
  costTracker?: CostTracker;
  model?: string;
  onLaunchGame?: () => void;
  onLaunchStock?: () => void;
}

export function ChatSession({
  providerCount,
  toolCount,
  verbose,
  apiKey,
  baseUrl,
  costTracker: externalCostTracker,
  model = "deepseek-v4-flash",
  onLaunchGame,
  onLaunchStock,
}: ChatSessionProps) {
  const [offset, setOffset] = useState(0);
  const [displayMessages, setDisplayMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState("");
  const [balance, setBalance] = useState<number | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [todayCost, setTodayCost] = useState<number | null>(null);

  // 流式状态
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingPlaceholder, setStreamingPlaceholder] = useState("");
  const [idlePlaceholder, setIdlePlaceholder] = useState(() => pickRandom(IDLE_PLACEHOLDERS));
  const [currentContent, setCurrentContent] = useState("");
  const [currentToolCalls, setCurrentToolCalls] = useState<ProviderToolCall[]>([]);
  const [currentUsage, setCurrentUsage] = useState<UsageInfo | undefined>(undefined);
  const [currentElapsed, setCurrentElapsed] = useState<number | undefined>(undefined);
  const [currentCost, setCurrentCost] = useState<number | undefined>(undefined);
  const [currentModel, setCurrentModel] = useState<string | undefined>(undefined);
  const [streamError, setStreamError] = useState<string | undefined>(undefined);

  // Session 引用（保持跨渲染稳定）
  const sessionRef = useRef<Session | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // 用 ref 跟踪流式内容的最新值，以便 finally 块能获取非闭包过期的值
  const currentContentRef = useRef("");
  const currentToolCallsRef = useRef<ProviderToolCall[]>([]);
  const currentUsageRef = useRef<UsageInfo | undefined>(undefined);
  const currentElapsedRef = useRef<number | undefined>(undefined);
  const currentCostRef = useRef<number | undefined>(undefined);
  const currentModelRef = useRef<string | undefined>(undefined);
  const streamErrorRef = useRef<string | undefined>(undefined);

  const { doubleCtrlC, handleCtrlC } = useDoubleCtrlC(() => {
    // 双击 Ctrl+C 退出进程
    process.exit(0);
  });

  // 捕获 Ctrl+C
  useInput(
    useCallback(
      (_input, key) => {
        if (key.ctrl && _input === "c") {
          if (isStreaming) {
            // 流式输出中，取消当前请求
            abortRef.current?.abort();
          } else {
            handleCtrlC();
          }
        }
      },
      [isStreaming, handleCtrlC],
    ),
  );

  // Logo 色彩动画
  useEffect(() => {
    const timer = setInterval(() => {
      setOffset((prev) => (prev + 1) % CYBER_PALETTE.length);
    }, 500);
    return () => clearInterval(timer);
  }, []);

  // 初始化 Session
  useEffect(() => {
    if (!apiKey || !baseUrl) return;

    const provider = createProvider({
      name: "deepseek",
      apiKey,
      baseUrl,
      model,
    });

    const tracker = externalCostTracker ?? new CostTracker();
    const session = new Session(provider, [], tracker, {
      cwd: process.cwd(),
    });
    sessionRef.current = session;

    return () => {
      sessionRef.current = null;
    };
  }, [apiKey, baseUrl, model, externalCostTracker]);

  // 查询余额
  useEffect(() => {
    if (!apiKey || !baseUrl) return;
    let cancelled = false;
    setBalanceLoading(true);
    import("../provider/deepseek.js").then(({ DeepSeekProvider }) => {
      const provider = new DeepSeekProvider({
        apiKey,
        baseUrl,
        model: "deepseek-v4-flash",
      });
      return provider.getBalance();
    }).then((result) => {
      if (cancelled) return;
      const cny = result.balances.find((b) => b.currency === "CNY");
      if (cny) {
        setBalance(cny.totalBalance);
      }
    }).catch(() => {
      // 查询失败静默处理，不影响主流程
    }).finally(() => {
      if (!cancelled) setBalanceLoading(false);
    });
    return () => { cancelled = true; };
  }, [apiKey, baseUrl]);

  // 加载今日消耗历史数据，并定时刷新
  useEffect(() => {
    if (!externalCostTracker) return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    const refresh = () => {
      setTodayCost(externalCostTracker.todayTotalCost);
    };

    externalCostTracker.load().then(() => {
      if (cancelled) return;
      refresh();
      timer = setInterval(refresh, 5000);
    }).catch(() => {
      // 加载失败静默处理
    });

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [externalCostTracker]);

  /** 处理用户输入 */
  const handleSubmit = useCallback(async (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;

    // 处理斜杠命令
    if (trimmed.startsWith("/")) {
      const cmd = commandRegistry.get(trimmed.toLowerCase());
      if (cmd) {
        const result = cmd.handler();

        switch (result.kind) {
          case "exit":
            process.exit(0);
            return;
          case "clear":
            setDisplayMessages([]);
            setInput("");
            // 重置 Session 历史
            sessionRef.current?.reset();
            return;
          case "navigate":
            setInput("");
            if (result.target === "game") {
              onLaunchGame?.();
            } else if (result.target === "stock") {
              onLaunchStock?.();
            }
            return;
          case "text":
            setDisplayMessages((prev) => [
              ...prev,
              { role: "user", content: trimmed },
              { role: "assistant", content: result.content },
            ]);
            setInput("");
            return;
        }
      }
      setDisplayMessages((prev) => [
        ...prev,
        { role: "user", content: trimmed },
        { role: "assistant", content: `未知命令：${trimmed}。输入 /help 查看。` },
      ]);
      setInput("");
      return;
    }

    // 检查 Session 是否就绪
    if (!sessionRef.current) {
      setDisplayMessages((prev) => [
        ...prev,
        { role: "user", content: trimmed },
        { role: "assistant", content: "⚠ 无法连接到 Provider。请检查 API Key 和网络配置。" },
      ]);
      setInput("");
      return;
    }

    // ---- 正常对话：接入 Agent 流式主循环 ----

    // 追加用户消息到显示列表
    setDisplayMessages((prev) => [
      ...prev,
      { role: "user", content: trimmed },
    ]);

    // 进入流式状态
    setInput("");
    // 重置流式状态
    setIsStreaming(true);
    setStreamingPlaceholder(pickRandom(STREAMING_PLACEHOLDERS));
    setCurrentContent("");
    setCurrentToolCalls([]);
    setCurrentUsage(undefined);
    setCurrentElapsed(undefined);
    setCurrentCost(undefined);
    setCurrentModel(undefined);
    setStreamError(undefined);
    // 同步重置 ref
    currentContentRef.current = "";
    currentToolCallsRef.current = [];
    currentUsageRef.current = undefined;
    currentElapsedRef.current = undefined;
    currentCostRef.current = undefined;
    currentModelRef.current = undefined;
    streamErrorRef.current = undefined;

    const session = sessionRef.current;
    const abortController = new AbortController();
    abortRef.current = abortController;

    try {
      for await (const event of session!.chat(trimmed)) {
        // 如果请求被取消，跳过后续事件
        if (abortController.signal.aborted) break;

        switch (event.type) {
          case "text_delta":
            setCurrentContent((prev) => {
              const next = prev + event.content;
              currentContentRef.current = next;
              return next;
            });
            break;

          case "tool_calls":
            setCurrentToolCalls((prev) => {
              const next = [...prev, ...event.calls];
              currentToolCallsRef.current = next;
              return next;
            });
            break;

          case "usage":
            setCurrentUsage(event.usage);
            setCurrentModel(event.model);
            currentUsageRef.current = event.usage;
            currentModelRef.current = event.model;
            // 使用量来自最后一个事件，费率已知后可同步计算
            break;

          case "done":
            setCurrentElapsed(event.elapsed);
            currentElapsedRef.current = event.elapsed;
            break;

          case "error":
            setStreamError(event.error.message);
            streamErrorRef.current = event.error.message;
            break;
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setStreamError(msg);
      streamErrorRef.current = msg;
    } finally {
      setIsStreaming(false);
      setIdlePlaceholder(pickRandom(IDLE_PLACEHOLDERS));
      abortRef.current = null;

      // 流式结束后，用 ref 拿到最新值，直接追加完成的助手消息
      const finContent = currentContentRef.current;
      const finToolCalls = currentToolCallsRef.current.length > 0 ? currentToolCallsRef.current : undefined;
      const finStreamError = streamErrorRef.current;

      if (finContent || finToolCalls || finStreamError) {
        const completed: CompletedAssistant = {
          content: finStreamError ? `⚠ 请求出错：${finStreamError}` : (finContent || ""),
          toolCalls: finToolCalls,
          usage: currentUsageRef.current,
          elapsed: currentElapsedRef.current,
          cost: currentCostRef.current,
          model: currentModelRef.current,
        };
        setDisplayMessages((prev) => [
          ...prev,
          {
            role: "assistant" as const,
            content: completed.content,
            assistantDetail: completed,
          },
        ]);
      }
    }
  }, [onLaunchGame, onLaunchStock, currentContent, currentToolCalls]);

  // 从 costTracker 更新今日消耗（每次流式结束后刷新）
  useEffect(() => {
    if (!isStreaming && externalCostTracker) {
      setTodayCost(externalCostTracker.todayTotalCost);
    }
  }, [isStreaming, externalCostTracker]);

  // 从 usage 计算 cost（需要在 usage + model 都就绪后）
  useEffect(() => {
    if (currentUsage && currentModel && !currentCost) {
      // import calculateCost dynamically
      import("../provider/models.js").then(({ calculateCost }) => {
        const cost = calculateCost(currentUsage, currentModel as ModelId);
        setCurrentCost(cost.totalCost);
        currentCostRef.current = cost.totalCost;
      });
    }
  }, [currentUsage, currentModel, currentCost]);

  return (
    <Box flexDirection="column" paddingLeft={1} paddingRight={1}>
      {/* Logo + 状态栏 + 余额 — 三栏布局 */}
      <Box flexDirection="row" marginBottom={1}>
        {/* Logo */}
        <Box flexDirection="column" marginRight={4}>
          {LOGO_LINES.map((line, i) => {
            const colorIndex = (i + offset) % CYBER_PALETTE.length;
            return (
              <Box key={i}>
                <Text bold color={CYBER_PALETTE[colorIndex]}>
                  {line}
                </Text>
              </Box>
            );
          })}
        </Box>

        {/* 状态信息 */}
        <Box flexDirection="column" justifyContent="center">
          <Text color="#00ff41">{"  ✔ "}已加载 {providerCount} 个 Provider</Text>
          <Text color="#00ffff">{"  ℹ "}已就绪 {toolCount} 个工具</Text>
          <Text color="#00ffff">{"  🔧 模型 "}{model}</Text>
          {verbose ? <Text color="#ff1493">{"  ⚡ Verbose"}</Text> : null}
        </Box>

        {/* 右侧余额 + 今日消耗 */}
        <Box flexGrow={1} flexDirection="column" justifyContent="center" alignItems="flex-end">
          {balanceLoading && balance === null ? (
            <Text color="yellow">{"  ⏳ 查询余额..."}</Text>
          ) : balance !== null ? (
            <Box flexDirection="row">
              <Text color="yellow">{"💰 "}</Text>
              <Text color="yellow">{"余额 ¥"}{balance.toFixed(2)}</Text>
            </Box>
          ) : null}
          {todayCost !== null ? (
            <Box flexDirection="row">
              <Text color="cyan">{"📊 "}</Text>
              <Text color="cyan">{"今日 ¥"}{formatMoney(todayCost).replace("¥", "")}</Text>
            </Box>
          ) : null}
        </Box>
      </Box>

      {/* 消息列表 - 已完成的消息用 Static 固定，避免重绘时丢失滚动位置 */}
      <Box flexDirection="column" marginTop={1}>
        <Static items={displayMessages}>
          {(msg, i) => {
            if (msg.role === "user") {
              return (
                <Box key={i} marginTop={1}>
                  <Box width={4} flexShrink={0}>
                    <Text bold color="#00ff41">{"👤"}</Text>
                  </Box>
                  <Box flexGrow={1}>
                    <Text wrap="wrap">{msg.content}</Text>
                  </Box>
                </Box>
              );
            }

            // 已完成的助手消息
            const detail = msg.assistantDetail;
            return (
              <AssistantMessage
                key={i}
                content={msg.content}
                toolCalls={detail?.toolCalls}
                isStreaming={false}
                usage={detail?.usage}
                elapsed={detail?.elapsed}
                cost={detail?.cost}
                model={detail?.model}
              />
            );
          }}
        </Static>

        {/* 正在流式输出的助手消息 */}
        {isStreaming && (
          <AssistantMessage
            content={currentContent}
            toolCalls={currentToolCalls.length > 0 ? currentToolCalls : undefined}
            isStreaming={true}
          />
        )}

        {/* 思考中 Spinner */}
        {isStreaming && !currentContent && currentToolCalls.length === 0 && (
          <Box marginTop={1} marginLeft={4}>
            <Spinner type="dots" label="思考中..." />
          </Box>
        )}

        {/* 错误信息（流式结束后显示） */}
        {!isStreaming && streamError && (
          <Box marginTop={1} marginLeft={3}>
            <Text color="red">⚠ {streamError}</Text>
          </Box>
        )}
      </Box>

      {/* 输入区 */}
      <Box marginTop={1}>
        <Box width={4} flexShrink={0}>
          <Text bold color="#00ff41">
            {"⚡"}
          </Text>
        </Box>
        <Box flexGrow={1}>
          <TextInput
            value={input}
            onChange={setInput}
            onSubmit={handleSubmit}
            placeholder={isStreaming ? streamingPlaceholder : idlePlaceholder}
          />
        </Box>
      </Box>

      <Box marginTop={1}>
        <Text color="#00ffff" dimColor>
          {"  " + "─".repeat(36)}
        </Text>
      </Box>

      {/* 双击 Ctrl+C 退出提示 */}
      {doubleCtrlC && !isStreaming && (
        <Box marginTop={1}>
          <Text color="#ff1493" bold>
            {"  ⚠ 再按一次 Ctrl+C 退出 dskcode"}
          </Text>
        </Box>
      )}

      {/* 流式中 Ctrl+C 取消提示 */}
      {isStreaming && (
        <Box marginTop={1}>
          <Text color="yellow" dimColor>
            {"  提示：按 Ctrl+C 取消当前请求"}
          </Text>
        </Box>
      )}
    </Box>
  );
}