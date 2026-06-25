import { describe, it, expect, afterEach } from "vitest";
import { HttpClient } from "../src/provider/client.js";
import {
  AuthError,
  RateLimitError,
  ServerError,
  NetworkError,
  TimeoutError,
  ProviderError,
} from "../src/provider/errors.js";

// ---------------------------------------------------------------------------
// mock fetch 工具
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  Object.assign(globalThis, { fetch: vi.fn(impl) });
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  restoreFetch();
});

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

describe("HttpClient — 构造", () => {
  it("应使用默认超时配置", () => {
    const client = new HttpClient();
    // 间接验证：发送请求触发 fetch 时的 signal 行为不便直接观察，
    // 这里仅验证构造不抛错
    expect(client).toBeInstanceOf(HttpClient);
  });

  it("应接受自定义超时配置", () => {
    const client = new HttpClient({
      connectTimeoutMs: 5000,
      maxRetries: 1,
      retryBaseDelayMs: 100,
      retryMaxDelayMs: 1000,
    });
    expect(client).toBeInstanceOf(HttpClient);
  });
});

describe("HttpClient.request — 请求成功", () => {
  it("应自动添加 Content-Type 头", async () => {
    let capturedInit: RequestInit | undefined;
    mockFetch(async (_url, init) => {
      capturedInit = init;
      return jsonResponse({ ok: true });
    });

    const client = new HttpClient();
    await client.request("https://api.example.com", {
      method: "POST",
      body: JSON.stringify({ x: 1 }),
    });

    expect(capturedInit?.headers).toBeInstanceOf(Headers);
    if (capturedInit?.headers instanceof Headers) {
      expect(capturedInit.headers.get("Content-Type")).toBe("application/json");
    }
  });

  it("不应覆盖调用方显式设置的 Content-Type", async () => {
    let capturedInit: RequestInit | undefined;
    mockFetch(async (_url, init) => {
      capturedInit = init;
      return jsonResponse({});
    });

    const client = new HttpClient();
    await client.request("https://api.example.com", {
      method: "POST",
      body: "{}",
      headers: { "Content-Type": "text/plain" },
    });

    if (capturedInit?.headers instanceof Headers) {
      expect(capturedInit.headers.get("Content-Type")).toBe("text/plain");
    }
  });

  it("GET 无 body 时不附加 Content-Type", async () => {
    let capturedInit: RequestInit | undefined;
    mockFetch(async (_url, init) => {
      capturedInit = init;
      return jsonResponse({});
    });

    const client = new HttpClient();
    await client.request("https://api.example.com", { method: "GET" });

    if (capturedInit?.headers instanceof Headers) {
      expect(capturedInit.headers.get("Content-Type")).toBeNull();
    }
  });

  it("应返回成功响应对象", async () => {
    const mockResponse = jsonResponse({ value: 42 });
    mockFetch(async () => mockResponse);

    const client = new HttpClient();
    const res = await client.request("https://api.example.com");
    expect(res.ok).toBe(true);
    expect(await res.json()).toEqual({ value: 42 });
  });
});

describe("HttpClient.request — 错误映射", () => {
  it("401 应抛出 AuthError", async () => {
    const errResponse = new Response(JSON.stringify({ error: { message: "bad key" } }), {
      status: 401,
    });
    mockFetch(async () => errResponse);

    const client = new HttpClient();
    await expect(client.request("https://api.example.com")).rejects.toBeInstanceOf(
      AuthError,
    );
  });

  it("429 应抛出 RateLimitError", async () => {
    const errResponse = new Response("{}", { status: 429 });
    mockFetch(async () => errResponse);

    const client = new HttpClient();
    await expect(client.request("https://api.example.com")).rejects.toBeInstanceOf(
      RateLimitError,
    );
  });

  it("500 应抛出 ServerError", async () => {
    const errResponse = new Response("internal", { status: 500 });
    mockFetch(async () => errResponse);

    const client = new HttpClient();
    await expect(client.request("https://api.example.com")).rejects.toBeInstanceOf(
      ServerError,
    );
  });

  it("fetch 抛出网络错误时包装为 NetworkError", async () => {
    mockFetch(async () => {
      throw new TypeError("fetch failed");
    });

    const client = new HttpClient();
    await expect(client.request("https://api.example.com")).rejects.toBeInstanceOf(
      NetworkError,
    );
  });
});

