import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { useEffect, useState, useCallback } from "react";
import { useDoubleCtrlC } from "./useDoubleCtrlC.js";

const CYBER_PALETTE = ["#00ffff", "#ff00ff", "#00ff41", "#ff1493", "#8b00ff"];

const LOGO_LINES = [
  "  ██████╗ ███████╗██╗  ██╗",
  "  ██╔══██╗██╔════╝██║ ██╔╝",
  "  ██║  ██║███████╗█████╔╝ ",
  "  ██║  ██║╚════██║██╔═██╗ ",
  "  ██████╔╝███████║██║  ██╗",
  "  ╚═════╝ ╚══════╝╚═╝  ╚═╝",
];

const COMMANDS: Record<string, { desc: string; handler: () => string | null }> = {
  "/exit": { desc: "退出对话", handler: () => null },
  "/quit": { desc: "退出对话", handler: () => null },
  "/help": {
    desc: "显示帮助信息",
    handler: () =>
      [
        "可用命令：",
        "  /exit, /quit  退出对话",
        "  /help          显示此帮助",
        "  /clear         清空对话历史",
        "  /version       显示版本信息",
        "  /game          启动内置小游戏",
        "  /stock         查看股票行情",
      ].join("\n"),
  },
  "/clear": { desc: "清空对话历史", handler: () => "" },
  "/version": { desc: "显示版本信息", handler: () => "dskcode v0.0.0" },
  "/game": { desc: "启动游戏", handler: () => "__LAUNCH_GAME__" },
  "/stock": { desc: "查看股票行情", handler: () => "__LAUNCH_STOCK__" },
};

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface ChatSessionProps {
  providerCount: number;
  toolCount: number;
  verbose: boolean;
  onLaunchGame?: () => void;
  onLaunchStock?: () => void;
}

export function ChatSession({ providerCount, toolCount, verbose, onLaunchGame, onLaunchStock }: ChatSessionProps) {
  const [offset, setOffset] = useState(0);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");

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

  useEffect(() => {
    const timer = setInterval(() => {
      setOffset((prev) => (prev + 1) % CYBER_PALETTE.length);
    }, 500);
    return () => clearInterval(timer);
  }, []);

  const handleSubmit = useCallback((value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;

    if (trimmed.startsWith("/")) {
      const cmd = COMMANDS[trimmed.toLowerCase()];
      if (cmd) {
        if (trimmed.toLowerCase() === "/exit" || trimmed.toLowerCase() === "/quit") {
          process.exit(0);
          return;
        }
        if (trimmed.toLowerCase() === "/clear") {
          setMessages([]);
          setInput("");
          return;
        }

        const result = cmd.handler();

        // 特殊命令：跳转到游戏/股票
        if (result === "__LAUNCH_GAME__") {
          setInput("");
          onLaunchGame?.();
          return;
        }
        if (result === "__LAUNCH_STOCK__") {
          setInput("");
          onLaunchStock?.();
          return;
        }

        if (result) {
          setMessages((prev) => [
            ...prev,
            { role: "user", content: trimmed },
            { role: "assistant", content: result },
          ]);
        }
        setInput("");
        return;
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
  }, []);

  return (
    <Box flexDirection="column" paddingLeft={1} paddingRight={1}>
      {/* Logo + 状态栏 — 左右布局 */}
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
