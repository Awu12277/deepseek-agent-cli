import type { Command } from "commander";
import type { Config } from "../config/index.js";
import { loadConfig } from "../config/index.js";

/**
 * dskcode 运行时上下文。
 * 通过 commander 的 preAction hook 注入到每个命令中。
 */
export interface DskcodeContext {
  config: Config;
  verbose: boolean;
}

/**
 * 在 preAction hook 中加载配置并构造上下文。
 */
export async function loadConfigMiddleware(this: Command): Promise<DskcodeContext> {
  const opts = this.optsWithGlobals() as { verbose?: boolean; config?: string };
  const verbose = opts.verbose ?? false;

  let config: Config;
  try {
    config = await loadConfig(opts.config);
  } catch {
    const { defaultConfig } = await import("../config/index.js");
    config = defaultConfig;
  }

  return { config, verbose };
}
