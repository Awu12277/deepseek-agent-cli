// ---------------------------------------------------------------------------
// fetch 工具 — HTTP 请求
// ---------------------------------------------------------------------------

import type { Tool, ToolContext, ToolResult, JSONSchema } from "../types.js";
import { truncateOutput } from "../sandbox.js";

/** fetch 工具的参数格式 */
interface FetchArgs {
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

/** fetch 工具的参数 JSON Schema */
const fetchSchema: JSONSchema = {
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
};

/**
 * fetch 工具 — 发起 HTTP 请求并返回响应内容。
 *
 * 功能：
 * - 支持 GET/POST/PUT/DELETE 等 HTTP 方法
 * - 自定义请求头和请求体
 * - 超时控制（默认 30 秒）
 * - 响应大小限制
 * - 显示响应状态码和内容类型
 */
export const fetchTool: Tool = {
  name: "fetch",
  description:
    "发起 HTTP 请求并返回响应内容。支持自定义方法和请求头。适用于获取网页内容、API 调用等场景。",
  parameters: fetchSchema,

  async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const params = args as FetchArgs;
    if (!params?.url || typeof params.url !== "string") {
      return { success: false, data: "缺少必要参数 url", error: "INVALID_ARGS" };
    }

    const method = (params.method ?? "GET").toUpperCase();
    const timeout = 30_000;
    const maxLength = params.max_length ?? 50_000;

    try {
      // 构建请求
      const fetchOptions: RequestInit = {
        method,
        headers: params.headers ?? {},
        signal: ctx.signal ?? AbortSignal.timeout(timeout),
      };

      if (params.body && (method === "POST" || method === "PUT" || method === "PATCH")) {
        (fetchOptions.headers as Record<string, string>)["Content-Type"] ??= "application/json";
        fetchOptions.body = params.body;
      }

      const response = await fetch(params.url, fetchOptions);

      // 收集响应信息
      const contentType = response.headers.get("content-type") ?? "unknown";
      const statusText = `${response.status} ${response.statusText}`;

      // 读取响应体
      let body: string;
      try {
        body = await response.text();
      } catch {
        body = "(无法读取响应体)";
      }

      // 截断过长内容
      const truncatedBody = truncateOutput(body, maxLength);

      const header = `状态: ${statusText}\n内容类型: ${contentType}`;
      const separator = body.length > 0 ? "\n---\n" : "";

      return {
        success: response.ok,
        data: `${header}${separator}${truncatedBody}`,
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