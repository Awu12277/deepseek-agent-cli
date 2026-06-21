// ---------------------------------------------------------------------------
// 工具注册表 — 注册、查找、列出、过滤工具
// ---------------------------------------------------------------------------

import type { Tool, ToolContext, ToolResult } from "./types.js";

/** 工具注册表配置 */
export interface ToolRegistryOptions {
  /** 工具名称黑名单，这些工具不会被 list() 返回 */
  disabledTools?: string[];
}

/**
 * ToolRegistry — 管理所有已注册的工具。
 *
 * 设计要点：
 * - 注册时检查名称唯一性，防止重复注册
 * - 支持 disable/enable 工具（基于配置项过滤）
 * - get() 返回 undefined 而非抛异常，调用方自行处理
 */
export class ToolRegistry {
  readonly #tools = new Map<string, Tool>();
  readonly #disabledNames: Set<string>;

  constructor(opts?: ToolRegistryOptions) {
    this.#disabledNames = new Set(opts?.disabledTools ?? []);
  }

  /**
   * 注册一个工具。
   * 如果同名工具已存在则抛出错误。
   */
  register(tool: Tool): this {
    if (this.#tools.has(tool.name)) {
      throw new Error(`工具 "${tool.name}" 已注册，不能重复注册`);
    }
    this.#tools.set(tool.name, tool);
    return this;
  }

  /**
   * 批量注册工具。
   */
  registerAll(tools: Tool[]): this {
    for (const tool of tools) {
      this.register(tool);
    }
    return this;
  }

  /**
   * 注销一个工具。
   */
  unregister(name: string): boolean {
    return this.#tools.delete(name);
  }

  /**
   * 按名称获取工具。
   * 如果工具被禁用或不存在，返回 undefined。
   */
  get(name: string): Tool | undefined {
    if (this.#disabledNames.has(name)) return undefined;
    return this.#tools.get(name);
  }

  /**
   * 获取所有启用的工具列表。
   */
  list(): Tool[] {
    const result: Tool[] = [];
    for (const [name, tool] of this.#tools) {
      if (!this.#disabledNames.has(name)) {
        result.push(tool);
      }
    }
    return result;
  }

  /**
   * 获取所有已注册的工具名称（含禁用的）。
   */
  names(): string[] {
    return [...this.#tools.keys()];
  }

  /**
   * 检查工具是否已注册（含禁用的）。
   */
  has(name: string): boolean {
    return this.#tools.has(name);
  }

  /**
   * 检查工具是否已启用。
   */
  isEnabled(name: string): boolean {
    return this.#tools.has(name) && !this.#disabledNames.has(name);
  }

  /**
   * 禁用一个工具。
   */
  disable(name: string): void {
    this.#disabledNames.add(name);
  }

  /**
   * 启用一个之前被禁用的工具。
   */
  enable(name: string): void {
    this.#disabledNames.delete(name);
  }

  /**
   * 执行指定工具。
   *
   * @returns 工具执行结果；如果工具不存在或被禁用，返回失败结果
   */
  async execute(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.get(name);
    if (!tool) {
      return {
        success: false,
        data: `工具 "${name}" 不存在或已被禁用`,
        error: "TOOL_NOT_FOUND",
      };
    }

    try {
      return await tool.execute(args, ctx);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        data: `工具 "${name}" 执行异常：${message}`,
        error: "EXECUTION_ERROR",
      };
    }
  }
}