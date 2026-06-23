import * as readline from 'node:readline';
import type { Direction, GameState } from './types.js';
import { changeDirection } from './engine.js';

// ─── 按键 → 方向映射 ───────────────────────────────────

const KEY_TO_DIR: Record<string, Direction> = {
  up: 'UP',
  w: 'UP',
  W: 'UP',
  down: 'DOWN',
  s: 'DOWN',
  S: 'DOWN',
  left: 'LEFT',
  a: 'LEFT',
  A: 'LEFT',
  right: 'RIGHT',
  d: 'RIGHT',
  D: 'RIGHT',
};

// ─── 输入设置 ───────────────────────────────────────────

export interface InputContext {
  state: GameState;
}

export type InputCleanup = () => void;

/**
 * 设置终端键盘输入监听。
 * - WASD / 方向键 → 控制方向
 * - P → 暂停/继续
 * - R → 游戏结束后重新开始
 * - Q / Ctrl+C → 退出游戏
 *
 * @param ctx       可变状态上下文（重启时替换 state 引用）
 * @param onQuit    退出回调
 * @param onRestart 重新开始回调（应返回新的 GameState）
 */
export function setupInput(
  ctx: InputContext,
  onQuit: () => void,
  onRestart: () => GameState,
): InputCleanup {
  readline.emitKeypressEvents(process.stdin);

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }

  const handler = (_: unknown, key: readline.Key) => {
    if (!key || !key.name) return;

    const { name, ctrl } = key;

    // Ctrl+C / Ctrl+D → 退出
    if (ctrl && (name === 'c' || name === 'd')) {
      onQuit();
      return;
    }

    // Q → 退出
    if (name === 'q') {
      onQuit();
      return;
    }

    const state = ctx.state;

    // 游戏结束后 R → 重新开始
    if (state.isGameOver) {
      if (name === 'r') {
        ctx.state = onRestart();
      }
      return;
    }

    // P → 暂停/继续
    if (name === 'p') {
      state.isPaused = !state.isPaused;
      return;
    }

    // M → 切换边界模式（穿墙 / 撞墙）
    if (name === 'm') {
      state.wallWrap = !state.wallWrap;
      return;
    }

    // 方向控制
    const dir = KEY_TO_DIR[name];
    if (dir) {
      changeDirection(state, dir);
    }
  };

  process.stdin.on('keypress', handler);

  return () => {
    process.stdin.removeListener('keypress', handler);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
  };
}
