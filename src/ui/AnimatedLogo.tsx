// ---------------------------------------------------------------------------
// 动画 DeepSeek Logo — 在面板内左右往返移动，触壁翻转
// ---------------------------------------------------------------------------

import { Box, Text } from "ink";
import { useEffect, useRef, useState } from "react";

/** 朝左移动时使用 */
const LOGO_RIGHT = [
  "  ▄▄▄▄▄▄▄█    █▄   ▄▄",
  " ▄███████████▄▄▀███▀▀",
  "▀█     ▀▀███▄ ████",
  " ▀█▄    ▄ ▀█████▀",
  "   ▀▀▀█████▄▀▀▀▀▀",
];

/** 朝右移动时使用 */
const LOGO_LEFT = [
  "▄▄   ▄█    █▄▄▄▄▄▄▄  ",
  "▀▀███▀▄▄███████████▄ ",
  "████ ▄███▀▀     █▀",
  "▀█████▀ ▄    ▄█▀ ",
  "▀▀▀▀▀▄█████▀▀▀   ",
];

const LOGO_WIDTH = 22; // 字符最大宽度
const MOVE_INTERVAL_MS = 120;
const LOGO_COLOR = "#6185f6";

interface AnimatedLogoProps {
  /** 所在面板的可用宽度（字符数） */
  panelWidth: number;
}

export function AnimatedLogo({ panelWidth }: AnimatedLogoProps) {
  const maxOffset = Math.max(0, panelWidth - LOGO_WIDTH);

  // 用 ref 存实时位置和方向，避免闭包过期问题
  const posRef = useRef(maxOffset); // 初始在最右侧
  const dirRef = useRef(-1); // -1 → 向左移动

  const [renderTick, setRenderTick] = useState(0);

  useEffect(() => {
    if (maxOffset <= 0) return;

    const timer = setInterval(() => {
      posRef.current += dirRef.current;

      if (posRef.current <= 0) {
        posRef.current = 0;
        dirRef.current = 1; // 触左壁 → 向右
      } else if (posRef.current >= maxOffset) {
        posRef.current = maxOffset;
        dirRef.current = -1; // 触右壁 → 向左
      }

      setRenderTick((t) => t + 1);
    }, MOVE_INTERVAL_MS);

    return () => clearInterval(timer);
  }, [maxOffset]);

  // Logo 朝向移动方向
  const movingLeft = dirRef.current === -1;
  const logoLines = movingLeft ? LOGO_RIGHT : LOGO_LEFT;
  const indent = posRef.current;

  return (
    <Box flexDirection="column" alignItems="flex-start">
      {logoLines.map((line, i) => (
        <Text key={i} color={LOGO_COLOR} bold>
          {" ".repeat(indent)}
          {line}
        </Text>
      ))}
    </Box>
  );
}
