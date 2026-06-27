// ---------------------------------------------------------------------------
// buildToolDefinitions — 纯计算层：把 ToolRegistry 转成 Provider 需要的工具定义
//
// 设计原则：
// - 纯函数：无副作用，输入 registry + mode → ToolDefinition[]
// - mode 为 "plan" 时只暴露只读工具，强制走「只读 → 计划」模式
//
// 函数注释规范见仓库根 AGENTS.md「函数注释规范」一节。
// ---------------------------------------------------------------------------

import type { ToolDefinition } from "../provider/index.js";
import type { ToolRegistry } from "../tool/registry.js";
import type { SessionMode } from "./types.js";

/**
 * 构建 Provider 工具定义（喂给 provider.chat() 的 tools 字段）。
 *
 * 行为：
 * - mode === "plan"：只列出只读工具（read_file / list_dir / grep / ...）
 * - mode === "code"：列出全部启用工具
 *
 * @param registry — 工具注册表
 * @param mode — 会话模式（"plan" → 只读；"code" → 全部）
 * @returns Provider 兼容的 ToolDefinition 数组
 *
 * @pure 无副作用：仅读 registry 状态，不修改任何东西
 */
export function buildToolDefinitions(
  registry: ToolRegistry,
  mode: SessionMode,
): ToolDefinition[] {
  const tools = mode === "plan" ? registry.listReadTools() : registry.list();
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters as unknown as Record<string, unknown>,
    },
  }));
}
