// ---------------------------------------------------------------------------
// fetch 工具 — HTTP 请求
// ---------------------------------------------------------------------------

import { ToolKind, type AgentTool, type ToolContext, type ToolResult } from "../types.js";
import { truncateOutput } from "../sandbox.js";

/** fetch 工具的参数格式 */
export interface FetchArgs {
  /** 请求 URL */
  url: string;
  /** 请求方法，默认 GET */
  method?: string;
  /** 请求头 */
  headers?: Record<string, string>;
  /** 请求体（POST/PUT 时使用） */
  body?: string;
  /** 响应最大长度（字符），默认 50000 */
  max_length?: number;
}

/**
 * fetch 工具 — 发起 HTTP 请求并返回响应内容。
 */
export const fetchTool: AgentTool<FetchArgs> = {
  name: "fetch",
  kind: ToolKind.Read,
  description:
    "发起 HTTP 请求并返回响应内容。支持自定义方法和请求头。适用于获取网页内容、API 调用等场景。",
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "请求的 URL",
      },
      method: {
        type: "string",
        description: "HTTP 方法（GET、POST、PUT、DELETE 等），默认 GET",
      },
      headers: {
        type: "object",
        description: "请求头键值对",
        additionalProperties: { type: "string" },
      },
      body: {
        type: "string",
        description: "请求体内容（POST/PUT 时使用）",
      },
      max_length: {
        type: "number",
        description: "响应内容最大长度（字符），默认 50000",
      },
    },
    required: ["url"],
    additionalProperties: false,
  },

  async execute(args: FetchArgs, ctx: ToolContext): Promise<ToolResult> {
    if (!args?.url || typeof args.url !== "string") {
      return { success: false, data: "缺少必要参数 url", error: "INVALID_ARGS" };
    }

    const method = (args.method ?? "GET").toUpperCase();
    const timeout = 30_000;
    const maxLength = args.max_length ?? 50_000;

    try {
      const fetchOptions: RequestInit = {
        method,
        headers: args.headers ?? {},
        signal: ctx.signal ?? AbortSignal.timeout(timeout),
      };

      if (args.body && (method === "POST" || method === "PUT" || method === "PATCH")) {
        (fetchOptions.headers as Record<string, string>)["Content-Type"] ??= "application/json";
        fetchOptions.body = args.body;
      }

      const response = await fetch(args.url, fetchOptions);

      const contentType = response.headers.get("content-type") ?? "unknown";
      const statusText = `${response.status} ${response.statusText}`;

      let body: string;
      try {
        body = await response.text();
      } catch {
        body = "(无法读取响应体)";
      }

      const truncatedBody = truncateOutput(body, maxLength);

      const header = `状态: ${statusText}\n内容类型: ${contentType}`;
      const separator = body.length > 0 ? "\n---\n" : "";

      const urlPreview = args.url.length > 60
        ? args.url.slice(0, 57) + "..."
        : args.url;
      const summary = `🌐 ${method} ${urlPreview} → ${response.status}`;

      return {
        success: response.ok,
        data: `${header}${separator}${truncatedBody}`,
        summary,
        error: response.ok ? undefined : `HTTP_${response.status}`,
      };
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") {
        return { success: false, data: "请求被中止", error: "ABORTED" };
      }
      if (err instanceof TypeError && err.message.includes("fetch")) {
        return { success: false, data: `网络错误：${err.message}`, error: "NETWORK_ERROR" };
      }
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        data: `HTTP 请求失败：${message}`,
        error: "FETCH_ERROR",
      };
    }
  },
};
