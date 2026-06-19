import { Box, Text } from "ink";
import { useEffect, useState } from "react";

/** 赛博朋克调色板 — 多处组件复用 */
export const CYBER_PALETTE = ["#00ffff", "#ff00ff", "#00ff41", "#ff1493", "#8b00ff"] as const;

/** ASCII LOGO 行 — 多处组件复用 */
export const LOGO_LINES = [
  "  ██████╗ ███████╗██╗  ██╗",
  "  ██╔══██╗██╔════╝██║ ██╔╝",
  "  ██║  ██║███████╗█████╔╝ ",
  "  ██║  ██║╚════██║██╔═██╗ ",
  "  ██████╔╝███████║██║  ██╗",
  "  ╚═════╝ ╚══════╝╚═╝  ╚═╝",
] as const;

export function DskcodeSplash() {
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setOffset((prev) => (prev + 1) % CYBER_PALETTE.length);
    }, 500);
    return () => clearInterval(timer);
  }, []);

  return (
    <Box flexDirection="column" paddingLeft={1}>
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
  );
}
