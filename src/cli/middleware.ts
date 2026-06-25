import type { Command } from "commander";
import {
  loadAndValidate,
  applyCliOverrides,
  defaultConfig,
} from "../config/index.js";
import type { Config } from "../config/index.js";

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
 *
 * 完整的配置解析流水线：
 *   1. 内置默认值 —— defaultConfig
 *   2. 用户全局 —— ~/.dskcode/settings.json
 *   3. 项目本地 —— .dskcode/settings.json（或 --config 指定的路径）
 *   4. 环境变量 —— DEEPSEEK_API_KEY / DSKCODE_*
 *   5. CLI flag —— --verbose / --model 等
 */
export async function loadConfigMiddleware(
  this: Command,
): Promise<DskcodeContext> {
  // eslint-disable-next-line oxc/no-this-in-exported-function, @typescript-eslint/no-unsafe-type-assertion
  const opts = this.optsWithGlobals() as {
    verbose?: boolean;
    config?: string;
    model?: string;
  };
  const verbose = opts.verbose ?? false;

  // 1-4. 加载 TOML 文件 + 环境变量
  let config: Config;
  const errors: string[] = [];
  try {
    const result = await loadAndValidate(opts.config);
    config = result.config;
    if (result.errors.length > 0) {
      for (const e of result.errors) {
        errors.push(e.message);
      }
    }
  } catch {
    config = structuredClone(defaultConfig);
  }

  // 5. CLI flag 覆盖（优先级最高）
  config = applyCliOverrides(config, {
    verbose,
    model: opts.model,
  });

  // 校验错误输出（不阻断执行）
  if (errors.length > 0 && verbose) {
    for (const msg of errors) {
      console.error(`  ⚠ ${msg}`);
    }
  }

  return { config, verbose };
}
