// ---------------------------------------------------------------------------
// 动画 DeepSeek Logo — 从右向左循环滚动
// 进入时右侧逐渐显现，离开时左侧逐渐裁剪
// ---------------------------------------------------------------------------

import { Box, Text } from "ink";
import { useEffect, useRef, useState } from "react";

const LOGO_LINES = [
  "  ▄▄▄▄▄▄▄█    █▄   ▄▄",
  " ▄███████████▄▄▀███▀▀",
  "▀█     ▀▀███▄ ████",
  " ▀█▄    ▄ ▀█████▀",
  "   ▀▀▀█████▄▀▀▀▀▀",
];

const LOGO_WIDTH = 22;
const MOVE_INTERVAL_MS = 120;
const LOGO_COLOR = "#6185f6";

interface AnimatedLogoProps {
  /** 所在面板的可用宽度（字符数） */
  panelWidth: number;
}

export function AnimatedLogo({ panelWidth }: AnimatedLogoProps) {
  // pos 表示 Logo 左边缘距面板左边缘的偏移量
  // panelWidth = 刚好完全在右侧不可见
  const posRef = useRef(panelWidth);
  const [renderTick, setRenderTick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      posRef.current -= 1; // 一直向左移动

      // 完全移出左侧后，重置到右侧重新穿入
      if (posRef.current <= -LOGO_WIDTH) {
        posRef.current = panelWidth;
      }

      setRenderTick((t) => t + 1);
    }, MOVE_INTERVAL_MS);

    return () => clearInterval(timer);
  }, [panelWidth]);

  const pos = posRef.current;

  // 完全在右侧不可见 → 跳过渲染
  if (pos >= panelWidth) return null;

  // 左侧裁剪：负偏移时裁掉左侧字符
  const leftClip = Math.max(0, -pos);

  // 右侧裁剪：仅保留面板宽度内的部分
  const rightClip = Math.max(0, pos + LOGO_WIDTH - panelWidth);

  // 左侧空格：正偏移时留空定位
  const padding = Math.max(0, pos);

  return (
    <Box flexDirection="column" alignItems="flex-start">
      {LOGO_LINES.map((line, i) => (
        <Text key={i} color={LOGO_COLOR} bold>
          {" ".repeat(padding)}
          {line.slice(leftClip, LOGO_WIDTH - rightClip)}
        </Text>
      ))}
    </Box>
  );
}
