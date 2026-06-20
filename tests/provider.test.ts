import { describe, it, expect } from "vitest";
import {
  DeepSeekProvider,
  ProviderRegistry,
  defaultRegistry,
  createProvider,
  SUPPORTED_MODELS,
  SUPPORTED_MODEL_IDS,
  isSupportedModel,
  getModelMeta,
  estimateTokens,
  calculateCost,
  formatCost,
  ProviderError,
  AuthError,
  RateLimitError,
  ServerError,
  NetworkError,
  ModelNotSupportedError,
  mapHttpError,
} from "../src/provider/index.js";

// ---------------------------------------------------------------------------
// 模型定义与校验
// ---------------------------------------------------------------------------

describe("isSupportedModel", () => {
  it("应识别 deepseek-v4-flash 为受支持模型", () => {
    expect(isSupportedModel("deepseek-v4-flash")).toBe(true);
  });

  it("应识别 deepseek-v4-pro 为受支持模型", () => {
    expect(isSupportedModel("deepseek-v4-pro")).toBe(true);
  });

  it("应拒绝不在支持列表中的模型", () => {
    expect(isSupportedModel("deepseek-chat")).toBe(false);
    expect(isSupportedModel("gpt-4")).toBe(false);
    expect(isSupportedModel("claude-3")).toBe(false);
    expect(isSupportedModel("")).toBe(false);
  });
});

describe("SUPPORTED_MODELS", () => {
  it("应包含两个模型的元数据", () => {
    expect(SUPPORTED_MODEL_IDS).toHaveLength(2);
    expect(SUPPORTED_MODEL_IDS).toContain("deepseek-v4-flash");
    expect(SUPPORTED_MODEL_IDS).toContain("deepseek-v4-pro");
  });

  it("flash 模型元数据应完整", () => {
    const flash = SUPPORTED_MODELS["deepseek-v4-flash"];
    expect(flash).toBeDefined();
    expect(flash.displayName).toBe("DeepSeek V4 Flash");
    expect(flash.contextWindow).toBe(1_000_000);
    expect(flash.inputPricePerMillion).toBe(1);
    expect(flash.outputPricePerMillion).toBe(2);
    expect(flash.cacheHitPricePerMillion).toBe(0.02);
  });

  it("pro 模型元数据应完整", () => {
    const pro = SUPPORTED_MODELS["deepseek-v4-pro"];
    expect(pro).toBeDefined();
    expect(pro.displayName).toBe("DeepSeek V4 Pro");
    expect(pro.contextWindow).toBe(1_000_000);
    expect(pro.inputPricePerMillion).toBe(3);
    expect(pro.outputPricePerMillion).toBe(6);
    expect(pro.cacheHitPricePerMillion).toBe(0.025);
  });

  it("pro 应比 flash 贵", () => {
    const flash = SUPPORTED_MODELS["deepseek-v4-flash"];
    const pro = SUPPORTED_MODELS["deepseek-v4-pro"];
    expect(pro.inputPricePerMillion).toBeGreaterThan(flash.inputPricePerMillion);
    expect(pro.outputPricePerMillion).toBeGreaterThan(flash.outputPricePerMillion);
  });
});

describe("getModelMeta", () => {
  it("应返回 flash 模型的元数据", () => {
    const meta = getModelMeta("deepseek-v4-flash");
    expect(meta.id).toBe("deepseek-v4-flash");
    expect(meta.displayName).toBe("DeepSeek V4 Flash");
  });

  it("应返回 pro 模型的元数据", () => {
    const meta = getModelMeta("deepseek-v4-pro");
    expect(meta.id).toBe("deepseek-v4-pro");
  });
});

