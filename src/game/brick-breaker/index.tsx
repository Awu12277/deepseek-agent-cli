import { Box, Text, useInput, render } from "ink";
import { useState, useEffect, useRef, useCallback } from "react";

const GAME_WIDTH = 40;
const GAME_HEIGHT = 18;
const PADDLE_WIDTH = 9;
const BRICK_COLORS = [166, 214, 76, 69];

interface Vec2 {
  x: number;
  y: number;
}

interface Brick {
  x: number;
  y: number;
  w: number;
  alive: boolean;
}

// ─── 10 个关卡定义 ──────────────────────────────────────────────

interface LevelDef {
  rows: number;
  cols: number;
  bw: number; // 砖块宽度（格数）
  desc: string;
  // 返回 true 表示该位置有砖块
  pattern: (col: number, row: number, rows: number, cols: number) => boolean;
}

const LEVELS: LevelDef[] = [
  { rows: 4, cols: 8, bw: 3, desc: "经典 4×8",       pattern: () => true },
  { rows: 3, cols: 8, bw: 3, desc: "轻松 3 层",       pattern: () => true },
  { rows: 6, cols: 8, bw: 3, desc: "厚墙 6 层",       pattern: () => true },
  { rows: 4, cols: 8, bw: 3, desc: "棋盘格",           pattern: (c, r) => (c + r) % 2 === 0 },
  { rows: 4, cols: 8, bw: 3, desc: "金字塔",           pattern: (c, r, _, tc) => c >= r && c < tc - r },
  { rows: 4, cols: 8, bw: 3, desc: "交错排列",         pattern: (c, r) => r % 2 === 0 || (c >= 1 && c <= 6) },
  { rows: 4, cols: 8, bw: 3, desc: "中空边框",         pattern: (c, r, tr, tc) => r === 0 || r === tr - 1 || c === 0 || c === tc - 1 },
  { rows: 4, cols: 10, bw: 2, desc: "密集 10 列",      pattern: () => true },
  { rows: 7, cols: 8, bw: 3, desc: "高墙 7 层",       pattern: () => true },
  { rows: 8, cols: 8, bw: 3, desc: "满屏 8 层",       pattern: () => true },
];

function getLevel(level: number): LevelDef {
  return LEVELS[(level - 1) % LEVELS.length]!;
}

function createBricks(level: number): Brick[] {
  const def = getLevel(level);
  const bricks: Brick[] = [];
  const gap = 2;
  const totalW = def.cols * def.bw + (def.cols - 1) * gap;
  const startX = Math.floor((GAME_WIDTH - totalW) / 2);
  const step = def.bw + gap;

  for (let row = 0; row < def.rows; row++) {
    for (let col = 0; col < def.cols; col++) {
      if (def.pattern(col, row, def.rows, def.cols)) {
        bricks.push({
          x: startX + col * step,
          y: 2 + row * 2,
          w: def.bw,
          alive: true,
        });
      }
    }
  }
  return bricks;
}

// ─── 游戏状态 ──────────────────────────────────────────────────

interface GameState {
  level: number;
  bricks: Brick[];
  paddleX: number;
  ball: Vec2;
  ballDir: Vec2;
  score: number;
  lives: number;
  gameOver: boolean;
  win: boolean;
  paused: boolean;
}

function createInitialState(level: number): GameState {
  const def = getLevel(level);
  const totalW = def.cols * def.bw + (def.cols - 1) * 2;
  const _startX = Math.floor((GAME_WIDTH - totalW) / 2);
  return {
    level,
    bricks: createBricks(level),
    paddleX: Math.floor(GAME_WIDTH / 2) - Math.floor(PADDLE_WIDTH / 2),
    ball: { x: GAME_WIDTH / 2, y: GAME_HEIGHT - 3 },
    ballDir: { x: 1, y: -1 },
    score: 0,
    lives: 3,
    gameOver: false,
    win: false,
    paused: false,
  };
}

// ─── 物理更新 ──────────────────────────────────────────────────

