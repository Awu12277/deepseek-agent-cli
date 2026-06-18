import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import { useEffect, useState, useCallback } from "react";

const CYBER_PALETTE = ["#00ffff", "#ff00ff", "#00ff41", "#ff1493", "#8b00ff"];

const LOGO_LINES = [
  "  ██████╗ ███████╗██╗  ██╗",
  "  ██╔══██╗██╔════╝██║ ██╔╝",
  "  ██║  ██║███████╗█████╔╝ ",
  "  ██║  ██║╚════██║██╔═██╗ ",
  "  ██████╔╝███████║██║  ██╗",
  "  ╚═════╝ ╚══════╝╚═╝  ╚═╝",
];

const COMMANDS: Record<string, { desc: string; handler: () => string }> = {
  "/exit": { desc: "退出对话", handler: () => "" },
  "/quit": { desc: "退出对话", handler: () => "" },
  "/help": {
    desc: "显示帮助信息",
    handler: () =>
      [
        "可用命令：",
        "  /exit, /quit  退出对话",
        "  /help          显示此帮助",
        "  /clear         清空对话历史",
        "  /version       显示版本信息",
      ].join("\n"),
  },
  "/clear": { desc: "清空对话历史", handler: () => "" },
  "/version": { desc: "显示版本信息", handler: () => "dsk v0.0.0" },
};

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface ChatSessionProps {
  providerCount: number;
  toolCount: number;
  verbose: boolean;
}

export function ChatSession({ providerCount, toolCount, verbose }: ChatSessionProps) {
  const [offset, setOffset] = useState(0);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");

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
      { role: "assistant", content: "dsk AI — 待实现（第07章）。当前为 CLI 框架演示模式。" },
    ]);
    setInput("");
  }, []);

  return (
    <Box flexDirection="column" paddingLeft={1} paddingRight={1}>
      {/* Logo */}
      <Box flexDirection="column">
        <Box>
          <Text color="#00ffff" dimColor>
            {"  ╔" + "═".repeat(32) + "╗"}
          </Text>
        </Box>
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
        <Box>
          <Text color="#00ffff" dimColor>
            {"  ╚" + "═".repeat(32) + "╝"}
          </Text>
        </Box>
      </Box>

      {/* Status bar */}
      <Box marginTop={1} flexDirection="column">
        <Text color="#00ff41">{"  ✔ "}已加载 {providerCount} 个 Provider</Text>
        <Text color="#00ffff">{"  ℹ "}已就绪 {toolCount} 个工具</Text>
        {verbose ? <Text color="#ff1493">{"  ⚡ Verbose"}</Text> : null}
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
    </Box>
  );
}
