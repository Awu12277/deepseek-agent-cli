export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  name?: string;
}

export interface ChatOptions {
  signal?: AbortSignal;
  maxTokens?: number;
  temperature?: number;
}

export interface ChatChunk {
  content: string;
  finishReason: "stop" | "tool_calls" | "length" | null;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    cachedPromptTokens?: number;
  };
}

/** Provider 接口 — 每个模型后端都需要实现此接口。 */
export interface Provider {
  readonly name: string;
  chat(
    messages: ChatMessage[],
    opts?: ChatOptions,
  ): AsyncIterable<ChatChunk>;
  model(): string;
}
