import type {
  Provider,
  ChatMessage,
} from "../provider/index.js";
import type { Tool } from "../tool/index.js";
import { CostTracker } from "../provider/index.js";

/**
 * Session 表示一个 Agent 会话 — 与 LLM 的一次完整对话，
 * 包含消息历史和累计成本追踪。
 */
export class Session {
  readonly #messages: ChatMessage[] = [];
  /** 成本追踪器，由外部注入或自动创建 */
  readonly #costTracker: CostTracker;

  constructor(
    readonly provider: Provider,
    readonly tools: Tool[],
    costTracker?: CostTracker,
  ) {
    this.#costTracker = costTracker ?? new CostTracker();
  }

  get messages(): readonly ChatMessage[] {
    return this.#messages;
  }

  get accumulatedCost(): number {
    return this.#costTracker.sessionTotalCost;
  }

  /** 获取成本追踪器实例 */
  get costTracker(): CostTracker {
    return this.#costTracker;
  }

  /** 执行一轮对话：发送消息 → 接收响应 → 返回内容 */
  async chat(userInput: string): Promise<string> {
    this.#messages.push({ role: "user", content: userInput });

    // TODO(第07章): 完整 Agent 循环，包含工具调用解析
    const response = "Agent 响应 — 待实现（第07章）";
    this.#messages.push({ role: "assistant", content: response });

    return response;
  }

  /** 重置会话历史（保留 provider/tools 配置，重置成本追踪） */
  reset(): void {
    this.#messages.length = 0;
    this.#costTracker.resetSession();
  }
}
