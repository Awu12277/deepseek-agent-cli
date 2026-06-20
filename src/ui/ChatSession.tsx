import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { useEffect, useState, useCallback } from "react";
import { useDoubleCtrlC } from "./useDoubleCtrlC.js";
import { CYBER_PALETTE, LOGO_LINES } from "./DskcodeSplash.js";

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
registerCommand("/version", { desc: "显示版本信息", handler: () => ({ kind: "text", content: "dskcode v0.0.0" }) });
registerCommand("/game", { desc: "启动游戏", handler: () => ({ kind: "navigate", target: "game" }) });
registerCommand("/stock", { desc: "查看股票行情", handler: () => ({ kind: "navigate", target: "stock" }) });

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface ChatSessionProps {
  providerCount: number;
  toolCount: number;
  verbose: boolean;
  apiKey?: string;
  baseUrl?: string;
  onLaunchGame?: () => void;
  onLaunchStock?: () => void;
}

export function ChatSession({ providerCount, toolCount, verbose, apiKey, baseUrl, onLaunchGame, onLaunchStock }: ChatSessionProps) {
  const [offset, setOffset] = useState(0);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [balance, setBalance] = useState<number | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);

  const { doubleCtrlC, handleCtrlC } = useDoubleCtrlC(() => process.exit(0));

  // 捕获 Ctrl+C，启用"双击退出"交互
  useInput(
    useCallback(
      (input, key) => {
        if (input === "c" && key.ctrl) {
          handleCtrlC();
        }
      },
      [handleCtrlC],
    ),
  );

  // Logo 色彩动画
  useEffect(() => {
    const timer = setInterval(() => {
      setOffset((prev) => (prev + 1) % CYBER_PALETTE.length);
    }, 500);
    return () => clearInterval(timer);
  }, []);

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

  const handleSubmit = useCallback((value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;

    if (trimmed.startsWith("/")) {
      const cmd = commandRegistry.get(trimmed.toLowerCase());
      if (cmd) {
        const result = cmd.handler();

        switch (result.kind) {
          case "exit":
            process.exit(0);
            return;
          case "clear":
            setMessages([]);
            setInput("");
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
            setMessages((prev) => [
              ...prev,
              { role: "user", content: trimmed },
              { role: "assistant", content: result.content },
            ]);
            setInput("");
            return;
        }
      }
      setMessages((prev) => [
        ...prev,
        { role: "user", content: trimmed },
        { role: "assistant", content: `未知命令：${trimmed}。输入 /help 查看。` },
      ]);
      setInput("");
      return;
    }

    setMessages((prev) => [
      ...prev,
      { role: "user", content: trimmed },
      { role: "assistant", content: "dskcode AI — 待实现（第07章）。当前为 CLI 框架演示模式。" },
    ]);
    setInput("");
  }, [onLaunchGame, onLaunchStock]);

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
          {verbose ? <Text color="#ff1493">{"  ⚡ Verbose"}</Text> : null}
        </Box>

        {/* 右侧余额 — 弹性占位推右 */}
        <Box flexGrow={1} flexDirection="column" alignItems="flex-end" justifyContent="center">
          {balanceLoading && balance === null ? (
            <Text color="yellow">{"  ⏳ 查询余额..."}</Text>
          ) : balance !== null ? (
            <Text color="yellow">{"💰 ¥"}{balance.toFixed(2)}</Text>
          ) : null}
        </Box>
      </Box>

      {/* Messages */}
      <Box flexDirection="column" marginTop={1}>
        {messages.map((msg, i) => (
          <Box key={i} marginTop={1}>
            <Box width={8} flexShrink={0}>
              <Text bold color={msg.role === "user" ? "#00ff41" : "#ff00ff"}>
                {msg.role === "user" ? "  👤" : "  🤖"}
              </Text>
            </Box>
            <Box flexGrow={1}>
              <Text wrap="wrap">{msg.content}</Text>
            </Box>
          </Box>
        ))}
      </Box>

      {/* Input */}
      <Box marginTop={1}>
        <Box width={8} flexShrink={0}>
          <Text bold color="#00ff41">
            {"  ⚡"}
          </Text>
        </Box>
        <Box flexGrow={1}>
          <TextInput
            value={input}
            onChange={setInput}
            onSubmit={handleSubmit}
            placeholder="输入你的问题..."
          />
        </Box>
      </Box>

      <Box marginTop={1}>
        <Text color="#00ffff" dimColor>
          {"  " + "─".repeat(36)}
        </Text>
      </Box>

      {/* 双击 Ctrl+C 退出提示 */}
      {doubleCtrlC && (
        <Box marginTop={1}>
          <Text color="#ff1493" bold>
            {"  ⚠ 再按一次 Ctrl+C 退出 dskcode"}
          </Text>
        </Box>
      )}
    </Box>
  );
}
