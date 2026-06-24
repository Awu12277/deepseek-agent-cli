// ---------------------------------------------------------------------------
// 系统提示词构建 — 使用 Handlebars 模板引擎渲染
// ---------------------------------------------------------------------------

import Handlebars from "handlebars";
import type { SystemPromptOptions, ToolDescription } from "./types.js";
import systemPromptTemplate from "./prompts/system-prompt.hbs";

const compiledTemplate = Handlebars.compile(systemPromptTemplate);

interface ToolView {
  name: string;
  description: string;
  params?: string;
}

function formatTools(tools: ToolDescription[]): ToolView[] {
  return tools.map((t) => {
    const params =
      t.parameters &&
      Object.keys((t.parameters as Record<string, unknown>).properties ?? {})
        .join(", ");
    return {
      name: t.name,
      description: t.description,
      params: params || undefined,
    };
  });
}

/**
 * 构建 Agent 的系统提示词。
 *
 * 使用 Handlebars 模板 `prompts/system-prompt.hbs` 渲染，
 * 动态注入模型信息、工具描述、时间、项目上下文。
 */
export function buildSystemPrompt(opts: SystemPromptOptions): string {
  const now = new Date();
  const date = now.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  });
  const time = now.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });

  return compiledTemplate({
    model: opts.model,
    cwd: opts.cwd,
    date,
    time,
    tools: opts.tools ? formatTools(opts.tools) : undefined,
    projectContext: opts.projectContext ?? undefined,
  });
}
