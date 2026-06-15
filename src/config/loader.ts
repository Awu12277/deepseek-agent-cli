import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "smol-toml";
import type { Config } from "./types.js";

/** 出厂默认配置 — 在找不到配置文件时使用。 */
export const defaultConfig: Config = {
  defaultProvider: "deepseek",
  providers: [
    {
      name: "deepseek",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-chat",
    },
  ],
  tools: [
    { name: "read_file", enabled: true },
    { name: "write_file", enabled: true },
    { name: "edit_file", enabled: true },
    { name: "bash", enabled: true },
    { name: "glob", enabled: true },
    { name: "grep", enabled: true },
    { name: "ls", enabled: true },
    { name: "fetch", enabled: true },
  ],
  plugins: [],
};

/**
 * 从 TOML 文件加载配置，未找到时回退到默认值。
 *
 * 解析顺序（后加载的优先级更高）：
 *   1. 内置默认值
 *   2. 用户全局 ~/.config/dsk.toml
 *   3. 项目本地 .dsk.toml（或通过 --config 指定的路径）
 */
export async function loadConfig(configPath?: string): Promise<Config> {
  const candidates: string[] = [];

  if (configPath) {
    candidates.push(configPath);
  } else {
    candidates.push(
      join(process.env.HOME ?? process.env.USERPROFILE ?? "~", ".config", "dsk.toml"),
      join(process.cwd(), ".dsk.toml"),
    );
  }

  let config: Config = structuredClone(defaultConfig);

  for (const candidate of candidates) {
    try {
      const raw = await readFile(candidate, "utf-8");
      const parsed = parse(raw) as unknown as Partial<Config>;
      config = mergeConfig(config, parsed);
    } catch {
      // file doesn't exist or can't be read — skip
    }
  }

  return config;
}

/** 将部分配置深度合并到已有配置之上。 */
function mergeConfig(base: Config, overlay: Partial<Config>): Config {
  return {
    ...base,
    ...(overlay.defaultProvider !== undefined && { defaultProvider: overlay.defaultProvider }),
    ...(overlay.providers !== undefined && { providers: overlay.providers }),
    ...(overlay.tools !== undefined && { tools: overlay.tools }),
    ...(overlay.plugins !== undefined && { plugins: overlay.plugins }),
  };
}