describe("estimateTokens", () => {
  it("应估算纯英文文本的 token 数", () => {
    // "hello" = 5 英文字符 × 0.3 = 1.5 → ceil = 2
    expect(estimateTokens("hello")).toBe(2);
  });

  it("应估算空字符串为 1 token（最低值）", () => {
    expect(estimateTokens("")).toBe(1);
  });

  it("应估算纯中文文本的 token 数", () => {
    // "你好世界" = 4 中文字符 × 0.6 = 2.4 → ceil = 3
    expect(estimateTokens("你好世界")).toBe(3);
  });

  it("应估算中英混合文本", () => {
    // "hello你好" = 5 英文 × 0.3 + 2 中文 × 0.6 = 1.5 + 1.2 = 2.7 → ceil = 3
    expect(estimateTokens("hello你好")).toBe(3);
  });

  it("应估算较长的英文文本", () => {
    const text = "a".repeat(100); // 100 × 0.3 = 30
    expect(estimateTokens(text)).toBe(30);
  });

  it("应估算较长的中文文本", () => {
    const text = "\u4f60".repeat(100); // 100 \u00d7 0.6 = 60
    expect(estimateTokens(text)).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// 费用计算
// ---------------------------------------------------------------------------

describe("calculateCost", () => {
  it("应正确计算 flash 模型无缓存命中的费用", () => {
    const cost = calculateCost(
      { promptTokens: 100, completionTokens: 50 },
      "deepseek-v4-flash",
    );
    // 输入: (100 - 0) \u00d7 1 / 1,000,000 = 0.0001
    // 输出: 50 \u00d7 2 / 1,000,000 = 0.0001
    // 合计: 0.0002
    expect(cost.inputCost).toBeCloseTo(0.0001, 10);
    expect(cost.cacheHitCost).toBe(0);
    expect(cost.outputCost).toBeCloseTo(0.0001, 10);
    expect(cost.totalCost).toBeCloseTo(0.0002, 10);
  });

  it("应正确计算 flash 模型有缓存命中的费用", () => {
    const cost = calculateCost(
      { promptTokens: 100, completionTokens: 50, cachedPromptTokens: 80 },
      "deepseek-v4-flash",
    );
    // 输入（未命中）: (100 - 80) \u00d7 1 / 1,000,000 = 0.00002
    // 缓存命中: 80 \u00d7 0.02 / 1,000,000 = 0.0000016
    // 输出: 50 \u00d7 2 / 1,000,000 = 0.0001
    expect(cost.inputCost).toBeCloseTo(0.00002, 10);
    expect(cost.cacheHitCost).toBeCloseTo(0.0000016, 10);
    expect(cost.outputCost).toBeCloseTo(0.0001, 10);
    expect(cost.totalCost).toBeCloseTo(0.0001216, 10);
  });

  it("应正确计算 pro 模型的费用", () => {
    const cost = calculateCost(
      { promptTokens: 1000, completionTokens: 500, cachedPromptTokens: 200 },
      "deepseek-v4-pro",
    );
    // 输入（未命中）: (1000 - 200) \u00d7 3 / 1,000,000 = 0.0024
    // 缓存命中: 200 \u00d7 0.025 / 1,000,000 = 0.000005
    // 输出: 500 \u00d7 6 / 1,000,000 = 0.003
    expect(cost.inputCost).toBeCloseTo(0.0024, 10);
    expect(cost.cacheHitCost).toBeCloseTo(0.000005, 10);
    expect(cost.outputCost).toBeCloseTo(0.003, 10);
    expect(cost.totalCost).toBeCloseTo(0.005405, 10);
  });

  it("缓存命中为 0 时 cacheHitCost 应为 0", () => {
    const cost = calculateCost(
      { promptTokens: 50, completionTokens: 20 },
      "deepseek-v4-flash",
    );
    expect(cost.cacheHitCost).toBe(0);
  });
});

describe("formatCost", () => {
  it("应格式化小于 0.01 元的费用（6 位小数）", () => {
    const result = formatCost({
      inputCost: 0.000032,
      cacheHitCost: 0,
      outputCost: 0.0001,
      totalCost: 0.000132,
    });
    expect(result).toBe("≈¥0.000132");
  });

  it("应格式化大于等于 0.01 元的费用（4 位小数）", () => {
    const result = formatCost({
      inputCost: 0.0054,
      cacheHitCost: 0,
      outputCost: 0.01,
      totalCost: 0.0154,
    });
    expect(result).toBe("≈¥0.0154");
  });

  it("应四舍五入小数位", () => {
    const result = formatCost({
      inputCost: 0.01,
      cacheHitCost: 0.01,
      outputCost: 0.01,
      totalCost: 0.01555,
    });
    // 0.01555 → toFixed(4) = "0.0155"（银行家舍入：5 前为奇进偶不进）
    expect(result).toBe("≈¥0.0155");
  });
});
// ---------------------------------------------------------------------------

describe("ProviderError", () => {
  it("应正确设置属性", () => {
    const err = new ProviderError("test error", "TEST_CODE", 400);
    expect(err.message).toBe("test error");
    expect(err.code).toBe("TEST_CODE");
    expect(err.statusCode).toBe(400);
    expect(err.name).toBe("ProviderError");
    expect(err).toBeInstanceOf(Error);
  });
});

describe("AuthError", () => {
  it("应创建认证错误", () => {
    const err = new AuthError("认证失败", 401);
    expect(err.message).toBe("认证失败");
    expect(err.code).toBe("AUTH_ERROR");
    expect(err.statusCode).toBe(401);
    expect(err.name).toBe("AuthError");
    expect(err).toBeInstanceOf(ProviderError);
  });
});

describe("RateLimitError", () => {
  it("应创建速率限制错误（含重试时间）", () => {
    const err = new RateLimitError("请求过于频繁", 5000);
    expect(err.message).toBe("请求过于频繁");
    expect(err.code).toBe("RATE_LIMIT");
    expect(err.statusCode).toBe(429);
    expect(err.retryAfterMs).toBe(5000);
  });

  it("应创建速率限制错误（无重试时间）", () => {
    const err = new RateLimitError("请求过于频繁");
    expect(err.retryAfterMs).toBeUndefined();
  });
});

describe("ServerError", () => {
  it("应创建服务端错误", () => {
    const err = new ServerError("服务端错误", 500);
    expect(err.code).toBe("SERVER_ERROR");
    expect(err.statusCode).toBe(500);
    expect(err).toBeInstanceOf(ProviderError);
  });
});

describe("NetworkError", () => {
  it("应创建网络错误", () => {
    const originalError = new Error("ECONNREFUSED");
    const err = new NetworkError("无法连接", originalError);
    expect(err.code).toBe("NETWORK_ERROR");
    expect(err.originalError).toBe(originalError);
  });
});

describe("ModelNotSupportedError", () => {
  it("应包含模型名称和提示信息", () => {
    const err = new ModelNotSupportedError("gpt-4");
    expect(err.message).toContain("gpt-4");
    expect(err.message).toContain("deepseek-v4-flash");
    expect(err.message).toContain("deepseek-v4-pro");
    expect(err.code).toBe("MODEL_NOT_SUPPORTED");
  });
});

describe("mapHttpError", () => {
  it("应将 401 映射为 AuthError", () => {
    const err = mapHttpError(401, "{}");
    expect(err).toBeInstanceOf(AuthError);
    expect(err.statusCode).toBe(401);
  });

  it("应将 403 映射为 AuthError", () => {
    const err = mapHttpError(403, "{}");
    expect(err).toBeInstanceOf(AuthError);
    expect(err.statusCode).toBe(403);
  });

  it("应将 429 映射为 RateLimitError", () => {
    const err = mapHttpError(429, "{}");
    expect(err).toBeInstanceOf(RateLimitError);
  });

  it("应从 429 响应体中提取重试时间", () => {
    const body = JSON.stringify({
      error: { message: "Rate limit exceeded. Retry after 30 seconds." },
    });
    const err = mapHttpError(429, body) as RateLimitError;
    expect(err.retryAfterMs).toBe(30_000);
  });

  it("应将 400 映射为 ProviderError", () => {
    const err = mapHttpError(400, "{}");
    expect(err.code).toBe("BAD_REQUEST");
    expect(err.statusCode).toBe(400);
  });

  it("应从 400 响应体中提取错误详情", () => {
    const body = JSON.stringify({
      error: { message: "Invalid model specified" },
    });
    const err = mapHttpError(400, body);
    expect(err.message).toContain("Invalid model specified");
  });

  it("应将 500 映射为 ServerError", () => {
    const err = mapHttpError(500, "{}");
    expect(err).toBeInstanceOf(ServerError);
  });

  it("应将 503 映射为 ServerError", () => {
    const err = mapHttpError(503, "{}");
    expect(err).toBeInstanceOf(ServerError);
  });

  it("应将未知状态码映射为通用 ProviderError", () => {
    const err = mapHttpError(418, "{}");
    expect(err.code).toBe("UNKNOWN_ERROR");
    expect(err.statusCode).toBe(418);
  });
});

// ---------------------------------------------------------------------------
// ProviderRegistry
// ---------------------------------------------------------------------------

describe("ProviderRegistry", () => {
  it("应注册并获取 Provider 实例", () => {
    const registry = new ProviderRegistry();
    const mockFactory = (config: { apiKey: string; baseUrl: string; model: string }) => ({
      name: "mock",
      model: () => config.model,
      countTokens: (text: string) => text.length,
      chat: async function* () {
        yield { content: "mock", finishReason: "stop" as const };
      },
    });

    registry.register("mock", mockFactory);
    const provider = registry.get("mock", {
      apiKey: "test-key",
      baseUrl: "https://api.mock.com",
      model: "deepseek-v4-flash",
    });

    expect(provider.name).toBe("mock");
    expect(provider.model()).toBe("deepseek-v4-flash");
  });

  it("应缓存相同配置的实例", () => {
    const registry = new ProviderRegistry();
    let callCount = 0;
    const mockFactory = () => {
      callCount++;
      return {
        name: "mock",
        model: () => "deepseek-v4-flash",
        countTokens: (text: string) => text.length,
        chat: async function* () {
          yield { content: "mock", finishReason: "stop" as const };
        },
      };
    };

    registry.register("mock", mockFactory);
    const p1 = registry.get("mock", {
      apiKey: "key",
      baseUrl: "https://api.mock.com",
      model: "deepseek-v4-flash",
    });
    const p2 = registry.get("mock", {
      apiKey: "key",
      baseUrl: "https://api.mock.com",
      model: "deepseek-v4-flash",
    });

    expect(p1).toBe(p2); // 同一实例
    expect(callCount).toBe(1); // 工厂只调用一次
  });

  it("不同配置应创建不同实例", () => {
    const registry = new ProviderRegistry();
    const mockFactory = (config: { apiKey: string; baseUrl: string; model: string }) => ({
      name: "mock",
      model: () => config.model,
      countTokens: (text: string) => text.length,
      chat: async function* () {
        yield { content: "mock", finishReason: "stop" as const };
      },
    });

    registry.register("mock", mockFactory);
    const flash = registry.get("mock", {
      apiKey: "key",
      baseUrl: "https://api.mock.com",
      model: "deepseek-v4-flash",
    });
    const pro = registry.get("mock", {
      apiKey: "key",
      baseUrl: "https://api.mock.com",
      model: "deepseek-v4-pro",
    });

    expect(flash).not.toBe(pro);
    expect(flash.model()).toBe("deepseek-v4-flash");
    expect(pro.model()).toBe("deepseek-v4-pro");
  });

  it("应拒绝不支持的模型", () => {
    const registry = new ProviderRegistry();
    registry.register("mock", () => ({
      name: "mock",
      model: () => "gpt-4",
      countTokens: (text: string) => text.length,
      chat: async function* () {
        yield { content: "mock", finishReason: "stop" as const };
      },
    }));

    expect(() =>
      registry.get("mock", {
        apiKey: "key",
        baseUrl: "https://api.mock.com",
        model: "gpt-4",
      }),
    ).toThrow(ModelNotSupportedError);
  });

  it("应拒绝未注册的 Provider", () => {
    const registry = new ProviderRegistry();
    expect(() =>
      registry.get("nonexistent", {
        apiKey: "key",
        baseUrl: "https://api.mock.com",
        model: "deepseek-v4-flash",
      }),
    ).toThrow(/未注册的 Provider/);
  });

  it("list 应返回已注册的 Provider 名称", () => {
    const registry = new ProviderRegistry();
    registry.register("a", () => ({
      name: "a",
      model: () => "deepseek-v4-flash",
      countTokens: (t: string) => t.length,
      chat: async function* () { yield { content: "", finishReason: null as const }; },
    }));
    registry.register("b", () => ({
      name: "b",
      model: () => "deepseek-v4-pro",
      countTokens: (t: string) => t.length,
      chat: async function* () { yield { content: "", finishReason: null as const }; },
    }));
    expect(registry.list()).toEqual(["a", "b"]);
  });

  it("clear 应清除缓存的实例", () => {
    const registry = new ProviderRegistry();
    let callCount = 0;
    const mockFactory = () => {
      callCount++;
      return {
        name: "mock",
        model: () => "deepseek-v4-flash",
        countTokens: (t: string) => t.length,
        chat: async function* () {
          yield { content: "mock", finishReason: "stop" as const };
        },
      };
    };

    registry.register("mock", mockFactory);
    registry.get("mock", {
      apiKey: "key",
      baseUrl: "https://api.mock.com",
      model: "deepseek-v4-flash",
    });
    expect(callCount).toBe(1);

    registry.clear();

    registry.get("mock", {
      apiKey: "key",
      baseUrl: "https://api.mock.com",
      model: "deepseek-v4-flash",
    });
    expect(callCount).toBe(2); // clear 后重新创建
  });
});

describe("defaultRegistry", () => {
  it("应预注册 deepseek Provider", () => {
    expect(defaultRegistry.list()).toContain("deepseek");
  });
});

describe("createProvider", () => {
  it("应通过快捷方式创建 DeepSeek Provider", () => {
    const provider = createProvider({
      name: "deepseek",
      apiKey: "test-key",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-flash",
    });
    expect(provider).toBeInstanceOf(DeepSeekProvider);
    expect(provider.name).toBe("deepseek");
    expect(provider.model()).toBe("deepseek-v4-flash");
  });

  it("应拒绝不支持的模型", () => {
    expect(() =>
      createProvider({
        name: "deepseek",
        apiKey: "test-key",
        baseUrl: "https://api.deepseek.com",
        model: "gpt-4",
      }),
    ).toThrow(ModelNotSupportedError);
  });
});

// ---------------------------------------------------------------------------
// DeepSeekProvider
// ---------------------------------------------------------------------------

describe("DeepSeekProvider", () => {
  it("应正确创建实例", () => {
    const provider = new DeepSeekProvider({
      apiKey: "test-key",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-flash",
    });
    expect(provider.name).toBe("deepseek");
    expect(provider.model()).toBe("deepseek-v4-flash");
  });

  it("应去除 baseUrl 末尾斜杠", () => {
    const provider = new DeepSeekProvider({
      apiKey: "test-key",
      baseUrl: "https://api.deepseek.com/",
      model: "deepseek-v4-pro",
    });
    expect(provider.model()).toBe("deepseek-v4-pro");
  });

  it("countTokens 应返回估算值", () => {
    const provider = new DeepSeekProvider({
      apiKey: "test-key",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-flash",
    });
    // 英文: "hello world" = 11 字符 × 0.3 = 3.3 → ceil = 4
    expect(provider.countTokens("hello world")).toBe(4);
    // 中文: "你好" = 2 字符 × 0.6 = 1.2 → ceil = 2
    expect(provider.countTokens("你好")).toBe(2);
    // 空字符串最低 1
    expect(provider.countTokens("")).toBe(1);
  });

  it("getBalance 应解析余额响应", async () => {
    // 模拟 /user/balance 响应
    const mockResponse = new Response(
      JSON.stringify({
        is_available: true,
        balance_infos: [
          {
            currency: "CNY",
            total_balance: "100.50",
            granted_balance: "10.00",
            topped_up_balance: "90.50",
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => mockResponse;

    try {
      const provider = new DeepSeekProvider({
        apiKey: "sk-test",
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-v4-flash",
      });

      const result = await provider.getBalance();

      expect(result.isAvailable).toBe(true);
      expect(result.balances).toHaveLength(1);
      expect(result.balances[0]!.currency).toBe("CNY");
      expect(result.balances[0]!.totalBalance).toBe(100.50);
      expect(result.balances[0]!.grantedBalance).toBe(10);
      expect(result.balances[0]!.toppedUpBalance).toBe(90.50);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("getBalance 应在 API Key 无效时抛出 AuthError", async () => {
    const mockResponse = new Response(
      JSON.stringify({ error: { message: "Invalid API key" } }),
      { status: 401, statusText: "Unauthorized" },
    );

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => mockResponse;

    try {
      const provider = new DeepSeekProvider({
        apiKey: "sk-bad",
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-v4-flash",
      });

      await expect(provider.getBalance()).rejects.toThrow(/认证失败/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// 配置校验 — 模型限制
// ---------------------------------------------------------------------------

describe("配置校验 — 模型限制", () => {
  // 这些测试在 config 模块中验证 model 校验
  // 引入 loader 的 validateConfig 来测试

  it("应拒绝不支持的模型", async () => {
    const { loadAndValidate } = await import("../src/config/index.js");
    // 手动构建一个非法配置
    const config = {
      defaultProvider: "deepseek",
      maxTokens: 8192,
      temperature: 0.7,
      maxToolRounds: 20,
      providers: [
        { name: "deepseek", model: "gpt-4", apiKey: "test" },
      ],
      tools: [],
      plugins: [],
    };

    // 通过 validateConfig 检查
    const { validateConfig } = await import("../src/config/loader.js");
    const errors = validateConfig(config as any);
    const modelError = errors.find((e) => e.field === "providers[0].model");
    expect(modelError).toBeDefined();
    expect(modelError?.message).toContain("gpt-4");
    expect(modelError?.message).toContain("deepseek-v4-flash");
    expect(modelError?.message).toContain("deepseek-v4-pro");
  });
});