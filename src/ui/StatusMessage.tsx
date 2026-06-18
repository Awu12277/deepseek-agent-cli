import { Box, Text } from "ink";

type MessageType = "info" | "success" | "warning" | "error";

interface StatusMessageProps {
  type?: MessageType;
  label: string;
  detail?: string;
}

const STYLES: Record<MessageType, { color: string; icon: string }> = {
  info: { color: "cyan", icon: "ℹ" },
  success: { color: "green", icon: "✔" },
  warning: { color: "yellow", icon: "⚠" },
  error: { color: "red", icon: "✖" },
};

export function StatusMessage({ type = "info", label, detail }: StatusMessageProps) {
  const { color, icon } = STYLES[type];
  return (
    <Box>
      <Text color={color}>
        {icon} {label}
      </Text>
      {detail ? <Text dimColor>: {detail}</Text> : null}
    </Box>
  );
}
