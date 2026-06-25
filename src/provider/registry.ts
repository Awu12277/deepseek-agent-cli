// ---------------------------------------------------------------------------
// Provider 注册表 — 工厂模式管理 Provider 实例
// ---------------------------------------------------------------------------

import type { Provider, ModelId } from "./types.js";
import { isSupportedModel } from "./models.js";
import { ModelNotSupportedError } from "./errors.js";
import { DeepSeekProvider } from "./deepseek.js";

/** Provider 工厂函数类型 */
export type ProviderFactory = (config: {
  apiKey: string;
  baseUrl: string;
  model: string;
}) => Provider;

/**
 * Provider 注册表 — 工厂模式管理 Provider 实例。
 *
 * 使用方式：
 * ```ts
 * const provider = registry.get("deepseek", { apiKey, baseUrl, model });
 * for await (const chunk of provider.chat(messages)) { ... }
 * ```
 */
export class ProviderRegistry {
  readonly #factories = new Map<string, ProviderFactory>();
  readonly #instances = new Map<string, Provider>();

  /** 注册一个 Provider 工厂 */
  register(name: string, factory: ProviderFactory): void {
    this.#factories.set(name, factory);
  }

  /**
   * 获取或创建一个 Provider 实例（单例）。
   *
   * 相同的 name + baseUrl + model 组合会复用同一实例。
   * 如果 model 不在支持列表中，抛出 ModelNotSupportedError。
   */
  get(
    name: string,
    config: { apiKey: string; baseUrl: string; model: string },
  ): Provider {
    if (!isSupportedModel(config.model)) {
      throw new ModelNotSupportedError(config.model);
    }

    // 缓存键 = name:baseUrl:model（不同配置会创建不同实例）
    const cacheKey = `${name}:${config.baseUrl}:${config.model}`;

    const cached = this.#instances.get(cacheKey);
    if (cached) return cached;

    const factory = this.#factories.get(name);
    if (!factory) {
      const available = [...this.#factories.keys()].join(", ");
      throw new Error(`未注册的 Provider: "${name}"。可用: ${available}`);
    }

    const instance = factory(config);
    this.#instances.set(cacheKey, instance);
    return instance;
  }

  /** 列出已注册的 Provider 名称 */
  list(): string[] {
    return [...this.#factories.keys()];
  }

  /** 清除缓存的实例（用于配置热重载） */
  clear(): void {
    this.#instances.clear();
  }
}

// ---------------------------------------------------------------------------
// 全局默认注册表 + 预注册内置 Provider
// ---------------------------------------------------------------------------

/** 全局默认 Provider 注册表 */
export const defaultRegistry = new ProviderRegistry();

defaultRegistry.register("deepseek", (config) => {
  // 模型合法性已在 registry.get() 中通过 isSupportedModel 校验
  return new DeepSeekProvider({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    model: config.model as unknown as ModelId,
  });
});

/**
 * 从配置快速创建 Provider 实例的快捷方式。
 *
 * 内部委托给 defaultRegistry，会在注册表中校验模型并缓存实例。
 */
export function createProvider(config: {
  name: string;
  apiKey: string;
  baseUrl: string;
  model: string;
}): Provider {
  return defaultRegistry.get(config.name, config);
}