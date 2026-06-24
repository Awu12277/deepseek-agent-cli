// ---------------------------------------------------------------------------
// 工具注册表 — 注册、查找、列出、过滤工具
//
// 参照 Zed 的 tools! 宏 + Thread::enabled_tools 架构重构：
// - 注册时检查名称唯一性（编译期常量 + 运行时双重校验）
// - Feature flag 门控：类似 Zed 的 tool_feature_flag_enabled()
// - Provider 过滤：类似 Zed 的 tool_supports_provider()
// - 语义化 ToolKind 分类
// - ALL_TOOL_NAMES 编译期常量列表
// ---------------------------------------------------------------------------

import { ToolKind, type AnyAgentTool, type ToolContext, type ToolResult, type AgentTool, eraseTool, isReadOnly } from "./types.js";

/** 工具注册表配置 */
export interface ToolRegistryOptions {
  /** 工具名称黑名单，这些工具不会被 list() 返回 */
  disabledTools?: string[];
  /**
   * Feature Flag 检查函数，返回 true 表示该工具可用。
   * 对应 Zed 的 tool_feature_flag_enabled()。
   * 不在列表中的工具默认启用。
   */
  featureFlagChecker?: (toolName: string) => boolean;
  /**
   * 当前使用的 LLM Provider ID。
   * 提供后只会列出支持该 provider 的工具。
   * 对应 Zed 的 tool_supports_provider()。
   */
  provider?: string;
}

/**
 * ToolRegistry — 管理所有已注册的工具。
 *
 * 设计要点（参照 Zed 的 tools! 宏 + Thread）：
 * - 注册时检查名称唯一性（如 Zed 的编译期 str_eq 检查）
 * - 支持 disable/enable 工具（基于配置项过滤）
 * - 支持 Feature Flag 门控
 * - 支持 Provider 过滤
 * - get() 返回 undefined 而非抛异常，调用方自行处理
 * - ALL_TOOL_NAMES 静态常量列表
 */
export class ToolRegistry {
  readonly #tools = new Map<string, AnyAgentTool>();
  readonly #disabledNames: Set<string>;
  readonly #featureFlagChecker: (toolName: string) => boolean;
  readonly #provider: string | undefined;

  /** 所有已注册工具的名称列表（编译期等效） */
  static readonly ALL_TOOL_NAMES: string[] = [];

  constructor(opts?: ToolRegistryOptions) {
    this.#disabledNames = new Set(opts?.disabledTools ?? []);
    this.#featureFlagChecker = opts?.featureFlagChecker ?? (() => true);
    this.#provider = opts?.provider;
  }

  /**
   * 注册一个类型安全的 AgentTool。
   * 自动擦除类型参数后存储。
   * 如果同名工具已存在则抛出错误。
   */
  register<I, O extends ToolResult = ToolResult>(tool: AgentTool<I, O>): this {
    return this.registerErased(eraseTool(tool));
  }

  /**
   * 注册一个已经擦除类型 AnyAgentTool。
   * 如果同名工具已存在则抛出错误。
   */
  registerErased(tool: AnyAgentTool): this {
    if (this.#tools.has(tool.name)) {
      throw new Error(`工具 "${tool.name}" 已注册，不能重复注册`);
    }
    this.#tools.set(tool.name, tool);
    return this;
  }

  /**
   * 批量注册工具。
   */
  registerAll(tools: AnyAgentTool[]): this {
    for (const tool of tools) {
      this.registerErased(tool);
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
   * 按名称获取工具（未擦除类型版本，调用方自行断言类型）。
   * 如果工具被禁用、被 feature flag 拦截、或不支持当前 provider，返回 undefined。
   */
  get(name: string): AnyAgentTool | undefined {
    if (!this.#isToolEnabled(name)) return undefined;
    return this.#tools.get(name);
  }

  /**
   * 获取所有启用的工具列表。
   * 依次应用：禁用列表 → Feature Flag → Provider 过滤。
   * 对应 Zed 的 built_in_tools() + enabled_tools()。
   */
  list(): AnyAgentTool[] {
    const result: AnyAgentTool[] = [];
    for (const [name, tool] of this.#tools) {
      if (this.#isToolEnabled(name)) {
        result.push(tool);
      }
    }
    return result;
  }

  /**
   * 按 ToolKind 分类获取工具列表。
   */
  listByKind(kind: ToolKind): AnyAgentTool[] {
    return this.list().filter((t) => t.kind === kind);
  }

  /**
   * 获取读工具列表（可并行执行）。
   */
  listReadTools(): AnyAgentTool[] {
    return this.listByKind(ToolKind.Read);
  }

  /**
   * 获取写工具列表（需串行执行）。
   */
  listWriteTools(): AnyAgentTool[] {
    return this.list().filter((t) => !isReadOnly(t.kind));
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
   * 检查工具是否已启用（注册 + 未禁用 + 通过 feature flag + 支持 provider）。
   */
  isEnabled(name: string): boolean {
    return this.#tools.has(name) && this.#isToolEnabled(name);
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
   * 获取工具的分类语义。
   */
  kindOf(name: string): ToolKind | undefined {
    return this.#tools.get(name)?.kind;
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

  // ---------------------------------------------------------------------------
  // 内部方法
  // ---------------------------------------------------------------------------

  /**
   * 判断工具是否应该启用。
   * 依次检查：是否在禁用列表 → 是否通过 Feature Flag → 是否支持当前 Provider。
   * 对应 Zed 的 enabled_tools() 中的多层过滤逻辑。
   */
  #isToolEnabled(name: string): boolean {
    const tool = this.#tools.get(name);
    if (!tool) return false;

    // 1. 禁用列表检查
    if (this.#disabledNames.has(name)) return false;

    // 2. Feature Flag 检查（对应 Zed 的 tool_feature_flag_enabled）
    if (!this.#featureFlagChecker(name)) return false;

    // 3. Provider 兼容性检查（对应 Zed 的 tool_supports_provider）
    if (this.#provider && tool.supportedProviders.length > 0) {
      if (!tool.supportedProviders.includes(this.#provider)) return false;
    }

    return true;
  }
}