function update(state: GameState): void {
  if (state.paused || state.gameOver || state.win) return;

  state.ball.x += state.ballDir.x;
  state.ball.y += state.ballDir.y;

  if (state.ball.x <= 0) { state.ball.x = 0; state.ballDir.x = 1; }
  if (state.ball.x >= GAME_WIDTH - 1) { state.ball.x = GAME_WIDTH - 1; state.ballDir.x = -1; }
  if (state.ball.y <= 0) { state.ball.y = 0; state.ballDir.y = 1; }

  // 挡板碰撞
  if (
    state.ball.y === GAME_HEIGHT - 1 &&
    state.ball.x >= state.paddleX &&
    state.ball.x <= state.paddleX + PADDLE_WIDTH
  ) {
    state.ballDir.y = -1;
    const hitPos = (state.ball.x - state.paddleX) / PADDLE_WIDTH;
    state.ballDir.x = hitPos < 0.5 ? -1 : 1;
  }

  // 出界
  if (state.ball.y > GAME_HEIGHT) {
    state.lives--;
    if (state.lives <= 0) {
      state.gameOver = true;
    } else {
      state.ball = { x: GAME_WIDTH / 2, y: GAME_HEIGHT - 3 };
      state.ballDir = { x: 1, y: -1 };
      state.paddleX = Math.floor(GAME_WIDTH / 2) - Math.floor(PADDLE_WIDTH / 2);
    }
  }

  // 砖块碰撞
  const hitBrick = state.bricks.find((b) => {
    if (!b.alive) return false;
    return state.ball.x >= b.x && state.ball.x < b.x + b.w && state.ball.y >= b.y && state.ball.y < b.y + 1;
  });

  if (hitBrick) {
    hitBrick.alive = false;
    state.score += 10;
    state.ballDir.y = -state.ballDir.y;
  }

  if (state.bricks.every((b) => !b.alive)) state.win = true;
}

// ─── 画面渲染（含 ANSI 颜色） ─────────────────────────────────

function buildBoard(state: GameState): string {
  const lines: string[] = [];

  function brickColorIndex(x: number, y: number): number | undefined {
    const row = Math.floor((y - 2) / 2);
    if (row >= 0) {
      const b = state.bricks.find((br) => br.y === y && br.alive && x >= br.x && x < br.x + br.w);
      if (b) return row % BRICK_COLORS.length;
    }
    return undefined;
  }

  for (let y = 0; y < GAME_HEIGHT; y++) {
    let line = "";
    for (let x = 0; x < GAME_WIDTH; x++) {
      const isBall = state.ball.x === x && state.ball.y === y;
      const isPaddle = y === GAME_HEIGHT - 1 && x >= state.paddleX && x < state.paddleX + PADDLE_WIDTH;
      const brickRow = brickColorIndex(x, y);

      if (isBall) {
        line += "\x1b[97m●\x1b[0m";
      } else if (isPaddle) {
        line += "\x1b[94m▄\x1b[0m";
      } else if (brickRow !== undefined) {
        line += `\x1b[38;5;${BRICK_COLORS[brickRow]}m▀\x1b[0m`;
      } else {
        line += " ";
      }
    }
    lines.push(line);
  }

  return lines.map((l) => `│${l}│`).join("\n");
}

// ─── Ink 组件 ──────────────────────────────────────────────────

interface BrickBreakerGameProps {
  onExit: () => void;
}

