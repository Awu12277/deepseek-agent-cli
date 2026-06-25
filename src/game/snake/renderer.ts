import chalk from 'chalk';
import type { GameState, GameConfig } from './types.js';

// 每个格子在终端中占 2 个字符宽度，让网格看起来更接近正方形
const CELL_W = 2;
const EMPTY = '  ';
const BODY_CHAR = '▓';
const HEAD_CHAR = '▓';
const NORMAL_FOOD_CHAR = '◆';
const SPECIAL_FOOD_CHAR = '★';

// ─── ANSI 控制序列 ──────────────────────────────────────

const CSI = '\x1b[';
const CURSOR_HIDE = `${CSI}?25l`;
const CURSOR_SHOW = `${CSI}?25h`;
const CURSOR_HOME = `${CSI}H`;

/** 隐藏终端光标 */
export function hideCursor(): void {
  process.stdout.write(CURSOR_HIDE);
}

/** 显示终端光标 */
export function showCursor(): void {
  process.stdout.write(CURSOR_SHOW);
}

/** 清屏并复位光标 */
export function clearScreen(): void {
  process.stdout.write(`${CSI}2J${CURSOR_HOME}`);
}

// ─── 着色辅助 ───────────────────────────────────────────

function cellColor(char: string, type: 'snake-head' | 'snake-body' | 'normal-food' | 'special-food' | 'empty'): string {
  switch (type) {
    case 'snake-head':  return chalk.greenBright(char);
    case 'snake-body':  return chalk.green(char);
    case 'normal-food': return chalk.red(char);
    case 'special-food': return chalk.yellow(char);
    case 'empty':       return char;
  }
}

// ─── 主渲染函数 ─────────────────────────────────────────

/**
 * 将当前游戏状态渲染到终端。
 * 先移动光标到左上角再逐行覆盖，避免闪烁。
 */
export function renderToTerminal(state: GameState, config: GameConfig): void {
  const lines = buildRenderLines(state, config);
  // 先清屏再回左上角绘制，避免状态切换/终端滚动时旧行残留导致重叠
  process.stdout.write(`${CSI}2J${CURSOR_HOME}` + lines.join('\n'));
}

function buildRenderLines(state: GameState, config: GameConfig): string[] {
  const { width: W, height: H } = config;
  const lines: string[] = [];

  // ── 构建网格数据 ──
  // grid[y][x] 存储该位置要显示的内容类型
  const grid: string[][] = Array.from({ length: H }, () => Array(W).fill('empty'));

  // 蛇身（除蛇头外）
  for (let i = 1; i < state.snake.length; i++) {
    const seg = state.snake[i]!;
    if (seg.y >= 0 && seg.y < H && seg.x >= 0 && seg.x < W) {
      grid[seg.y]![seg.x] = 'snake-body';
    }
  }

  // 蛇头（覆盖蛇身标记，确保蛇头颜色优先）
  const head = state.snake[0]!;
  if (head.y >= 0 && head.y < H && head.x >= 0 && head.x < W) {
    grid[head.y]![head.x] = 'snake-head';
  }

  // 普通食物
  const fp = state.food.position;
  if (grid[fp.y]![fp.x] === 'empty') {
    grid[fp.y]![fp.x] = 'normal-food';
  }

  // 特殊食物
  if (state.specialFood) {
    const sp = state.specialFood.position;
    if (grid[sp.y]![sp.x] === 'empty') {
      grid[sp.y]![sp.x] = 'special-food';
    }
  }

  // ── 顶部边框 ──
  lines.push('  ' + chalk.gray('╔' + '══'.repeat(W) + '╗'));

  // ── 每行渲染 ──
  for (let y = 0; y < H; y++) {
    let row = '  ' + chalk.gray('║');
    for (let x = 0; x < W; x++) {
      const cellType = grid[y]![x]!;
      let char: string;
      switch (cellType) {
        case 'snake-head':
          char = HEAD_CHAR.repeat(CELL_W);
          break;
        case 'snake-body':
          char = BODY_CHAR.repeat(CELL_W);
          break;
        case 'normal-food':
          char = NORMAL_FOOD_CHAR + ' ';
          break;
        case 'special-food':
          char = SPECIAL_FOOD_CHAR + ' ';
          break;
        default:
          char = EMPTY;
      }
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      row += cellColor(char, cellType as unknown as 'snake-head' | 'snake-body' | 'normal-food' | 'special-food' | 'empty');
    }
    row += chalk.gray('║');
    lines.push(row);
  }

  // ── 底部边框 ──
  lines.push('  ' + chalk.gray('╚' + '══'.repeat(W) + '╝'));

  // ── HUD 信息 ──
  lines.push('');
  lines.push(
    `  ${chalk.cyan('分数')}: ${state.score}  ` +
    `${chalk.cyan('长度')}: ${state.snake.length}  ` +
    `${chalk.cyan('速度')}: Lv.${state.speedLevel}  ` +
    `${chalk.cyan('边界')}: ${state.wallWrap ? '穿墙' : '撞墙'}`,
  );

  // 特殊食物倒计时提示
  if (state.specialFood?.spawnedAt !== undefined) {
    const remaining = Math.ceil((5000 - (Date.now() - state.specialFood.spawnedAt)) / 1000);
    if (remaining > 0) {
      lines.push(`  ${chalk.yellow(`⭐ 特殊食物 ${remaining} 秒后消失`)}`);
    }
  }

  // 操作提示
  lines.push(`  ${chalk.gray('W/A/S/D 或 方向键移动 | P 暂停 | M 切换模式 | Q 退出')}`);

  // 暂停 / 游戏结束提示
  if (state.isPaused) {
    lines.push('');
    lines.push(`  ${chalk.yellow('⏸  已暂停 — 按 P 继续')}`);
  }

  if (state.isGameOver) {
    lines.push('');
    lines.push(`  ${chalk.red.bold('💀  游戏结束!')}  ${chalk.cyan('最终分数: ' + state.score)}`);
    lines.push(`  ${chalk.gray('按 R 重新开始 | 按 Q 退出')}`);
  }

  return lines;
}
