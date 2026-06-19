import { existsSync, watch } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config, ProviderConfig, ToolConfig, PluginConfig, StockConfig } from "./types.js";

// ---------------------------------------------------------------------------
// 出厂默认配置
// ---------------------------------------------------------------------------

export const defaultConfig: Config = {
  defaultProvider: "deepseek",
  maxTokens: 8192,
  temperature: 0.7,
  maxToolRounds: 20,
  providers: [
    {
      name: "deepseek",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-flash",
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
  stock: {
    symbols: [
      { code: "sh000001" },
      { code: "sz399300" },
      { code: "sh601899" },
    ],
  },
};

// ---------------------------------------------------------------------------
// 配置文件路径解析
// ---------------------------------------------------------------------------

/** 判断一个字符串是否为合法的 URL（用于区分 local path 和 url） */
function isUrl(s: string): boolean {
  try {
    new URL(s);
    return true;
  } catch {
    return false;
  }
}

/**
 * 返回候选配置文件路径列表。
 * 若传入了 --config 路径，则只使用该路径；
 * 否则依次检查用户全局目录和项目本地目录。
 */
function resolveConfigFiles(configPath?: string): string[] {
  if (configPath) {
    return [configPath];
  }

  const home = process.env.HOME ?? process.env.USERPROFILE ?? "~";
  return [
    join(home, ".dskcode", "settings.json"),
    join(process.cwd(), ".dskcode", "settings.json"),
  ];
}

// ---------------------------------------------------------------------------
// 深度合并
// ---------------------------------------------------------------------------

/**
 * 将较高优先级的配置 overlay 合并到 base 之上。
 *
 * 合并规则：
 *  - 标量字段（string / number / boolean）：覆盖
 *  - 数组字段（providers / tools / plugins）：直接替换，不合并
 */
function mergeConfig(base: Config, overlay: Partial<Config>): Config {
  const result: Config = { ...base };

  if (overlay.defaultProvider !== undefined) {
    result.defaultProvider = overlay.defaultProvider;
  }
  if (overlay.verbose !== undefined) {
    result.verbose = overlay.verbose;
  }
  if (overlay.maxTokens !== undefined) {
    result.maxTokens = overlay.maxTokens;
  }
  if (overlay.temperature !== undefined) {
    result.temperature = overlay.temperature;
  }
  if (overlay.maxToolRounds !== undefined) {
    result.maxToolRounds = overlay.maxToolRounds;
  }
  if (overlay.providers !== undefined) {
    result.providers = overlay.providers as ProviderConfig[];
  }
  if (overlay.tools !== undefined) {
    result.tools = overlay.tools as ToolConfig[];
  }
  if (overlay.plugins !== undefined) {
    result.plugins = overlay.plugins as PluginConfig[];
  }
  if (overlay.stock !== undefined) {
    result.stock = overlay.stock as StockConfig;
  }

  return result;
}

// ---------------------------------------------------------------------------
// 环境变量解析
// ---------------------------------------------------------------------------

/** 环境变量前缀 */
const ENV_PREFIX = "DSKCODE_";

/** 支持的环境变量映射表 */
const ENV_MAP: Record<string, keyof Config> = {
  [`${ENV_PREFIX}DEFAULT_PROVIDER`]: "defaultProvider",
  [`${ENV_PREFIX}VERBOSE`]: "verbose",
  [`${ENV_PREFIX}MAX_TOKENS`]: "maxTokens",
  [`${ENV_PREFIX}TEMPERATURE`]: "temperature",
  [`${ENV_PREFIX}MAX_TOOL_ROUNDS`]: "maxToolRounds",
};

/**
 * 将环境变量中读取的值覆盖到配置上。
 * 环境变量的优先级高于 TOML 文件，但低于 CLI flag。
 */
function applyEnvVars(config: Config): Config {
  // 1. DSKCODE_* 前缀的环境变量
  for (const [envKey, configKey] of Object.entries(ENV_MAP)) {
    const raw = process.env[envKey];
    if (raw === undefined) continue;

    const cfg = config as unknown as Record<string, unknown>;
    switch (configKey) {
      case "verbose":
      case "defaultProvider": {
        cfg[configKey] = raw;
        break;
      }
      case "maxTokens":
      case "maxToolRounds": {
        const n = Number(raw);
        if (Number.isFinite(n) && n > 0) {
          cfg[configKey] = n;
        }
        break;
      }
      case "temperature": {
        const n = Number(raw);
        if (Number.isFinite(n) && n >= 0 && n <= 2) {
          cfg[configKey] = n;
        }
        break;
      }
    }
  }

  // 2. DEEPSEEK_API_KEY — 注入到名为 deepseek 的 provider
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (apiKey) {
    const deepseek = config.providers.find((p) => p.name === "deepseek");
    if (deepseek && !deepseek.apiKey) {
      deepseek.apiKey = apiKey;
    }
    // 如果没有 deepseek provider，自动创建一个
    if (!deepseek) {
      config.providers.unshift({
        name: "deepseek",
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-v4-flash",
        apiKey,
      });
    }
  }

  return config;
}

// ---------------------------------------------------------------------------
// CLI flag 覆盖
// ---------------------------------------------------------------------------

export interface CliFlags {
  verbose?: boolean;
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

/**
 * 将 CLI flag 中的值覆盖到配置上。
 * CLI flag 的优先级最高。
 */
export function applyCliOverrides(config: Config, flags: CliFlags): Config {
  if (flags.verbose !== undefined) {
    config.verbose = flags.verbose;
  }
  if (flags.model !== undefined) {
    // 将 --model 的值映射为标准 model 名称
    // 如果用户指定了 --model，覆盖 defaultProvider 中配置的 model
    // 但保留 provider 的选择，仅修改该 provider 的 model
    const provider = config.providers.find(
      (p) => p.name === config.defaultProvider,
    );
    if (provider) {
      provider.model = flags.model;
    }
  }
  if (flags.maxTokens !== undefined && flags.maxTokens > 0) {
    config.maxTokens = flags.maxTokens;
  }
  if (
    flags.temperature !== undefined &&
    flags.temperature >= 0 &&
    flags.temperature <= 2
  ) {
    config.temperature = flags.temperature;
  }
  return config;
}

// ---------------------------------------------------------------------------
// 配置校验
// ---------------------------------------------------------------------------

export interface ConfigError {
  field: string;
  message: string;
}

/**
 * 校验配置的合法性，返回错误列表。
 * 返回空数组表示配置合法。
 */
export function validateConfig(config: Config): ConfigError[] {
  const errors: ConfigError[] = [];

  // 1. 至少需要一个 Provider
  if (!config.providers || config.providers.length === 0) {
    errors.push({
      field: "providers",
      message: "至少需要配置一个 Provider。请通过配置文件或 DEEPSEEK_API_KEY 环境变量设置。",
    });
  }

  // 2. 每个 Provider 必须有 name 和 model
  for (let i = 0; i < config.providers.length; i++) {
    const p = config.providers[i]!;
    if (!p.name) {
      errors.push({
        field: `providers[${i}].name`,
        message: `第 ${i + 1} 个 Provider 缺少 name 字段。`,
      });
    }
    if (!p.model) {
      errors.push({
        field: `providers[${i}].model`,
        message: `Provider "${p.name || i}" 缺少 model 字段。`,
      });
    }
  }

  // 3. defaultProvider 必须存在于 providers 列表中
  if (config.defaultProvider) {
    const exists = config.providers.some(
      (p) => p.name === config.defaultProvider,
    );
    if (!exists) {
      errors.push({
        field: "defaultProvider",
        message: `默认 Provider "${config.defaultProvider}" 未在 providers 中定义。`,
      });
    }
  }

  // 4. temperature 范围校验
  if (
    config.temperature !== undefined &&
    (config.temperature < 0 || config.temperature > 2)
  ) {
    errors.push({
      field: "temperature",
      message: "temperature 必须在 0.0 ~ 2.0 之间。",
    });
  }

  // 5. maxToolRounds 范围校验
  if (config.maxToolRounds !== undefined && config.maxToolRounds < 1) {
    errors.push({
      field: "maxToolRounds",
      message: "maxToolRounds 必须大于等于 1。",
    });
  }

  return errors;
}

// ---------------------------------------------------------------------------
// 核心加载流程
// ---------------------------------------------------------------------------

/**
 * 从多级配置源加载并合并配置。
 *
 * 解析顺序（后加载的优先级更高）：
 *   1. 内置默认值 —— defaultConfig
 *   2. 用户全局 —— ~/.dskcode/settings.json
 *   3. 项目本地 —— .dskcode/settings.json（或通过 --config 指定的路径）
 *   4. 环境变量 —— DEEPSEEK_API_KEY、DSKCODE_* 等
 *   5. CLI flag —— 由调用方通过 applyCliOverrides() 单独注入
 */
export async function loadConfig(configPath?: string): Promise<Config> {
  const filePaths = resolveConfigFiles(configPath);

  let config: Config = structuredClone(defaultConfig);

  // 1-3. 依次加载 JSON 配置文件
  for (const filePath of filePaths) {
    try {
      const raw = await readFile(filePath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<Config>;
      config = mergeConfig(config, parsed);
    } catch {
      // 文件不存在或权限不足 — 静默跳过
    }
  }

  // 4. 环境变量覆盖
  config = applyEnvVars(config);

  return config;
}

/**
 * 加载配置并同时执行校验。
 * 校验错误不会 throw，而是通过返回值中的 errors 字段返回，
 * 由调用方决定如何处理（例如在 middleware 中输出警告）。
 */
export async function loadAndValidate(
  configPath?: string,
): Promise<{ config: Config; errors: ConfigError[] }> {
  const config = await loadConfig(configPath);
  const errors = validateConfig(config);
  return { config, errors };
}

// ---------------------------------------------------------------------------
// 配置热加载（Watch 模式）
// ---------------------------------------------------------------------------

export type ConfigChangeCallback = (config: Config) => void;

/**
 * 监听配置文件变更，在文件被修改时重新加载配置并调用回调。
 *
 * @param callback  配置变更后的回调函数
 * @param configPath  可选，指定配置文件路径（对应 --config flag）
 * @returns  一个 unwatch 函数，调用后可停止监听
 */
export function watchConfig(
  callback: ConfigChangeCallback,
  configPath?: string,
): () => void {
  const filePaths = resolveConfigFiles(configPath).filter((fp) => existsSync(fp));

  // 如果一个文件都不存在，则监听项目本地的 .dskcode/settings.json（即使还没创建）
  if (filePaths.length === 0) {
    filePaths.push(join(process.cwd(), ".dskcode", "settings.json"));
  }

  const watchers: ReturnType<typeof watch>[] = [];
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  for (const filePath of filePaths) {
    try {
      const watcher = watch(filePath, (eventType) => {
        if (eventType !== "change") return;

        // 防抖：多次连续变更只触发一次
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(async () => {
          try {
            const raw = readFile(filePath, "utf-8");
            const config = await loadConfig(configPath);
            callback(config);
          } catch {
            // 重载失败时不回调，等待下一次变更
          }
        }, 300);
      });

      watchers.push(watcher);
    } catch {
      // 无法监听的文件（例如还不存在）— 跳过
    }
  }

  return () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    for (const w of watchers) {
      w.close();
    }
  };
}

// ---------------------------------------------------------------------------
// API Key 持久化
// ---------------------------------------------------------------------------

/**
 * 将 API Key 保存到用户全局配置 ~/.dskcode/settings.json。
 * 如果文件已存在，合并写入；不存在则新建。
 * 返回保存的文件路径。
 */
export async function saveApiKey(apiKey: string): Promise<string> {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "~";
  const configDir = join(home, ".dskcode");
  const configFile = join(configDir, "settings.json");

  // 确保目录存在
  await mkdir(configDir, { recursive: true });

  // 读取现有配置，或从默认配置开始
  let configData: Record<string, unknown>;
  try {
    const raw = await readFile(configFile, "utf-8");
    configData = JSON.parse(raw);
  } catch {
    // 文件不存在，用内置默认值填充（tools、plugins 等都会写入）
    configData = structuredClone(defaultConfig) as unknown as Record<string, unknown>;
  }

  // 更新或创建 deepseek provider
  const providers = (configData.providers as Array<Record<string, unknown>>) ?? [];
  const existing = providers.find((p) => p.name === "deepseek");

  if (existing) {
    existing.apiKey = apiKey;
  } else {
    providers.push({
      name: "deepseek",
      apiKey,
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-flash",
    });
  }

  configData.providers = providers;

  // 写回文件
  await writeFile(configFile, JSON.stringify(configData, null, 2), "utf-8");

  return configFile;
}
