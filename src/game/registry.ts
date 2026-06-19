import { registerGame, listGames } from "./index.js";
import type { Game } from "./index.js";
import brickBreaker from "./brick-breaker/index.js";
import coderCheck from "./coder-check/index.js";

/** 在此注册所有游戏 */
export function initGames(): Game[] {
  registerGame(brickBreaker);
  registerGame(coderCheck);
  return listGames();
}
