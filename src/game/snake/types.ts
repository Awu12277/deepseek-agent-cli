/** 移动方向 */
export type Direction = 'UP' | 'DOWN' | 'LEFT' | 'RIGHT';

/** 坐标点 */
export interface Point {
  x: number;
  y: number;
}

/** 食物类型 */
export interface Food {
  position: Point;
  type: 'normal' | 'special';
  /** 特殊食物的生成时间戳 (ms)，用于判断是否过期 */
  spawnedAt?: number;
}

/** 游戏运行时状态 */
export interface GameState {
  snake: Point[];
  direction: Direction;
  nextDirection: Direction;
  food: Food;
  specialFood: Food | null;
  score: number;
  speedLevel: number;
  isGameOver: boolean;
  isPaused: boolean;
  wallWrap: boolean;
  tickInterval: number;
}

/** 游戏配置 */
export interface GameConfig {
  width: number;
  height: number;
  initialSpeed: number;
  minSpeed: number;
  speedDecrement: number;
  scorePerLevel: number;
}
