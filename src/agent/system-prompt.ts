// ---------------------------------------------------------------------------
// 系统提示词构建 — 动态注入模型信息、工具描述、时间、项目上下文
// ---------------------------------------------------------------------------

import type { SystemPromptOptions } from "./types.js";

/**
 * 构建 Agent 的系统提示词。
 *
 * 系统提示词按如下顺序组装：
 * 1. 角色定义 — dskcode 是什么
 * 2. 模型信息 — 当前使用的模型
 * 3. 时间上下文 — 当前日期时间
 * 4. 工具描述 — 可用工具列表（如有）
 * 5. 项目上下文 — AGENTS.md 内容（如有）
 * 6. 行为约束 — 回答风格、安全边界
 */
export function buildSystemPrompt(opts: SystemPromptOptions): string {
  const sections: string[] = [];

  // 1. 角色定义
  sections.push(`你是 dskcode，一个基于 DeepSeek 的 AI 编程助手，运行在用户终端中。你的职责是帮助开发者编写、理解、调试和重构代码。

## 核心原则
- 回答使用中文，代码标识符保持英文
- 提供准确、实用、可操作的建议
- 对不确定的内容明确标注，不编造事实
- 代码示例保持简洁，附带必要的注释`);

  // 2. 模型信息
  sections.push(`## 当前模型
- 模型：${opts.model}`);

  // 3. 时间上下文
  const now = new Date();
  const dateStr = now.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  });
  const timeStr = now.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
  sections.push(`## 时间上下文
- 当前日期：${dateStr}
- 当前时间：${timeStr}
- 工作目录：${opts.cwd}`);

  // 4. 工具描述
  if (opts.tools && opts.tools.length > 0) {
    const toolLines = opts.tools
      .map((t) => {
        const paramInfo = t.parameters
          ? Object.keys((t.parameters as Record<string, unknown>).properties ?? {})
              .join(", ")
          : "";
        return `- **${t.name}**：${t.description}${paramInfo ? `（参数：${paramInfo}）` : ""}`;
      })
      .join("\n");
    sections.push(`## 可用工具

你可以通过工具调用执行操作。当前可用的工具：

${toolLines}

调用工具时，请使用标准 function_call 格式。工具将由系统执行并返回结果。`);
  }

  // 5. 项目上下文
  if (opts.projectContext) {
    sections.push(`## 项目上下文

${opts.projectContext}`);
  }

  // 6. 行为约束
  sections.push(`## 行为约束
- 如果用户请求不明确，请主动询问澄清
- 涉及文件操作时，先确认文件路径
- 不执行可能造成不可逆损害的操作（如 rm -rf）除非用户明确确认
- 当工具调用返回错误时，分析原因并尝试修复`);

  return sections.join("\n\n");
}