function BrickBreakerGame({ onExit: _onExit }: BrickBreakerGameProps) {
  const [initialLevel, setInitialLevel] = useState(1);
  const [selectingLevel, setSelectingLevel] = useState(true);
  const stateRef = useRef<GameState>(createInitialState(initialLevel));
  const [tick, setTick] = useState(0);
  const onExitRef = useRef(_onExit);
  onExitRef.current = _onExit;

  useEffect(() => {
    if (selectingLevel) return;
    const interval = setInterval(() => {
      update(stateRef.current);
      setTick((t) => t + 1);
    }, 80);
    return () => clearInterval(interval);
  }, [selectingLevel]);

  // 重新开始（保留当前关卡）
  const restart = useCallback((level?: number) => {
    const lv = level ?? stateRef.current.level;
    stateRef.current = createInitialState(lv);
    setInitialLevel(lv);
    setSelectingLevel(false);
    setTick(0);
  }, []);

  // 选关
  const startLevelSelect = useCallback(() => {
    setSelectingLevel(true);
  }, []);

  useInput(
    useCallback((input, key) => {
      const s = stateRef.current;

      // 选关模式
      if (selectingLevel) {
        if (input >= "1" && input <= "9") {
          restart(Number(input));
        } else if (input === "0") {
          restart(10);
        } else if (key.escape || input === "q") {
          onExitRef.current();
        }
        return;
      }

      if (key.leftArrow) {
        s.paddleX = Math.max(0, s.paddleX - 1);
        setTick((t) => t + 1);
      } else if (key.rightArrow) {
        s.paddleX = Math.min(GAME_WIDTH - PADDLE_WIDTH, s.paddleX + 1);
        setTick((t) => t + 1);
      } else if (input === "p" || input === " ") {
        s.paused = !s.paused;
      } else if (input === "r") {
        if (s.gameOver || s.win) restart();
      } else if (input === "l") {
        if (s.gameOver || s.win) startLevelSelect();
      } else if (input === "q" || key.escape) {
        onExitRef.current();
      }
    }, [selectingLevel, restart, startLevelSelect]),
  );

  const s = stateRef.current;
  const aliveCount = s.bricks.filter((b) => b.alive).length;
  const board = buildBoard(s);
  const def = getLevel(s.level);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  void tick;

  return (
    <Box flexDirection="column">
      {/* 状态栏 */}
      <Box flexDirection="row">
        <Box width={20}>
          <Text>
            关卡 {s.level}: <Text color="cyan">{def.desc}</Text>
          </Text>
        </Box>
        <Box width={12}>
          <Text>
            分数: <Text color="yellow">{String(s.score).padStart(3, "0")}</Text>
          </Text>
        </Box>
        <Box width={12}>
          <Text>
            生命: <Text color="red">{"♥".repeat(Math.max(0, s.lives))}</Text>
          </Text>
        </Box>
        <Box width={10}>
          <Text>
            砖块: <Text color="cyan">{aliveCount}</Text>
          </Text>
        </Box>
        <Box>
          <Text color={s.paused ? "gray" : "green"}>
            [{s.paused ? "暂停" : "运行中"}]
          </Text>
        </Box>
      </Box>

      {/* 游戏画面 */}
      <Box flexDirection="column">
        <Text>┌{"─".repeat(GAME_WIDTH)}┐</Text>
        <Text>{selectingLevel ? "  \x1b[90m选择关卡后开始...\x1b[0m" : board}</Text>
        <Text>└{"─".repeat(GAME_WIDTH)}┘</Text>
      </Box>

      {/* 选关界面 */}
      {selectingLevel && (
        <Box marginTop={1} flexDirection="column">
          <Text bold color="yellow">选择关卡</Text>
          <Box flexDirection="row" flexWrap="wrap">
            {LEVELS.map((lv, i) => (
              <Box key={i} width={22}>
                <Text>
                  <Text color={initialLevel === i + 1 ? "green" : "white"}>
                    {i + 1 === 10 ? "0" : String(i + 1)}
                  </Text>
                  . {lv.desc} ({lv.rows}×{lv.cols})
                </Text>
              </Box>
            ))}
          </Box>
          <Box marginTop={1}>
            <Text dimColor>按数字选关  q 退出</Text>
          </Box>
        </Box>
      )}

      {/* 结束/通关信息 */}
      {!selectingLevel && (s.gameOver || s.win) && (
        <Box marginTop={1}>
          <Text bold color={s.gameOver ? "red" : "green"}>
            {s.gameOver ? "游戏结束！" : "恭喜通关！"}
          </Text>
          <Text>
            {"  分数: "}<Text color="yellow">{s.score}</Text>
          </Text>
        </Box>
      )}

      {/* 操作提示 */}
      {!selectingLevel && (
        <Box marginTop={1}>
          {s.gameOver || s.win ? (
            <Text dimColor>
              {"← → 移动  r 重开  l 选关  q 退出"}
            </Text>
          ) : (
            <Text dimColor>
              {"← → 移动  p 暂停  q 退出"}
            </Text>
          )}
        </Box>
      )}
    </Box>
  );
}

// ─── 导出 ──────────────────────────────────────────────────────

export default {
  id: "brick-breaker",
  name: "Brick Breaker",
  description: "经典打砖块游戏，10 个关卡可选！",
  play: async () => {
    await new Promise<void>((resolve) => {
      const { unmount } = render(
        <BrickBreakerGame onExit={() => { unmount(); resolve(); }} />,
      );
    });
  },
};
