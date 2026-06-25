import type { ChatMessage } from "../provider/index.js";
import type { Checkpoint } from "../checkpoint/index.js";

export interface StoredMessage extends ChatMessage {
  checkpoint?: Checkpoint;
}

export interface StoredSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  cwd: string;
  model: string;
  messages: StoredMessage[];
  totalCost: number;
}

export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: number;
  cwd: string;
  messageCount: number;
}
