import type { Direction, GameState, GameConfig, Food, Point } from './types.js';

// ─── 辅助函数 ───────────────────────────────────────────

function isOpposite(a: Direction, b: Direction): boolean {
  return (
    (a === 'UP' && b === 'DOWN') ||
    (a === 'DOWN' && b === 'UP') ||
    (a === 'LEFT' && b === 'RIGHT') ||
    (a === 'RIGHT' && b === 'LEFT')
  );
}

function samePoint(a: Point, b: Point): boolean {
  return a.x === b.x && a.y === b.y;
}

function movePoint(p: Point, dir: Direction): Point {
  switch (dir) {
    case 'UP':    return { x: p.x, y: p.y - 1 };
    case 'DOWN':  return { x: p.x, y: p.y + 1 };
    case 'LEFT':  return { x: p.x - 1, y: p.y };
    case 'RIGHT': return { x: p.x + 1, y: p.y };
  }
}

function wrapPoint(p: Point, config: GameConfig): Point {
  return {
    x: ((p.x % config.width) + config.width) % config.width,
    y: ((p.y % config.height) + config.height) % config.height,
  };
}

// ─── 食物生成 ───────────────────────────────────────────

/**
 * 在蛇身 + 指定排除位置之外的随机空位生成食物。
 * 排除位置用于防止普通食物和特殊食物重叠。
 */
function generateFood(
  snake: Point[],
  config: GameConfig,
  type: 'normal' | 'special',
  excludePositions: Point[] = [],
): Food | null {
  const occupied = new Set(snake.map(p => `${p.x},${p.y}`));
  // 排除位置也加入已占用集合（防止与另一种食物重叠）
  for (const p of excludePositions) {
    occupied.add(`${p.x},${p.y}`);
  }

  const totalCells = config.width * config.height;
  if (occupied.size >= totalCells) return null;

  let pos: Point;
  do {
    pos = {
      x: Math.floor(Math.random() * config.width),
      y: Math.floor(Math.random() * config.height),
    };
  } while (occupied.has(`${pos.x},${pos.y}`));

  return {
    position: pos,
    type,
    ...(type === 'special' ? { spawnedAt: Date.now() } : {}),
  };
}

// ─── 状态工厂 ───────────────────────────────────────────

/** 创建初始游戏状态 */
export function createInitialState(config: GameConfig): GameState {
  const startX = Math.floor(config.width / 2);
  const startY = Math.floor(config.height / 2);

  const snake: Point[] = [
    { x: startX, y: startY },
    { x: startX - 1, y: startY },
    { x: startX - 2, y: startY },
  ];

  const food = generateFood(snake, config, 'normal')!;

  return {
    snake,
    direction: 'RIGHT',
    nextDirection: 'RIGHT',
    food,
    specialFood: null,
    score: 0,
    speedLevel: 1,
    isGameOver: false,
    isPaused: false,
    wallWrap: Math.random() < 0.5,
    tickInterval: config.initialSpeed,
  };
}

// ─── 核心逻辑：每帧推进 ─────────────────────────────────

export function tick(state: GameState, config: GameConfig): void {
  // 1. 应用缓冲方向（防止同帧内 180° 掉头）
  state.direction = state.nextDirection;

  // 2. 计算新蛇头位置
  const head = state.snake[0]!;
  let newHead = movePoint(head, state.direction);

  // 3. 边界处理
  const outOfBounds =
    newHead.x < 0 ||
    newHead.x >= config.width ||
    newHead.y < 0 ||
    newHead.y >= config.height;

  if (outOfBounds) {
    if (state.wallWrap) {
      newHead = wrapPoint(newHead, config);
    } else {
      state.isGameOver = true;
      return;
    }
  }

  // 4. 判断本帧是否会吃到食物（影响自碰撞检测的判定范围）
  const ateNormal = samePoint(newHead, state.food.position);
  const ateSpecial = state.specialFood !== null && samePoint(newHead, state.specialFood.position);
  const willEat = ateNormal || ateSpecial;

  // 自碰撞检测：不吃食物时排除蛇尾（因为蛇尾会移除）
  const bodyToCheck = willEat ? state.snake : state.snake.slice(0, -1);
  for (const segment of bodyToCheck) {
    if (samePoint(newHead, segment)) {
      state.isGameOver = true;
      return;
    }
  }

  // 5. 移动蛇
  state.snake.unshift(newHead);

  // 6. 处理进食
  if (ateNormal) {
    state.score += 1;
    updateSpeed(state, config);

    // 生成新普通食物时排除特殊食物的位置
    const exclude: Point[] = state.specialFood ? [state.specialFood.position] : [];
    const newFood = generateFood(state.snake, config, 'normal', exclude);
    if (newFood) {
      state.food = newFood;
    } else {
      // 没有空位了（蛇填满了棋盘），宣告胜利
      state.isGameOver = true;
      return;
    }

    // 25% 概率生成特殊食物，排除普通食物的位置
    if (state.specialFood === null && Math.random() < 0.25) {
      state.specialFood = generateFood(state.snake, config, 'special', [state.food.position]);
    }
  } else if (ateSpecial) {
    state.score += 3;
    updateSpeed(state, config);
    state.specialFood = null;
  } else {
    // 没吃到食物，移除蛇尾
    state.snake.pop();
  }

  // 7. 特殊食物倒计时（5 秒后消失）
  if (state.specialFood?.spawnedAt !== undefined) {
    if (Date.now() - state.specialFood.spawnedAt > 5000) {
      state.specialFood = null;
    }
  }
}

// ─── 速度更新 ───────────────────────────────────────────

function updateSpeed(state: GameState, config: GameConfig): void {
  const newLevel = Math.floor(state.score / config.scorePerLevel) + 1;
  state.speedLevel = newLevel;
  state.tickInterval = Math.max(
    config.minSpeed,
    config.initialSpeed - (newLevel - 1) * config.speedDecrement,
  );
}

// ─── 方向变更（外部调用） ──────────────────────────────

/**
 * 尝试改变方向。
 * 检查新方向是否与当前移动方向相反，防止 180° 掉头。
 */
export function changeDirection(state: GameState, newDir: Direction): void {
  if (!isOpposite(newDir, state.direction)) {
    state.nextDirection = newDir;
  }
}
