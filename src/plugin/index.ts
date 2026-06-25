import type { AnyAgentTool } from "../tool/index.js";

/** 用于启动外部 MCP 插件的描述信息 */
export interface PluginDescriptor {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * PluginManager 管理外部 MCP 插件进程的生命周期。
 *
 * 每个插件作为子进程启动，通过 stdio 使用 JSON-RPC 2.0 通信。
 * 该适配器将 MCP 工具调用转换为内部的 AnyAgentTool 接口。
 */
export class PluginManager {
  /** 返回所有已加载插件提供的工具 */
  async listTools(): Promise<AnyAgentTool[]> {
    // TODO(chapter-09): launch subprocesses, run listTools, return adapted Tools
    return [];
  }
}