describe("HttpClient.request — 超时", () => {
  it("连接超时应抛出 TimeoutError", async () => {
    // fetch 永不完成；通过拒绝触发超时路径（实际走 timer abort）
    // 我们让 fetch 检查 signal 并在 abort 时抛 abort 错误
    mockFetch(async (_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener("abort", () => {
            reject(new DOMException("abort", "AbortError"));
          });
        }
      });
    });

    const client = new HttpClient({ connectTimeoutMs: 50 });
    await expect(
      client.request("https://api.example.com"),
    ).rejects.toBeInstanceOf(TimeoutError);
  });

  it("外部 signal 触发时抛出『请求已取消』", async () => {
    const controller = new AbortController();

    mockFetch(async (_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener("abort", () => {
            reject(new DOMException("abort", "AbortError"));
          });
        }
      });
    });

    const client = new HttpClient();
    // 立即中止
    setTimeout(() => controller.abort(), 5);

    await expect(
      client.request("https://api.example.com", undefined, { signal: controller.signal }),
    ).rejects.toThrow(/请求已取消/);
  });

  it("connectTimeoutMs=0 表示不超时", async () => {
    mockFetch(async () => jsonResponse({}));

    const client = new HttpClient();
    const res = await client.request("https://api.example.com", undefined, {
      connectTimeoutMs: 0,
    });
    expect(res.ok).toBe(true);
  });
});

describe("HttpClient.requestWithRetry", () => {
  it("429 应自动重试直至成功", async () => {
    let count = 0;
    mockFetch(async () => {
      count++;
      if (count < 3) return new Response("rate", { status: 429 });
      return jsonResponse({ ok: true });
    });

    const client = new HttpClient({
      maxRetries: 3,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 5,
    });
    const res = await client.requestWithRetry("https://api.example.com");
    expect(res.ok).toBe(true);
    expect(count).toBe(3);
  });

  it("非可重试错误（401）应立即抛出不重试", async () => {
    let count = 0;
    mockFetch(async () => {
      count++;
      return new Response("{}", { status: 401 });
    });

    const client = new HttpClient({ maxRetries: 3 });
    await expect(
      client.requestWithRetry("https://api.example.com"),
    ).rejects.toBeInstanceOf(AuthError);
    expect(count).toBe(1);
  });

  it("retry=false 应禁用重试", async () => {
    let count = 0;
    mockFetch(async () => {
      count++;
      return new Response("server", { status: 500 });
    });

    const client = new HttpClient({ maxRetries: 5 });
    await expect(
      client.requestWithRetry("https://api.example.com", undefined, { retry: false }),
    ).rejects.toBeInstanceOf(ServerError);
    expect(count).toBe(1);
  });

  it("网络错误也可重试", async () => {
    let count = 0;
    mockFetch(async () => {
      count++;
      if (count < 2) throw new TypeError("fetch failed");
      return jsonResponse({ ok: true });
    });

    const client = new HttpClient({
      maxRetries: 2,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 5,
    });
    const res = await client.requestWithRetry("https://api.example.com");
    expect(res.ok).toBe(true);
    expect(count).toBe(2);
  });
});

describe("ProviderError 子类继承", () => {
  it("AuthError / ServerError / NetworkError 均为 ProviderError", () => {
    expect(new AuthError("x", 401)).toBeInstanceOf(ProviderError);
    expect(new ServerError("x", 500)).toBeInstanceOf(ProviderError);
    expect(new NetworkError("x")).toBeInstanceOf(ProviderError);
    expect(new RateLimitError("x")).toBeInstanceOf(ProviderError);
  });

  it("TimeoutError 持有 timeoutMs", () => {
    const e = new TimeoutError("超时", 5000);
    expect(e.timeoutMs).toBe(5000);
    expect(e.code).toBe("TIMEOUT");
  });
});