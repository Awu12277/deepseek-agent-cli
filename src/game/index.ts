export interface Game {
  /** 游戏唯一标识 */
  id: string;
  /** 游戏名称 */
  name: string;
  /** 简短描述 */
  description: string;
  /** 启动游戏 */
  play: () => Promise<void>;
}

const registry = new Map<string, Game>();

export function registerGame(game: Game): void {
  registry.set(game.id, game);
}

export function getGame(id: string): Game | undefined {
  return registry.get(id);
}

export function listGames(): Game[] {
  return Array.from(registry.values());
}
