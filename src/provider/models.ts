// ---------------------------------------------------------------------------
// 模型定义与校验
// ---------------------------------------------------------------------------

import type { ModelId, ModelMeta } from "./types.js";

/** 支持的模型及其元数据 */
export const SUPPORTED_MODELS: Record<ModelId, ModelMeta> = {
  "deepseek-v4-flash": {
    id: "deepseek-v4-flash",
    displayName: "DeepSeek V4 Flash",
    /** 上下文窗口大小（token） */
    contextWindow: 1_000_000,
    /** 输入价格（元 / 百万 token，缓存未命中） */
    inputPricePerMillion: 1,
    /** 输出价格（元 / 百万 token） */
    outputPricePerMillion: 2,
    /** 输入价格（元 / 百万 token，缓存命中） */
    cacheHitPricePerMillion: 0.02,
  },
  "deepseek-v4-pro": {
    id: "deepseek-v4-pro",
    displayName: "DeepSeek V4 Pro",
    /** 上下文窗口大小（token） */
    contextWindow: 1_000_000,
    /** 输入价格（元 / 百万 token，缓存未命中） */
    inputPricePerMillion: 3,
    /** 输出价格（元 / 百万 token） */
    outputPricePerMillion: 6,
    /** 输入价格（元 / 百万 token，缓存命中） */
    cacheHitPricePerMillion: 0.025,
  },
};

/** 支持的模型 ID 列表 */
export const SUPPORTED_MODEL_IDS: string[] = Object.keys(SUPPORTED_MODELS);

/**
 * 判断模型标识是否受支持。
 * dskcode 仅支持 deepseek-v4-flash 和 deepseek-v4-pro 两个模型。
 */
export function isSupportedModel(model: string): model is ModelId {
  return model in SUPPORTED_MODELS;
}

/** 获取模型元数据（已校验） */
export function getModelMeta(model: ModelId): ModelMeta {
  return SUPPORTED_MODELS[model];
}

/**
 * CJK 字符 Unicode 范围检测。
 * 覆盖 CJK 统一汉字、扩展 A/B、兼容汉字等。
 */
function isCJK(char: string): boolean {
  const code = char.codePointAt(0)!;
  // CJK 统一汉字
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||
    // CJK 扩展 A
    (code >= 0x3400 && code <= 0x4dbf) ||
    // CJK 扩展 B 及其他
    (code >= 0x20000 && code <= 0x2a6df) ||
    // CJK 兼容汉字
    (code >= 0xf900 && code <= 0xfaff) ||
    // 全角字符
    (code >= 0xff01 && code <= 0xff60)
  );
}

/**
 * 估算文本的 token 数量。
 *
 * 根据 DeepSeek 官方文档的换算比例：
 * - 1 个英文字符 ≈ 0.3 个 token（即约 3.3 个字符 ≈ 1 token）
 * - 1 个中文字符 ≈ 0.6 个 token（即约 1.7 个字符 ≈ 1 token）
 *
 * 对文本中的 CJK 和非 CJK 字符分别估算后求和。
 */
export function estimateTokens(text: string): number {
  let cjkCount = 0;
  let otherCount = 0;
  for (const char of text) {
    if (isCJK(char)) {
      cjkCount++;
    } else {
      otherCount++;
    }
  }
  // CJK: 1 字符 ≈ 0.6 token → token 数 ≈ cjkCount × 0.6
  // 其他: 1 字符 ≈ 0.3 token → token 数 ≈ otherCount × 0.3
  const tokens = cjkCount * 0.6 + otherCount * 0.3;
  return Math.max(1, Math.ceil(tokens));
}

// ---------------------------------------------------------------------------
// 费用计算
// ---------------------------------------------------------------------------

import type { UsageInfo, CostInfo } from "./types.js";

/**
 * 根据模型和 Token 使用量计算费用。
 *
 * 计费公式：
 *   输入费用（缓存未命中） = (promptTokens - cachedPromptTokens) × inputPrice / 1,000,000
 *   缓存命中费用         = cachedPromptTokens × cacheHitPrice / 1,000,000
 *   输出费用             = completionTokens × outputPrice / 1,000,000
 *   总费用               = 输入费用 + 缓存命中费用 + 输出费用
 *
 * @param usage   Token 使用统计
 * @param model   模型标识
 * @returns       费用明细（单位：元）
 */
export function calculateCost(usage: UsageInfo, model: ModelId): CostInfo {
  const meta = SUPPORTED_MODELS[model];
  const cached = usage.cachedPromptTokens ?? 0;
  const nonCached = usage.promptTokens - cached;

  const inputCost = (nonCached * meta.inputPricePerMillion) / 1_000_000;
  const cacheHitCost = (cached * meta.cacheHitPricePerMillion) / 1_000_000;
  const outputCost = (usage.completionTokens * meta.outputPricePerMillion) / 1_000_000;

  return {
    inputCost,
    cacheHitCost,
    outputCost,
    totalCost: inputCost + cacheHitCost + outputCost,
  };
}

/**
 * 将费用格式化为易读的字符串，保留4位小数。
 */
export function formatCost(cost: CostInfo): string {
  return `≈¥${cost.totalCost.toFixed(4)}`;
}