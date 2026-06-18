import { registerGame, listGames } from "./index.js";
import type { Game } from "./index.js";
import brickBreaker from "./brick-breaker/index.js";

/** 在此注册所有游戏 */
export function initGames(): Game[] {
  registerGame(brickBreaker);
  return listGames();
}
