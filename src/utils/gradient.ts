// ---------------------------------------------------------------------------
// 渐变色工具 — 用于占位符从左到右的渐变动画
// ---------------------------------------------------------------------------

/** RGB 色标元组 [R, G, B]，每个值 0~255 */
export type ColorStop = [number, number, number];

// ---- 预设渐变方案 ----

/** 空闲占位符渐变：赛博朋克绿 → 青 → 紫 */
export const IDLE_GRADIENT_STOPS: ColorStop[] = [
  [0, 255, 65],    // #00ff41
  [0, 255, 255],   // #00ffff
  [189, 147, 249], // #bd93f9
];

/** 命令提示条渐变：浅柠黄 → 暖黄 → 橙色（从左到右流动） */
export const CMD_TIP_GRADIENT_STOPS: ColorStop[] = [
  [255, 245, 180], // #fff5b4 浅柠黄
  [255, 210, 80],  // #ffd250 暖黄
  [255, 150, 50],  // #ff9632 橙色
];

/** 流式占位符渐变：琥珀 → 焦糖 → 棕红 */
export const STREAMING_GRADIENT_STOPS: ColorStop[] = [
  [255, 191, 0],   // #ffbf00 琥珀金
  [210, 140, 60],  // #d28c3c 焦糖
  [175, 70, 40],   // #af4628 棕红
];

// ---- 渐变动画配置 ----

/** 动画参数：每帧相位增量 & 帧间隔（ms） */
export const GRADIENT_ANIMATION = {
  /** 空闲占位符动画：每帧相位步进（值越大流速越快） */
  idlePhaseStep: 0.06,
  /** 空闲占位符动画：帧间隔（ms） */
  idleInterval: 200,
  /** 流式占位符动画：每帧相位步进 */
  streamingPhaseStep: 0.2,
  /** 流式占位符动画：帧间隔（ms） */
  streamingInterval: 200,
  /** 命令提示条动画：每帧相位步进 */
  cmdTipPhaseStep: 0.2,
  /** 命令提示条动画：帧间隔（ms） */
  cmdTipInterval: 200,
} as const;

// ---- 渲染时跳过着色的字符 ----

/** 不参与渐变着色的字符（空格、标点、emoji 等） */
export const SKIP_CHARS = new Set([" ", "~", ".", "。", "！", "👇"]);

// ---- 核心算法 ----

/** 根据 t(0~1) 在色标间线性插值，返回 hex 色值 */
export function lerpStopsToHex(t: number, stops: readonly ColorStop[]): string {
  const len = stops.length;
  const segment = t * (len - 1);
  const idx = Math.min(Math.floor(segment), len - 2);
  const frac = segment - idx;
  const stop = stops[idx];
  const nextStop = stops[idx + 1];
  if (!stop || !nextStop) return "#808080";
  const r = Math.round(stop[0] + (nextStop[0] - stop[0]) * frac);
  const g = Math.round(stop[1] + (nextStop[1] - stop[1]) * frac);
  const b = Math.round(stop[2] + (nextStop[2] - stop[2]) * frac);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

/** 对文本计算逐字渐变色数组，phase 控制色彩偏移位置（0~1） */
export function getGradientColors(
  text: string,
  phase: number,
  stops: readonly ColorStop[],
): string[] {
  const len = text.length;
  if (len === 0) return [];
  return text.split("").map((ch, i) => {
    if (SKIP_CHARS.has(ch)) return "";
    const t = ((i / (len - 1)) + phase) % 1;
    return lerpStopsToHex(t, stops);
  });
}