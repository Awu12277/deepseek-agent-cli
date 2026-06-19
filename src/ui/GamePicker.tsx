import { Box, Text, useInput } from "ink";
import { useState, useCallback } from "react";
import type { Game } from "../game/index.js";
import { useDoubleCtrlC } from "../ui/useDoubleCtrlC.js";

interface GamePickerProps {
  games: Game[];
  onSelect: (game: Game) => void;
  onExit?: () => void;
  onBackToChat?: () => void;
}

export function GamePicker({ games, onSelect, onExit, onBackToChat }: GamePickerProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  const exitAction = onBackToChat ?? onExit ?? (() => process.exit(0));
  const { doubleCtrlC, handleCtrlC } = useDoubleCtrlC(exitAction);

  useInput(
    useCallback(
      (input, key) => {
        // Ctrl+C：双击退出
        if (input === "c" && key.ctrl) {
          handleCtrlC();
          return;
        }

        if (games.length === 0) return;
        if (key.upArrow || input === "k") {
          setSelectedIndex((prev) => (prev > 0 ? prev - 1 : games.length - 1));
        } else if (key.downArrow || input === "j") {
          setSelectedIndex((prev) => (prev < games.length - 1 ? prev + 1 : 0));
        } else if (key.return) {
          const game = games[selectedIndex];
          if (game) onSelect(game);
        } else if (key.escape || input === "q") {
          if (onBackToChat) onBackToChat();
          else onExit?.();
        }
      },
      [games, selectedIndex, onSelect, onExit, onBackToChat, handleCtrlC],
    ),
  );

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="#00ffff">
          🎮 游戏列表
        </Text>
      </Box>

      <Box flexDirection="column">
        {games.map((game, index) => {
          const isSelected = index === selectedIndex;
          return (
            <Box key={game.id} flexDirection="row">
              <Box width={3} flexShrink={0}>
                {isSelected ? (
                  <Text bold color="#00ff41">
                    {"▸ "}
                  </Text>
                ) : (
                  <Text>{"  "}</Text>
                )}
              </Box>
              <Box width={20} flexShrink={0}>
                <Text bold color={isSelected ? "#00ff41" : "#ffffff"}>
                  {game.name}
                </Text>
              </Box>
              <Box>
                <Text color="#888888">{game.description}</Text>
              </Box>
            </Box>
          );
        })}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>
          {"  ↑/↓ 选择  Enter 启动  q 返回"}
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
