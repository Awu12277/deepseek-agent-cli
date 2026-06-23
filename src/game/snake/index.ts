import type { Game } from '../index.js';
import type { GameConfig } from './types.js';
import { createInitialState, tick } from './engine.js';
import { renderToTerminal, clearScreen, hideCursor, showCursor } from './renderer.js';
import { setupInput } from './input.js';
import type { InputContext } from './input.js';

const CONFIG: GameConfig = {
  width: 20,
  height: 16,
  initialSpeed: 180,
  minSpeed: 60,
  speedDecrement: 10,
  scorePerLevel: 5,
};

/** 游戏结束后或暂停时的循环间隔（不需要高帧率） */
const IDLE_INTERVAL = 200;

const snakeGame: Game = {
  id: 'snake',
  name: 'Big Snake',
  description: '经典贪吃蛇，双食物系统、难度递增、穿墙/撞墙模式',
  play: async () => {
    const ctx: InputContext = { state: createInitialState(CONFIG) };

    return new Promise<void>((resolve) => {
      const cleanupInput = setupInput(
        ctx,
        () => {
          // ── 退出 ──
          stop = true;
          clearTimeout(timerId);
          showCursor();
          cleanupInput();
          resolve();
        },
        () => {
          // ── 重新开始 ──
          return createInitialState(CONFIG);
        },
      );

      // 初始化终端
      clearScreen();
      hideCursor();

      let stop = false;
      let timerId: ReturnType<typeof setTimeout>;

      function loop(): void {
        if (stop) return;

        const s = ctx.state;

        if (!s.isGameOver && !s.isPaused) {
          tick(s, CONFIG);
        }

        renderToTerminal(s, CONFIG);

        // 游戏进行中 → 用 tick 速度；暂停/结束时用恒定低速，节省 CPU
        const interval = s.isGameOver || s.isPaused ? IDLE_INTERVAL : s.tickInterval;
        timerId = setTimeout(loop, interval);
      }

      timerId = setTimeout(loop, 0);
    });
  },
};

export default snakeGame;
