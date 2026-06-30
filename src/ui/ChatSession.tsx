// ---------------------------------------------------------------------------
// 交互式聊天会话组件 — 接入 Agent 主循环，实现流式对话
// ---------------------------------------------------------------------------

import { Box, Text, useInput, Static } from "ink";
import TextInput from "ink-text-input";
import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { useDoubleCtrlC } from "./useDoubleCtrlC.js";
import { CYBER_PALETTE, LOGO_LINES } from "./DskcodeSplash.js";
import InkSpinner from "ink-spinner";
import { AssistantMessage } from "./AssistantMessage.js";
import { DiffPreview } from "./DiffPreview.js";
import { SkillSelector } from "./SkillSelector.js";
import { FileSelector } from "./FileSelector.js";
import type { SkillInfo } from "../cli/skill-import.js";
import { CostTracker } from "../provider/cost-tracker.js";
import type { ModelId, ProviderToolCall, UsageInfo } from "../provider/index.js";
import type { FileDiff } from "../tool/types.js";
import { TodoListPanel } from "./TodoListPanel.js";
import type { TodoItem } from "../harness/todo-list.js";
import { VERSION } from "../utils/version.js";
import { createProvider } from "../provider/index.js";
import {
  Session,
  type MessageCheckpointInfo,
  type RewindResult,
} from "../agent/index.js";
import type { SessionMode } from "../agent/types.js";
import { builtinTools } from "../tool/index.js";
import { ToolRegistry } from "../tool/registry.js";
import {
  IDLE_GRADIENT_STOPS,
  STREAMING_GRADIENT_STOPS,
  CMD_TIP_GRADIENT_STOPS,
  GRADIENT_ANIMATION,
  getGradientColors,
} from "../utils/gradient.js";
import { SUPPORTED_MODELS, calculateCost } from "../provider/models.js";
import { joinReasoningSegments, truncateReasoningLines } from "./reasoning-utils.js";
import { AnimatedLogo } from "./AnimatedLogo.js";
import { saveModelConfig } from "../config/loader.js";

/** 流式阶段配置：图标、标签、颜色 */
const PHASE_CONFIG = {
  thinking: { icon: "🧠", label: "思考中", color: "#ff9800" },
  generating: { icon: "✨", label: "生成中", color: "#00ff41" },
  calling_tools: { icon: "🛠", label: "调用工具", color: "#f59e0b" },
  executing_tools: { icon: "⚡", label: "执行工具", color: "#00ffff" },
} as const;

/** 判断工具名是否属于会修改文件系统的类（用于决定 rewind 提示是否出现） */
export function isFileMutatingTool(name: string): boolean {
  return (
    name === "edit_file" ||
    name === "write_file" ||
    name === "multi_edit" ||
    name === "delete_range"
  );
}

/** 命令处理结果的类型，支持文本响应和动作跳转 */
export type CommandAction =
  | { kind: "text"; content: string }
  | { kind: "exit" }
  | { kind: "clear" }
  | { kind: "navigate"; target: "game" | "stock" };

/**
 * 从 toolCalls 中过滤掉 `todo_*` 任务进度工具。
 *
 * todo_* 工具是任务进度的元数据（todo_add / todo_mark_done / todo_mark_failed / todo_retry），
 * 它们不表示 AI 实际做了什么，UI 上交给独立的 <TodoListPanel> 维护，不进入消息列表。
 *
 * @param calls — 原始 tool_calls 列表（可能为 undefined）
 * @returns 过滤后的列表（若过滤后为空返回 undefined）
 *
 * @pure
 */
function filterTodoToolCalls(
  calls: ReadonlyArray<ProviderToolCall> | undefined,
): ProviderToolCall[] | undefined {
  if (!calls) return undefined;
  const filtered = calls.filter((tc) => !tc.name.startsWith("todo_"));
  return filtered.length > 0 ? filtered : undefined;
}

export interface ChatCommand {
  desc: string;
  handler: () => CommandAction;
}

/** 命令注册表，支持动态注册新命令 */
const commandRegistry = new Map<string, ChatCommand>();

/** 注册一个命令 */
export function registerCommand(name: string, cmd: ChatCommand): void {
  commandRegistry.set(name, cmd);
}

/** 获取所有已注册命令（用于 /help 生成帮助文本） */
function getRegisteredCommands(): Map<string, ChatCommand> {
  return commandRegistry;
}

// 注册内置命令
registerCommand("/exit", { desc: "退出对话", handler: () => ({ kind: "exit" }) });
registerCommand("/quit", { desc: "退出对话", handler: () => ({ kind: "exit" }) });
registerCommand("/help", {
  desc: "显示帮助信息",
  handler: () => {
    const commands = getRegisteredCommands();
    const lines = ["可用命令："];
    for (const [name, cmd] of commands) {
      lines.push(`  ${name.padEnd(16)}${cmd.desc}`);
    }
    return { kind: "text", content: lines.join("\n") };
  },
});
registerCommand("/clear", { desc: "清空对话历史", handler: () => ({ kind: "clear" }) });
registerCommand("/version", {
  desc: "显示版本信息",
  handler: () => ({ kind: "text", content: `dskcode v${VERSION}` }),
});
registerCommand("/model", {
  desc: "切换模型",
  handler: () => ({ kind: "text", content: "请直接输入 /model 进入选择界面" }),
});
registerCommand("/thinking", {
  desc: "切换深度思考模式",
  handler: () => ({ kind: "text", content: "请直接输入 /thinking 切换" }),
});
registerCommand("/effort", {
  desc: "切换推理等级 High/Max",
  handler: () => ({ kind: "text", content: "请直接输入 /effort 切换" }),
});
registerCommand("/game", {
  desc: "启动游戏",
  handler: () => ({ kind: "navigate", target: "game" }),
});
registerCommand("/stock", {
  desc: "查看股票行情",
  handler: () => ({ kind: "navigate", target: "stock" }),
});
registerCommand("/plan", {
  desc: "切换为计划模式（Shift+Tab）",
  handler: () => ({ kind: "text", content: "输入 /plan 或按 Shift+Tab 切换为计划模式" }),
});
registerCommand("/code", {
  desc: "切换回代码模式（Shift+Tab）",
  handler: () => ({ kind: "text", content: "输入 /code 或按 Shift+Tab 切换回代码模式" }),
});
registerCommand("/rewind", {
  desc: "回退到历史检查点（1 = 最新）",
  handler: () => ({
    kind: "text",
    content:
      "请直接输入 /rewind 查看可回退的检查点列表，或 /rewind <序号> 直接回退（1 = 最新，2 = 上一次，依此类推）",
  }),
});

/** 流式输出时，输入框随机展示的占位符列表 */
const STREAMING_PLACEHOLDERS = [
  "让子弹飞一会儿...",
  "马上就好...",
  "正在憋大招...",
  "稍等一下下~",
  "码字中...",
  "脑子转得飞快...",
];

/** 空闲时输入框随机展示的占位符列表 */
const IDLE_PLACEHOLDERS = [
  "想干啥？直接说~",
  "来吧，吩咐点啥",
  "随时待命...",
  "戳这里开聊...",
  "等你开口...",
  "尽管使唤~",
];

function pickRandom<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

/** 单条已完成的助手消息 */
interface CompletedAssistant {
  content: string;
  /**
   * 思考链段列表（thinking 模式的 CoT），可选。
   * 模型一轮内可能经历多轮“思考→调工具”，每一段都保留在这里。
   */
  reasoning?: string[];
  toolCalls?: ProviderToolCall[];
  usage?: UsageInfo;
  elapsed?: number;
  cost?: number;
  model?: string;
}

/** 单条显示消息 */
interface DisplayMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  /** 已完成的助手消息详情（仅在 role=assistant 时） */
  assistantDetail?: CompletedAssistant;
  /** 文件变更 diff（仅在 role=tool 且有 diff 时） */
  diff?: FileDiff;
}

interface ChatSessionProps {
  skillCount: number;
  /** 可用 skill 详情列表（用于 / 输入时展示） */
  skills?: SkillInfo[];
  /** 项目源码文件路径列表（用于 @ 输入时展示） */
  files?: string[];
  toolCount: number;
  verbose: boolean;
  apiKey?: string;
  baseUrl?: string;
  costTracker?: CostTracker;
  model?: string;
  onLaunchGame?: () => void;
  onLaunchStock?: () => void;
}

export function ChatSession({
  skillCount,
  skills = [],
  files = [],
  toolCount,
  verbose,
  apiKey,
  baseUrl,
  costTracker: externalCostTracker,
  model = "deepseek-v4-flash",
  onLaunchGame,
  onLaunchStock,
}: ChatSessionProps) {
  const termWidth =
    typeof process.stdout.columns === "number" ? process.stdout.columns : 80;
  // 面板系统宽度
  const contentAreaWidth = termWidth - 2; // 去掉外 padding
  const leftPanelWidth = Math.max(Math.floor(contentAreaWidth / 3), 30);
  const rightContentWidth = contentAreaWidth - leftPanelWidth - 1; // 1 为竖线分隔符

  const [offset, setOffset] = useState(0);
  const [displayMessages, setDisplayMessages] = useState<DisplayMessage[]>([]);
  const [staticKey, setStaticKey] = useState(0);
  const [input, setInput] = useState("");
  const [balance, setBalance] = useState<number | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [todayCost, setTodayCost] = useState<number | null>(null);

  // 流式状态
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingPhase, setStreamingPhase] = useState<
    "thinking" | "generating" | "calling_tools" | "executing_tools" | null
  >(null);
  const [streamingPlaceholder, setStreamingPlaceholder] = useState("");
  const [idlePlaceholder, setIdlePlaceholder] = useState(() =>
    pickRandom(IDLE_PLACEHOLDERS),
  );
  const [gradientColors, setGradientColors] = useState<string[]>([]);
  const gradientPhaseRef = useRef(0);
  const [streamingGradientColors, setStreamingGradientColors] = useState<string[]>([]);
  const streamingPhaseRef = useRef(0);
  const [currentContent, setCurrentContent] = useState("");
  /**
   * 本轮已累积的思考链段列表。一轮内可能经历多轮“思考→调工具→思考”，
   * 每一段都 push 到这里，避免被后一段覆盖。
   */
  const [currentReasoning, setCurrentReasoning] = useState<string[]>([]);
  const [currentToolCalls, setCurrentToolCalls] = useState<ProviderToolCall[]>([]);
  const [_currentUsage, setCurrentUsage] = useState<UsageInfo | undefined>(undefined);
  const [_currentElapsed, setCurrentElapsed] = useState<number | undefined>(undefined);
  const [_currentCost, setCurrentCost] = useState<number | undefined>(undefined);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const [activeModel, setActiveModel] = useState<ModelId>(model as unknown as ModelId);
  const [_streamingModel, setStreamingModel] = useState<string | undefined>(undefined);
  const [streamError, setStreamError] = useState<string | undefined>(undefined);
  // todo 任务进度面板 state — todo_* 工具结果更新此状态，<TodoListPanel> 独立渲染
  const [todoSnapshot, setTodoSnapshot] = useState<ReadonlyArray<TodoItem>>([]);
  // 任务全部结束后延迟隐藏的面板可见性（默认 true：有 snapshot 就显示）
  const [todoPanelVisible, setTodoPanelVisible] = useState(true);
  // "全部结束后 2s 隐藏"的定时器句柄
  const todoHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 上次"全部 terminated"批次的最大 todo id。
  // 当新批次 todo_add 推来 event.todoSnapshot 时，过滤掉 ≤ 此值的旧批次项，
  // 避免「上一轮已完成的任务进度在新一轮渲染出来」。
  // 初始 -1 表示没有上批次，不过滤。
  const lastDoneBatchMaxIdRef = useRef(-1);

  // 会话模式（code / plan）
  const [sessionMode, setSessionMode] = useState<SessionMode>("code");

  // 高级设置
  const [thinkingEnabled, setThinkingEnabled] = useState(true);
  const [thinkingEffort, setThinkingEffort] = useState<"high" | "max">("high");
  const [responseFormat] = useState<"text" | "json_object">("text");
  const [toolChoice, setToolChoice] = useState<"auto" | "required" | "none" | undefined>(
    undefined,
  );

  // 本次会话累计费用（从已完成的助手消息中汇总）
  const sessionCost = useMemo(() => {
    return displayMessages.reduce((sum, msg) => {
      if (msg.assistantDetail?.cost) {
        return sum + msg.assistantDetail.cost;
      }
      return sum;
    }, 0);
  }, [displayMessages]);

  const hasConversationStarted = displayMessages.length > 0;

  // 仅流式进行中且有思考内容时显示思考链
  const hasReasoningPanel = isStreaming && currentReasoning.length > 0;

  // 命令提示轮播索引
  const cmdTips = Array.from(getRegisteredCommands())
    .filter(([name]) => name !== "/exit" && name !== "/quit")
    .map(([name, cmd]) => ({ name, desc: cmd.desc }));
  const [cmdTipIndex, setCmdTipIndex] = useState(0);
  const [cmdTipGradientColors, setCmdTipGradientColors] = useState<string[]>([]);
  const cmdTipPhaseRef = useRef(0);

  // skill 选择索引（用于上下键导航）
  const [skillSelectIndex, setSkillSelectIndex] = useState(0);
  // 文件选择索引
  const [fileSelectIndex, setFileSelectIndex] = useState(0);
  // 输入框 key（补全时递增，强制 TextInput 重挂载以重置光标到末尾）
  const [inputKey, setInputKey] = useState(0);

  // /rewind 回退选择模式
  const [rewindSelecting, setRewindSelecting] = useState(false);
  const [rewindSelectIndex, setRewindSelectIndex] = useState(0);
  const [rewindList, setRewindList] = useState<MessageCheckpointInfo[]>([]);
  const [rewinding, setRewinding] = useState(false);

  // /rewind 提示：某轮对话修改了文件后，在原状态 loading 处显示「/rewind 1 可撤回本次修改」。
  // 三阶段：idle（不显示）→ pending（流式刚结束，等 2s）→ visible（展示提示）
  // 提示一旦出现会一直保留到下次对话开始，不会被用户输入打断。
  const [rewindHintPhase, setRewindHintPhase] = useState<"idle" | "pending" | "visible">(
    "idle",
  );
  // 本轮是否触发了文件修改类工具调用（edit_file/write_file/multi_edit/delete_range）
  const currentRoundModifiedRef = useRef(false);
  // 提示计时器句柄
  const rewindHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 模型选择模式
  const [selectingModel, setSelectingModel] = useState(false);
  const [modelSelectIndex, setModelSelectIndex] = useState(0);
  const modelOptions: ModelId[] = ["deepseek-v4-flash", "deepseek-v4-pro"];

  // Session 引用（保持跨渲染稳定）
  const sessionRef = useRef<Session | null>(null);
  const abortRef = useRef<AbortController>(null);

  // 用 ref 跟踪流式内容的最新值，以便 finally 块能获取非闭包过期的值
  const currentContentRef = useRef("");
  const currentReasoningRef = useRef<string[]>([]);
  const currentToolCallsRef = useRef<ProviderToolCall[]>([]);
  const currentUsageRef = useRef<UsageInfo | undefined>(undefined);
  const currentElapsedRef = useRef<number | undefined>(undefined);
  const currentCostRef = useRef<number | undefined>(undefined);
  const currentModelRef = useRef<string | undefined>(undefined);
  const streamErrorRef = useRef<string | undefined>(undefined);

  // 输入变更时仅重置选择索引；rewind 提示由下一轮对话开始时清掉
  useEffect(() => {
    setSkillSelectIndex(0);
    setFileSelectIndex(0);
  }, [input]);

  // 组件卸载时清掉 rewind 提示计时器，避免内存泄露
  useEffect(() => {
    return () => {
      if (rewindHintTimerRef.current) {
        clearTimeout(rewindHintTimerRef.current);
        rewindHintTimerRef.current = null;
      }
    };
  }, []);

  // todo 面板可见性：
  // - 有未完成项（pending / running / failed）→ 一直显示
  // - 全部结束（done / skipped）→ 2s 缓冲后自动隐藏，让用户看清完成态
  // - snapshot 为空 → 隐藏
  // 新任务开始时（snapshot 从空 → 非空）会重新出现
  useEffect(() => {
    // 顺手清掉可能残留的隐藏计时器（保留 ref 以备未来需要）
    if (todoHideTimerRef.current) {
      clearTimeout(todoHideTimerRef.current);
      todoHideTimerRef.current = null;
    }

    if (todoSnapshot.length === 0) {
      setTodoPanelVisible(false);
      return;
    }

    // 是否有未完成项（pending / running / failed 都算"还在动"）
    const hasUnfinished = todoSnapshot.some(
      (it) => it.status === "pending" || it.status === "running" || it.status === "failed",
    );

    if (hasUnfinished) {
      setTodoPanelVisible(true);
    } else {
      // 全部 done / failed / skipped：给用户 2s 缓冲看到完成态，再隐藏面板。
      // 同时记录批次边界，供下次 tool_result 过滤旧批次用。
      lastDoneBatchMaxIdRef.current = Math.max(...todoSnapshot.map((it) => it.id));
      todoHideTimerRef.current = setTimeout(() => {
        setTodoPanelVisible(false);
        todoHideTimerRef.current = null;
      }, 2000);
    }
  }, [todoSnapshot]);

  // 获取当前输入匹配的 skill 列表
  const getFilteredSkills = useCallback(
    (value: string) => {
      const match = value.match(/(?:^|\s)\/([^/]*)$/);
      if (!match) return [];
      const q = match[1]!.toLowerCase().trim();
      if (!q) {
        if (value.startsWith("/")) return skills.slice(0, 3);
        return [];
      }
      const matched = skills.filter((s) => s.name.toLowerCase().includes(q)).slice(0, 3);
      // 精确匹配时表示已补全完成，不显示列表
      if (matched.some((s) => s.name.toLowerCase() === q)) return [];
      return matched;
    },
    [skills],
  );

  // 获取当前输入匹配的文件列表
  const getFilteredFiles = useCallback(
    (value: string) => {
      const match = value.match(/(?:^|\s)@([^@]*)$/);
      if (!match) return [];
      const q = match[1]!.toLowerCase().trim();
      // @ 在开头且无后续内容时，展示前 5 个文件作为提示
      if (!q) {
        if (value.startsWith("@")) return files.slice(0, 5);
        return [];
      }
      const matched = files.filter((f) => f.toLowerCase().includes(q)).slice(0, 5);
      // 精确匹配时表示已补全完成，不显示列表
      if (matched.some((f) => f.toLowerCase() === q)) return [];
      return matched;
    },
    [files],
  );

  // 根据 session.messages 重建 displayMessages，绕开下标对齐问题
  function rebuildDisplayFromSession(sess: Session): void {
    const next: DisplayMessage[] = [];
    for (const m of sess.messages) {
      if (m.role === "user") {
        next.push({ role: "user", content: m.content });
      } else if (m.role === "assistant") {
        next.push({
          role: "assistant",
          content: m.content,
          assistantDetail: {
            content: m.content,
            toolCalls: filterTodoToolCalls(m.toolCalls),
          },
        });
      } else if (m.role === "tool") {
        next.push({ role: "tool", content: m.content });
      }
      // system 消息不展示
    }
    setDisplayMessages(next);
    setStaticKey((prev) => prev + 1);
  }

  const doRewind = useCallback(
    async (target: MessageCheckpointInfo, displayNumber: number) => {
      const session = sessionRef.current;
      if (!session) return;
      setRewinding(true);
      setIsStreaming(true);
      setStreamingPhase("thinking");
      setStreamingPlaceholder("⏪ 正在回退到检查点…");
      setInput("");
      try {
        const r: RewindResult = await session.rewind(target.index);
        if (r.ok) {
          rebuildDisplayFromSession(session);
          const tail = r.fileRestored
            ? "，工作区文件已恢复"
            : "（仅对话回退，未恢复文件）";
          setDisplayMessages((prev) => [
            ...prev,
            {
              role: "assistant",
              content: `⏪ 已回退到检查点 #${displayNumber}${tail}。`,
            },
          ]);
        } else {
          setDisplayMessages((prev) => [
            ...prev,
            { role: "assistant", content: `⚠ 回退失败：${r.error}` },
          ]);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        setDisplayMessages((prev) => [
          ...prev,
          { role: "assistant", content: `⚠ 回退异常：${msg}` },
        ]);
      } finally {
        setRewinding(false);
        setIsStreaming(false);
        setStreamingPhase(null);
        setStreamingPlaceholder("");
      }
    },
    [],
  );

  const { doubleCtrlC, handleCtrlC } = useDoubleCtrlC(() => {
    // 双击 Ctrl+C 退出进程 — 先刷新日志再退出
    const s = sessionRef.current;
    if (s) {
      void s.flushLog().finally(() => process.exit(0));
    } else {
      process.exit(0);
    }
  });

  // 捕获 Ctrl+C 和渐变占位符状态下的字符输入
  useInput(
    useCallback(
      (_input, key) => {
        // /rewind 选择模式
        if (rewindSelecting) {
          if (key.upArrow) {
            setRewindSelectIndex(
              (prev) => (prev - 1 + rewindList.length) % rewindList.length,
            );
          } else if (key.downArrow) {
            setRewindSelectIndex((prev) => (prev + 1) % rewindList.length);
          } else if (key.return) {
            const target = rewindList[rewindSelectIndex];
            setRewindSelecting(false);
            if (target) {
              void doRewind(target, rewindSelectIndex + 1);
            }
          } else if (key.escape) {
            setRewindSelecting(false);
            setDisplayMessages((prev) => [
              ...prev,
              { role: "assistant", content: "已取消回退。" },
            ]);
          }
          return;
        }

        // 模型选择模式
        if (selectingModel) {
          if (key.upArrow) {
            setModelSelectIndex(
              (prev) => (prev - 1 + modelOptions.length) % modelOptions.length,
            );
          } else if (key.downArrow) {
            setModelSelectIndex((prev) => (prev + 1) % modelOptions.length);
          } else if (key.return) {
            const selected = modelOptions[modelSelectIndex]!;
            if (selected === activeModel) {
              setDisplayMessages((prev) => [
                ...prev,
                {
                  role: "assistant",
                  content: `已经在使用 ${SUPPORTED_MODELS[selected].displayName}`,
                },
              ]);
            } else {
              // 切换模型：持久化到配置 + 重置 Session
              setActiveModel(selected);
              sessionRef.current?.reset();
              saveModelConfig(selected).catch(() => {
                // 持久化失败静默处理，不影响当前会话
              });
              setDisplayMessages((prev) => [
                ...prev,
                {
                  role: "assistant",
                  content: `模型已切换为 ${SUPPORTED_MODELS[selected].displayName}（${selected}）`,
                },
              ]);
            }
            setSelectingModel(false);
          } else if (key.escape) {
            setSelectingModel(false);
          }
          return;
        }

        // 文件 @ 选择模式 / skill 选择模式
        // 优先 @（文件匹配），没有文件匹配再走 skill 匹配
        const fileList = getFilteredFiles(input);
        const skillList = fileList.length === 0 ? getFilteredSkills(input) : [];

        if (fileList.length > 0) {
          if (key.upArrow) {
            setFileSelectIndex((prev) => (prev - 1 + fileList.length) % fileList.length);
            return;
          }
          if (key.downArrow) {
            setFileSelectIndex((prev) => (prev + 1) % fileList.length);
            return;
          }
          // Tab 补全选中的文件
          if (key.tab) {
            const selected = fileList[fileSelectIndex];
            if (selected) {
              const atIdx = input.lastIndexOf("@");
              if (atIdx >= 0) {
                setInput(input.slice(0, atIdx) + "@" + selected + " ");
                setInputKey((k) => k + 1);
              }
            }
            return;
          }
        }

        if (skillList.length > 0) {
          if (key.upArrow) {
            setSkillSelectIndex(
              (prev) => (prev - 1 + skillList.length) % skillList.length,
            );
            return;
          }
          if (key.downArrow) {
            setSkillSelectIndex((prev) => (prev + 1) % skillList.length);
            return;
          }
          // Tab 补全选中的 skill（补全后光标自动移至末尾）
          if (key.tab) {
            const selected = skillList[skillSelectIndex];
            if (selected) {
              // 只替换最后一个 / 之后的部分，保留之前输入的内容
              // 用 lastIndexOf 定位 / 的精确位置，确保前置空格不被吃掉
              const slashIdx = input.lastIndexOf("/");
              if (slashIdx >= 0) {
                // 补全后加空格分隔，方便继续输入下一个 skill 或问题
                setInput(input.slice(0, slashIdx) + "/" + selected.name + " ");
                setInputKey((k) => k + 1);
              }
            }
            return;
          }
        }

        // 模型选择 / 设置选择模式下的通用键盘处理
        if (selectingModel) {
          if (key.upArrow || key.downArrow) {
            // 已在模型选择模式下处理上下键
          }
          return;
        }

        if (key.ctrl && _input === "c") {
          if (isStreaming) {
            abortRef.current?.abort();
          } else {
            handleCtrlC();
          }
          return;
        }

        // Shift+Tab 切换计划模式 / 代码模式
        if (key.shift && key.tab) {
          if (!isStreaming) {
            const newMode: SessionMode = sessionMode === "plan" ? "code" : "plan";
            setSessionMode(newMode);
            sessionRef.current?.setMode(newMode);
            setToolChoice(undefined);
            sessionRef.current?.reset();
            setDisplayMessages((prev) => [
              ...prev,
              {
                role: "assistant",
                content:
                  newMode === "plan"
                    ? "📋 已切换为 **计划模式**（Shift+Tab）\n\n在此模式下，我只能读取和分析代码，不会执行任何修改。"
                    : "🛠 已切换为 **代码模式**（Shift+Tab）\n\n现在可以正常读取和修改代码了。",
              },
            ]);
          }
          return;
        }

        // 渐变占位符显示时（TextInput 未渲染），将按键字符加入 input 触发切换
        if (!input && !isStreaming && _input) {
          setInput(_input);
        }
      },
      [
        selectingModel,
        modelSelectIndex,
        modelOptions,
        activeModel,
        isStreaming,
        handleCtrlC,
        input,
        skills,
        skillSelectIndex,
        fileSelectIndex,
        getFilteredSkills,
        getFilteredFiles,
        sessionMode,
        setSessionMode,
        rewindSelecting,
        rewindSelectIndex,
        rewindList,
        doRewind,
      ],
    ),
  );

  // 命令提示轮播 — 每 2 秒切换下一条
  useEffect(() => {
    if (cmdTips.length <= 1) return;
    const timer = setInterval(() => {
      setCmdTipIndex((prev) => (prev + 1) % cmdTips.length);
    }, 2000);
    return () => clearInterval(timer);
  }, [cmdTips.length]);

  // 命令提示条渐变动画（反向流动：1 - phase）
  useEffect(() => {
    const tip = cmdTips[cmdTipIndex % cmdTips.length];
    if (!tip) {
      setCmdTipGradientColors([]);
      return;
    }
    const text = `${tip.name} ${tip.desc}`;
    cmdTipPhaseRef.current = 0;
    setCmdTipGradientColors(getGradientColors(text, 1, CMD_TIP_GRADIENT_STOPS));

    const interval = setInterval(() => {
      cmdTipPhaseRef.current =
        (cmdTipPhaseRef.current + GRADIENT_ANIMATION.cmdTipPhaseStep) % 1;
      // 反向 phase 使色彩从左到右流动
      setCmdTipGradientColors(
        getGradientColors(text, 1 - cmdTipPhaseRef.current, CMD_TIP_GRADIENT_STOPS),
      );
    }, GRADIENT_ANIMATION.cmdTipInterval);

    return () => clearInterval(interval);
  }, [cmdTipIndex, cmdTips.length]);

  // Logo 色彩动画
  useEffect(() => {
    const timer = setInterval(() => {
      setOffset((prev) => (prev + 1) % CYBER_PALETTE.length);
    }, 500);
    return () => clearInterval(timer);
  }, []);

  // 初始化 Session（当模型切换时重建）
  useEffect(() => {
    if (!apiKey || !baseUrl) return;

    const provider = createProvider({
      name: "deepseek",
      apiKey,
      baseUrl,
      model: activeModel,
    });

    const tracker = externalCostTracker ?? new CostTracker();
    // 注册所有内置工具
    const toolRegistry = new ToolRegistry();
    toolRegistry.registerAll(builtinTools);
    const session = new Session(provider, toolRegistry, tracker, {
      cwd: process.cwd(),
    });
    sessionRef.current = session;

    return () => {
      sessionRef.current = null;
    };
  }, [apiKey, baseUrl, activeModel, externalCostTracker]);

  // 查询余额
  useEffect(() => {
    if (!apiKey || !baseUrl) return;
    let cancelled = false;
    setBalanceLoading(true);
    import("../provider/deepseek.js")
      .then(({ DeepSeekProvider }) => {
        const provider = new DeepSeekProvider({
          apiKey,
          baseUrl,
          model: "deepseek-v4-flash",
        });
        return provider.getBalance();
      })
      .then((result) => {
        if (cancelled) return;
        const cny = result.balances.find((b) => b.currency === "CNY");
        if (cny) {
          setBalance(cny.totalBalance);
        }
      })
      .catch(() => {
        // 查询失败静默处理，不影响主流程
      })
      .finally(() => {
        if (!cancelled) setBalanceLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [apiKey, baseUrl]);

  // 加载今日消耗历史数据，并定时刷新
  useEffect(() => {
    if (!externalCostTracker) return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval>;

    const refresh = () => {
      setTodayCost(externalCostTracker.todayTotalCost);
    };

    externalCostTracker
      .load()
      .then(() => {
        if (cancelled) return;
        refresh();
        timer = setInterval(refresh, 5000);
      })
      .catch(() => {
        // 加载失败静默处理
      });

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [externalCostTracker]);

  // 空闲占位符渐变动画
  useEffect(() => {
    if (isStreaming || !idlePlaceholder) {
      setGradientColors([]);
      return;
    }

    gradientPhaseRef.current = 0;
    setGradientColors(getGradientColors(idlePlaceholder, 1, IDLE_GRADIENT_STOPS));

    const interval = setInterval(() => {
      gradientPhaseRef.current =
        (gradientPhaseRef.current + GRADIENT_ANIMATION.idlePhaseStep) % 1;
      setGradientColors(
        getGradientColors(
          idlePlaceholder,
          1 - gradientPhaseRef.current,
          IDLE_GRADIENT_STOPS,
        ),
      );
    }, GRADIENT_ANIMATION.idleInterval);

    return () => clearInterval(interval);
  }, [isStreaming, idlePlaceholder]);

  // 流式占位符渐变动画
  useEffect(() => {
    if (!isStreaming || !streamingPlaceholder) {
      setStreamingGradientColors([]);
      return;
    }

    streamingPhaseRef.current = 0;
    setStreamingGradientColors(
      getGradientColors(streamingPlaceholder, 1, STREAMING_GRADIENT_STOPS),
    );

    const interval = setInterval(() => {
      streamingPhaseRef.current =
        (streamingPhaseRef.current + GRADIENT_ANIMATION.streamingPhaseStep) % 1;
      setStreamingGradientColors(
        getGradientColors(
          streamingPlaceholder,
          1 - streamingPhaseRef.current,
          STREAMING_GRADIENT_STOPS,
        ),
      );
    }, GRADIENT_ANIMATION.streamingInterval);

    return () => clearInterval(interval);
  }, [isStreaming, streamingPlaceholder]);

  /** 处理用户输入 */
  const handleSubmit = useCallback(
    async (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) return;

      // 处理斜杠命令
      if (trimmed.startsWith("/") && trimmed.length > 1) {
        const cmdLower = trimmed.toLowerCase();

        // /rewind 命令：回退到历史检查点
        if (cmdLower === "/rewind" || cmdLower.startsWith("/rewind ")) {
          if (isStreaming || rewinding) {
            const reason = rewinding ? "回退中" : "生成中";
            setDisplayMessages((prev) => [
              ...prev,
              { role: "user", content: trimmed },
              { role: "assistant", content: `⚠ 正在${reason}，请稍后再试 /rewind。` },
            ]);
            setInput("");
            return;
          }
          if (!sessionRef.current) {
            setDisplayMessages((prev) => [
              ...prev,
              { role: "user", content: trimmed },
              { role: "assistant", content: "⚠ Session 未就绪，无法回退。" },
            ]);
            setInput("");
            return;
          }
          const cps = sessionRef.current.listCheckpoints();
          if (cps.length === 0) {
            setDisplayMessages((prev) => [
              ...prev,
              { role: "user", content: trimmed },
              {
                role: "assistant",
                content:
                  "⚠ 没有可回退的检查点。\n只有在 git 仓库内且发生过对话后才会生成检查点。",
              },
            ]);
            setInput("");
            return;
          }
          // /rewind <N>：1 表示最新（与 git reset HEAD~ 习惯一致），2 表示上一个，依次类推
          const parts = trimmed.split(/\s+/);
          if (parts.length >= 2) {
            const n = Number(parts[1]);
            if (!Number.isInteger(n) || n < 1 || n > cps.length) {
              setDisplayMessages((prev) => [
                ...prev,
                { role: "user", content: trimmed },
                {
                  role: "assistant",
                  content: `⚠ 无效的序号「${parts[1]}」。可用范围 1~${cps.length}（1 表示最新）。`,
                },
              ]);
              setInput("");
              return;
            }
            // 将用户输入的 1-based "最新优先"序号转换为 cps 列表里的索引
            const target = cps[cps.length - n]!;
            setInput("");
            await doRewind(target, n);
            return;
          }
          // 无参数：进入选择模式。逆序展示（最新在第 1 位），默认选中最新
          setRewindList([...cps].reverse());
          setRewindSelectIndex(0);
          setRewindSelecting(true);
          setDisplayMessages((prev) => [
            ...prev,
            { role: "user", content: trimmed },
            {
              role: "assistant",
              content: `⏷↑↓ 选择检查点，Enter 确认，Esc 取消（共 ${cps.length} 个可回退位置）`,
            },
          ]);
          setInput("");
          return;
        }

        // /model 命令：进入模型选择模式
        if (cmdLower === "/model") {
          const curIdx = modelOptions.indexOf(activeModel);
          setModelSelectIndex(curIdx >= 0 ? curIdx : 0);
          setSelectingModel(true);
          setInput("");
          return;
        }

        // /thinking 命令：切换深度思考
        if (cmdLower === "/thinking") {
          setThinkingEnabled((prev) => !prev);
          setDisplayMessages((prev) => [
            ...prev,
            { role: "user", content: trimmed },
            {
              role: "assistant",
              content: `深度思考已${thinkingEnabled ? "关闭" : "开启"}`,
            },
          ]);
          setInput("");
          return;
        }

        // /effort 命令：切换推理等级
        if (cmdLower === "/effort") {
          const next = thinkingEffort === "high" ? "max" : "high";
          setThinkingEffort(next);
          setDisplayMessages((prev) => [
            ...prev,
            { role: "user", content: trimmed },
            {
              role: "assistant",
              content: `推理等级已切换为 ${next === "high" ? "High" : "Max"}`,
            },
          ]);
          setInput("");
          return;
        }

        // /plan 命令：切换为计划模式（只读分析，不能修改代码）
        if (cmdLower === "/plan") {
          if (sessionMode === "plan") {
            setDisplayMessages((prev) => [
              ...prev,
              { role: "user", content: trimmed },
              {
                role: "assistant",
                content: "已经在计划模式中。输入 /code 切回代码模式。",
              },
            ]);
          } else {
            setSessionMode("plan");
            sessionRef.current?.setMode("plan");
            // 计划模式下自动启用工具调用，确保模型可以使用读工具
            setToolChoice(undefined);
            setDisplayMessages((prev) => [
              ...prev,
              { role: "user", content: trimmed },
              {
                role: "assistant",
                content:
                  "📋 已切换为 **计划模式**\n\n在此模式下，我只能读取和分析代码，不会执行任何修改。\n输入 /code 切回代码模式。",
              },
            ]);
            // 清空会话历史，防止旧模式下产生的工具调用消息干扰新模式
            sessionRef.current?.reset();
          }
          setInput("");
          return;
        }

        // /code 命令：切换回代码模式
        if (cmdLower === "/code") {
          if (sessionMode === "code") {
            setDisplayMessages((prev) => [
              ...prev,
              { role: "user", content: trimmed },
              {
                role: "assistant",
                content: "已经在代码模式中。输入 /plan 切回计划模式。",
              },
            ]);
          } else {
            setSessionMode("code");
            sessionRef.current?.setMode("code");
            // 回到代码模式时重置工具调用策略，确保可以正常使用所有工具
            setToolChoice(undefined);
            setDisplayMessages((prev) => [
              ...prev,
              { role: "user", content: trimmed },
              {
                role: "assistant",
                content:
                  "🛠 已切换为 **代码模式**\n\n现在可以正常读取和修改代码了。\n输入 /plan 切换为计划模式（只读分析）。",
              },
            ]);
            // 清空会话历史，防止计划模式下产生的消息干扰代码模式
            sessionRef.current?.reset();
          }
          setInput("");
          return;
        }

        // /tools 命令：切换工具调用策略
        if (cmdLower === "/tools") {
          const next =
            toolChoice === undefined
              ? "none"
              : toolChoice === "none"
                ? "required"
                : toolChoice === "required"
                  ? "auto"
                  : undefined;
          setToolChoice(next);
          const label =
            next === undefined
              ? "自动（默认）"
              : next === "none"
                ? "禁止调用"
                : next === "required"
                  ? "强制调用"
                  : "自动（默认）";
          setDisplayMessages((prev) => [
            ...prev,
            { role: "user", content: trimmed },
            { role: "assistant", content: `工具调用策略已切换为 ${label}` },
          ]);
          setInput("");
          return;
        }

        const cmd = commandRegistry.get(cmdLower);
        if (cmd) {
          const result = cmd.handler();

          switch (result.kind) {
            case "exit":
              await sessionRef.current?.flushLog();
              process.exit(0);
              return;
            case "clear":
              // 清空所有会话状态，回到初始界面
              setDisplayMessages([]);
              setStaticKey((prev) => prev + 1);
              setInput("");
              setStreamError(undefined);
              // 先清屏再清滚动区，确保终端完全重置
              process.stdout.write("\x1b[2J\x1b[H\x1b[3J");
              // 重置 Session 历史
              sessionRef.current?.reset();
              // 批次边界同步复位（新 Session 的新 TodoList 从 id=0 开始）
              lastDoneBatchMaxIdRef.current = -1;
              return;
            case "navigate":
              setInput("");
              if (result.target === "game") {
                onLaunchGame?.();
              } else if (result.target === "stock") {
                onLaunchStock?.();
              }
              return;
            case "text":
              setDisplayMessages((prev) => [
                ...prev,
                { role: "user", content: trimmed },
                { role: "assistant", content: result.content },
              ]);
              setInput("");
              return;
          }
        }
        setDisplayMessages((prev) => [
          ...prev,
          { role: "user", content: trimmed },
          { role: "assistant", content: `未知命令：${trimmed}。输入 /help 查看。` },
        ]);
        setInput("");
        return;
      }

      // 检查 Session 是否就绪
      if (!sessionRef.current) {
        setDisplayMessages((prev) => [
          ...prev,
          { role: "user", content: trimmed },
          {
            role: "assistant",
            content: "⚠ 无法连接到 Provider。请检查 API Key 和网络配置。",
          },
        ]);
        setInput("");
        return;
      }

      // ---- 正常对话：接入 Agent 流式主循环 ----

      // 追加用户消息到显示列表
      setDisplayMessages((prev) => [...prev, { role: "user", content: trimmed }]);

      // 进入流式状态
      setInput("");
      // 重置流式状态
      setIsStreaming(true);
      setStreamingPhase("thinking");
      setStreamingPlaceholder(pickRandom(STREAMING_PLACEHOLDERS));
      setCurrentContent("");
      setCurrentReasoning([]);
      setCurrentToolCalls([]);
      setCurrentUsage(undefined);
      setCurrentElapsed(undefined);
      setCurrentCost(undefined);
      setStreamingModel(undefined);
      setStreamError(undefined);
      // 同步重置 ref
      currentContentRef.current = "";
      currentReasoningRef.current = [];
      currentToolCallsRef.current = [];
      currentUsageRef.current = undefined;
      currentElapsedRef.current = undefined;
      currentCostRef.current = undefined;
      currentModelRef.current = undefined;
      streamErrorRef.current = undefined;
      // 新一轮对话开始：清除上轮可能残留的 rewind 提示
      currentRoundModifiedRef.current = false;
      setRewindHintPhase("idle");
      if (rewindHintTimerRef.current) {
        clearTimeout(rewindHintTimerRef.current);
        rewindHintTimerRef.current = null;
      }
      // 新一轮对话开始：主动清空上轮残留的 todoSnapshot + 立即隐藏面板。
      // - 清空 snapshot：避免上轮最后一次 todo_mark_done 推的是 TodoList 内部数组引用、
      //   新一轮第一次 todo_add 又推同一引用导致 React bail out 后面板不刷新。
      // - 显式 setTodoPanelVisible(false)：清掉 effect 里的"2s 延迟隐藏"定时器，
      //   防止上一轮任务结束触发的延迟隐藏定时器在用户敲回车的瞬间把新任务的面板误关。
      setTodoSnapshot([]);
      if (todoHideTimerRef.current) {
        clearTimeout(todoHideTimerRef.current);
        todoHideTimerRef.current = null;
      }
      setTodoPanelVisible(false);

      const session = sessionRef.current;
      const abortController = new AbortController();
      abortRef.current = abortController;

      try {
        for await (const event of session.chat(trimmed, {
          thinkingAllowed: thinkingEnabled || undefined,
          thinkingEffort: thinkingEnabled ? thinkingEffort : undefined,
          responseFormat: responseFormat !== "text" ? responseFormat : undefined,
          toolChoice,
        })) {
          // 如果请求被取消，跳过后续事件
          if (abortController.signal.aborted) break;

          switch (event.type) {
            case "text_delta":
              setStreamingPhase("generating");
              setCurrentContent((prev) => {
                const next = prev + event.content;
                currentContentRef.current = next;
                return next;
              });
              break;

            case "reasoning_delta":
              // 思考链仍处于 thinking 阶段，UI 上以暗色块单独展示
              // 连续多段之间如果间隔了 text/tool 会被切为多个独立段，避免合并
              setStreamingPhase("thinking");
              setCurrentReasoning((prev) => {
                const last = prev[prev.length - 1];
                const next =
                  last !== undefined
                    ? [...prev.slice(0, -1), last + event.content]
                    : [...prev, event.content];
                currentReasoningRef.current = next;
                return next;
              });
              break;

            case "tool_calls":
              setStreamingPhase("calling_tools");
              setCurrentToolCalls((prev) => {
                const next = [...prev, ...event.calls];
                currentToolCallsRef.current = next;
                return next;
              });
              // 标记本轮是否触发了文件修改类工具调用
              for (const call of event.calls) {
                if (isFileMutatingTool(call.name)) {
                  currentRoundModifiedRef.current = true;
                  break;
                }
              }
              break;

            case "tool_result":
              // 工具执行完成 — 重置流式状态，准备接收模型的新一轮回复
              // 这是因为 Agent 循环会在工具执行后再次调用模型
              setStreamingPhase("executing_tools");
              // 延迟重置为思考中，表示模型正在处理工具结果进行下一轮推理
              setTimeout(() => setStreamingPhase("thinking"), 300);
              setCurrentContent("");
              currentContentRef.current = "";
              // 思考链：工具结果代表一个 sub-turn 结束，把“正在累积的那一段”封口（推 "" 占位），
              // 下一段思考会 push 到数组末尾，原有前几段保留可见。
              setCurrentReasoning((prev) => {
                const next = [...prev, ""];
                currentReasoningRef.current = next;
                return next;
              });
              setCurrentToolCalls([]);
              currentToolCallsRef.current = [];
              // 将工具结果追加为一条用户可见的消息
              const r = event.result;
              if (event.name.startsWith("todo_") && event.todoSnapshot) {
                // todo_* 工具：更新独立的任务进度 state（覆盖而非追加），不产生消息条目。
                // 拷贝一份 event.todoSnapshot，避免后续 TodoList 内部数组原地修改
                // 引起 React bail out 后面板不刷新。
                const snapshot = [...event.todoSnapshot];
                // 如果批次全部 terminated（done/failed/skipped），记录最大 id 作为批次边界，
                // 供下一批次过滤用。不在这里主动清空 snapshot（让 effect 的 2s 延迟统一处理隐藏）。
                const allTerminated =
                  snapshot.length > 0 &&
                  snapshot.every(
                    (it) =>
                      it.status === "done" ||
                      it.status === "failed" ||
                      it.status === "skipped",
                  );
                if (allTerminated) {
                  lastDoneBatchMaxIdRef.current = Math.max(...snapshot.map((it) => it.id));
                  setTodoSnapshot(snapshot);
                } else if (lastDoneBatchMaxIdRef.current >= 0) {
                  // 有上批次边界存在 → 过滤掉旧批次的 item（id ≤ 上批次最大 id）
                  setTodoSnapshot(
                    snapshot.filter((it) => it.id > lastDoneBatchMaxIdRef.current),
                  );
                } else {
                  setTodoSnapshot(snapshot);
                }
              } else {
                // 非 todo 工具：优先使用 summary（一行简短摘要），避免在 UI 中撑出大段文件内容
                const line = r.success
                  ? (r.summary ??
                    `✅ ${event.name}: ${r.data.slice(0, 500)}${r.data.length > 500 ? "..." : ""}`)
                  : `❌ ${event.name}: ${r.error ?? "执行失败"}`;
                setDisplayMessages((prev) => [
                  ...prev,
                  {
                    role: "tool" as const,
                    content: line,
                    diff: r.diff,
                  },
                ]);
              }
              break;

            case "usage":
              setCurrentUsage(event.usage);
              setStreamingModel(event.model);
              currentUsageRef.current = event.usage;
              currentModelRef.current = event.model;
              // 同步计算费用
              {
                // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
                const cost = calculateCost(
                  event.usage,
                  event.model as unknown as ModelId,
                );
                setCurrentCost(cost.totalCost);
                currentCostRef.current = cost.totalCost;
              }
              break;

            case "done":
              setCurrentElapsed(event.elapsed);
              currentElapsedRef.current = event.elapsed;
              break;

            case "error":
              setStreamError(event.error.message);
              streamErrorRef.current = event.error.message;
              break;
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        setStreamError(msg);
        streamErrorRef.current = msg;
      } finally {
        setIsStreaming(false);
        setStreamingPhase(null);
        setIdlePlaceholder(pickRandom(IDLE_PLACEHOLDERS));
        abortRef.current = null;

        // 流式结束后，用 ref 拿到最新值，直接追加完成的助手消息
        const finContent = currentContentRef.current;
        // 过滤掉占位的空串和首尾空白，避免在 UI 上生成空白思考块
        const finReasoning = currentReasoningRef.current
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        // 过滤掉 todo_* 工具：它们是任务进度的元数据，不在消息列表里展示
        // （TodoListPanel 独立维护了一份进度状态）
        const finToolCalls = filterTodoToolCalls(currentToolCallsRef.current);
        const finStreamError = streamErrorRef.current;

        if (finContent || finToolCalls || finStreamError) {
          const completed: CompletedAssistant = {
            content: finStreamError ? `⚠ 请求出错：${finStreamError}` : finContent || "",
            ...(finReasoning.length > 0 ? { reasoning: finReasoning } : {}),
            toolCalls: finToolCalls,
            usage: currentUsageRef.current,
            elapsed: currentElapsedRef.current,
            cost: currentCostRef.current,
            model: currentModelRef.current,
          };
          setDisplayMessages((prev) => [
            ...prev,
            {
              role: "assistant" as const,
              content: completed.content,
              assistantDetail: completed,
            },
          ]);
        }

        // 如果本轮触发了文件修改且无流错误 -> 2s 后展示 rewind 提示
        // 提示会一直保留到下次对话开始（流式再次启动）为止
        if (currentRoundModifiedRef.current && !finStreamError) {
          setRewindHintPhase("pending");
          if (rewindHintTimerRef.current) clearTimeout(rewindHintTimerRef.current);
          rewindHintTimerRef.current = setTimeout(() => {
            setRewindHintPhase((prev) => (prev === "pending" ? "visible" : prev));
            rewindHintTimerRef.current = null;
          }, 2000);
        }
      }
    },
    [
      onLaunchGame,
      onLaunchStock,
      currentContent,
      currentReasoning,
      currentToolCalls,
      skills,
      skillSelectIndex,
      getFilteredSkills,
      thinkingEnabled,
      thinkingEffort,
      responseFormat,
      toolChoice,
      activeModel,
      sessionMode,
      isStreaming,
      rewinding,
    ],
  );

  // 从 costTracker 更新今日消耗（每次流式结束后刷新）
  useEffect(() => {
    if (!isStreaming && externalCostTracker) {
      setTodayCost(externalCostTracker.todayTotalCost);
    }
  }, [isStreaming, externalCostTracker]);

  return (
    <Box flexDirection="column" paddingLeft={1} paddingRight={1}>
      {/* ===== 面板系统：左侧深度思考 | 右侧对话+输入 ===== */}
      <Box flexDirection="row" flexGrow={1}>

        {/* ========== 左侧面板（1/3 宽度） ========== */}
        <Box
          width={leftPanelWidth}
          flexShrink={0}
          flexDirection="column"
        >
          <Box
            paddingX={1}
            flexDirection="column"
            flexGrow={1}
            justifyContent={
              !hasConversationStarted ? "center" : "flex-end"
            }
          >
            {!hasConversationStarted ? (
              /* ===== 首页：Logo + 状态概况 ===== */
              <Box flexDirection="column" alignItems="center">
                {LOGO_LINES.map((line, i) => {
                  const colorIndex = (i + offset) % CYBER_PALETTE.length;
                  return (
                    <Text key={i} bold color={CYBER_PALETTE[colorIndex]}>
                      {line}
                    </Text>
                  );
                })}
                <Box marginTop={1}>
                  <Text color="#808080">{"📦 v"}{VERSION}</Text>
                </Box>
                <Box marginTop={1} flexDirection="column" alignItems="center">
                  <Text color="#00ff41">{"✔ "}{skillCount} Skills</Text>
                  <Text color="#00ffff">{"ℹ "}{toolCount} 工具</Text>
                  <Text color="#00ffff">
                    {"🔧 "}{SUPPORTED_MODELS[activeModel]?.displayName ?? activeModel}
                  </Text>
                  {thinkingEnabled && (
                    <Text color="#ff9800">
                      {"🧠 深度思考 "}{thinkingEffort === "max" ? "Max" : "High"}
                    </Text>
                  )}
                  {sessionMode === "plan" && (
                    <Text color="#ff69b4" bold>{"📋 计划模式"}</Text>
                  )}
                </Box>
                <Box marginTop={1} flexDirection="column" alignItems="center">
                  {balance !== null ? (
                    <Text color="yellow">{"💰 余额 ¥"}{balance.toFixed(2)}</Text>
                  ) : balanceLoading ? (
                    <Text color="yellow">{"⏳ 查询余额..."}</Text>
                  ) : null}
                  {todayCost !== null && (
                    <Text color="cyan">{"📊 今日 ¥"}{todayCost.toFixed(2)}</Text>
                  )}
                </Box>
                {verbose && <Text color="#ff1493">{"⚡ Verbose"}</Text>}
              </Box>
            ) : hasReasoningPanel ? (
              /* ===== 流式思考中（纯文本，无边框） ===== */
              <Text dimColor wrap="wrap">
                  {(() => {
                    const full = joinReasoningSegments(currentReasoning);
                    const maxContentLines = 11;
                    const lines = full.split("\n");
                    const kept = lines.slice(-maxContentLines);
                    // 填充空行到固定行数，防止布局抖动
                    while (kept.length < maxContentLines) {
                      kept.unshift("");
                    }
                    return kept.join("\n");
                  })()}
                </Text>
            ) : (
              /* ===== 对话中（无思考）：会话状态面板 ===== */
              <Box flexDirection="column" alignItems="center">
                <Text color="#00ffff" bold>{"💬 对话进行中"}</Text>
                <Box marginTop={1} flexDirection="column" alignItems="center">
                  <Text color="#00ff41">{"📝 消息 "}{displayMessages.length} 条</Text>
                  {sessionCost > 0 && (
                    <Text color="cyan">{"💰 会话 ¥"}{sessionCost.toFixed(4)}</Text>
                  )}
                </Box>
                <Box marginTop={1} flexDirection="column" alignItems="center">
                  <Text color="#808080">
                    {"🔧 "}{SUPPORTED_MODELS[activeModel]?.displayName ?? activeModel}
                  </Text>
                  {thinkingEnabled && (
                    <Text color="#ff9800">
                      {"🧠 "}{thinkingEffort === "max" ? "Max" : "High"}
                    </Text>
                  )}
                </Box>
                {balance !== null && (
                  <Box marginTop={1}>
                    <Text color="yellow">{"💰 ¥"}{balance.toFixed(2)}</Text>
                  </Box>
                )}
              </Box>
            )}
          </Box>
        </Box>

        {/* ========== 竖线分隔符 ========== */}
        <Box width={1} flexShrink={0}>
          <Text color="#444">{"│"}</Text>
        </Box>

        {/* ========== 右侧面板（2/3 宽度，useMemo 避免思考时重绘导致抖动） ========== */}
        {useMemo(() => (
          <Box flexDirection="column" flexGrow={1}>

            {/* ----- 对话消息区域 ----- */}
            <Box flexDirection="column" flexGrow={1}>
              {/* 首页右侧：DeepSeek 字符 Logo */}
              {!hasConversationStarted && (
                <Box flexDirection="column" alignItems="flex-start" flexGrow={1} paddingBottom={1}>
                  {/* 命令提示 — 居中显示 */}
                  {cmdTips.length > 0 && (() => {
                    const tip = cmdTips[cmdTipIndex % cmdTips.length];
                    if (!tip) return null;
                    const text = `${tip.name} ${tip.desc}`;
                    return (
                      <Box marginTop={1} alignSelf="center">
                        <Text color="#808080">{"💡 "}</Text>
                        {cmdTipGradientColors.length > 0 ? (
                          text.split("").map((ch, i) => (
                            <Text key={i} color={cmdTipGradientColors[i] || undefined}>
                              {ch}
                            </Text>
                          ))
                        ) : (
                          <Text color="#808080">{text}</Text>
                        )}
                      </Box>
                    );
                  })()}
                  {/* 撑满剩余空间 */}
                  <Box flexGrow={1} />
                  {/* Logo 固定底部，左对齐 */}
                  <AnimatedLogo panelWidth={rightContentWidth} />
                </Box>
              )}
              {/* 消息列表 */}
              <Box flexDirection="column" marginTop={1}>
                <Static key={staticKey} items={displayMessages}>
                  {(msg, i) => {
                    if (msg.role === "user") {
                      return (
                        <Box key={i} marginTop={1} flexDirection="row">
                          {/* 橙色竖线 — 表示用户发言 */}
                          <Box width={1} backgroundColor="#FF8C00" flexShrink={0} />
                          <Box flexGrow={1} paddingLeft={1}>
                            <Box flexDirection="row">
                              <Box width={4} flexShrink={0}>
                                <Text bold color="#FF8C00">{"💬"}</Text>
                              </Box>
                              <Box flexGrow={1}>
                                <Text wrap="wrap">{msg.content}</Text>
                              </Box>
                            </Box>
                          </Box>
                        </Box>
                      );
                    }
                    if (msg.role === "tool") {
                      return (
                        <Box key={i} marginTop={1} flexDirection="row">
                          {/* 灰色竖线 — 表示工具调用 */}
                          <Box width={1} backgroundColor="#666666" flexShrink={0} />
                          <Box flexGrow={1} paddingLeft={1} flexDirection="column">
                            <Box flexDirection="row">
                              <Box width={4} flexShrink={0}>
                                <Text dimColor>{"🔧"}</Text>
                              </Box>
                              <Box flexGrow={1}>
                                <Text dimColor wrap="wrap">{msg.content}</Text>
                              </Box>
                            </Box>
                            {msg.diff && <DiffPreview diff={msg.diff} />}
                          </Box>
                        </Box>
                      );
                    }
                    const detail = msg.assistantDetail;
                    return (
                      <AssistantMessage
                        key={i}
                        content={msg.content}
                        toolCalls={detail?.toolCalls}
                        isStreaming={false}
                        usage={detail?.usage}
                        elapsed={detail?.elapsed}
                        cost={detail?.cost}
                        model={detail?.model}
                      />
                    );
                  }}
                </Static>

                {isStreaming && (
                  <AssistantMessage
                    content={currentContent}
                    toolCalls={currentToolCalls.length > 0 ? currentToolCalls : undefined}
                    isStreaming={true}
                    usage={_currentUsage}
                    cost={_currentCost}
                    model={_streamingModel}
                  />
                )}

                {!isStreaming && streamError && (
                  <Box marginTop={1} marginLeft={3}>
                    <Text color="red">⚠ {streamError}</Text>
                  </Box>
                )}
              </Box>

              {/* Todo 进度面板 */}
              {todoPanelVisible && todoSnapshot.length > 0 && (
                <TodoListPanel items={todoSnapshot} />
              )}
            </Box>

            {/* ----- 输入区域（固定底部） ----- */}
            {selectingModel ? (
              <Box marginTop={1} flexDirection="column">
                <Text color="#00ffff" dimColor>
                  {"─".repeat(rightContentWidth)}
                </Text>
                <Box flexDirection="column" marginTop={1}>
                  <Text bold color="#00ffff">选择模型：</Text>
                  {modelOptions.map((id, i) => {
                    const meta = SUPPORTED_MODELS[id];
                    const isCurrent = id === activeModel;
                    const isSelected = i === modelSelectIndex;
                    const marker = isSelected ? " > " : "   ";
                    const suffix = isCurrent ? " (当前)" : "";
                    return (
                      <Box key={id}>
                        <Text color={isSelected ? "#00ff41" : undefined} bold={isSelected}>
                          {marker}{meta.displayName}{suffix}
                        </Text>
                        {isSelected && <Text color="#808080"> — {id}</Text>}
                      </Box>
                    );
                  })}
                  <Box marginTop={1}>
                    <Text color="#808080" dimColor>↑↓ 选择 · Enter 确认 · Esc 取消</Text>
                  </Box>
                </Box>
                <Text color="#00ffff" dimColor>
                  {"─".repeat(rightContentWidth)}
                </Text>
              </Box>
            ) : rewindSelecting ? (
              <Box marginTop={1} flexDirection="column">
                <Text color="#00ffff" dimColor>
                  {"─".repeat(rightContentWidth)}
                </Text>
                <Box flexDirection="column" marginTop={1}>
                  <Text bold color="#ff9800">选择要回退的检查点：</Text>
                  {rewindList.map((cp, i) => {
                    const isSelected = i === rewindSelectIndex;
                    const marker = isSelected ? " > " : "   ";
                    const time = new Date(cp.timestamp).toLocaleTimeString();
                    const preview = cp.preview || "(空)";
                    const tag = cp.isGitRepo ? "" : " [非 git，仅对话]";
                    return (
                      <Box key={cp.index}>
                        <Text color={isSelected ? "#ff9800" : undefined} bold={isSelected}>
                          {marker}#{i + 1} {time} `{preview}{tag}`
                        </Text>
                      </Box>
                    );
                  })}
                  <Box marginTop={1}>
                    <Text color="#808080" dimColor>↑↓ 选择 · Enter 确认 · Esc 取消</Text>
                  </Box>
                </Box>
                <Text color="#00ffff" dimColor>
                  {"─".repeat(rightContentWidth)}
                </Text>
              </Box>
            ) : (
              <>
                {/* 流式状态 / rewind 提示 */}
                {(hasConversationStarted || sessionMode === "plan") &&
                isStreaming &&
                streamingPhase ? (
                  <Box marginTop={1} justifyContent="center">
                    <Text bold color={PHASE_CONFIG[streamingPhase].color}>
                      {PHASE_CONFIG[streamingPhase].icon} {PHASE_CONFIG[streamingPhase].label}{" "}
                      <InkSpinner type="dots" />
                    </Text>
                  </Box>
                ) : rewindHintPhase === "visible" ? (
                  <Box marginTop={1} justifyContent="center">
                    <Text color="#808080">{"↩ /rewind 1 可撤回本次修改"}</Text>
                  </Box>
                ) : null}

                {/* 分隔线 */}
                <Box marginTop={1}>
                  <Text color="#00ffff" dimColor>
                    {"─".repeat(rightContentWidth)}
                  </Text>
                </Box>

                {/* 输入框 */}
                <Box>
                  <Box width={4} flexShrink={0}>
                    <Text bold color="#00ff41">{"⚡"}</Text>
                  </Box>
                  <Box flexGrow={1}>
                    {!input && !isStreaming && idlePlaceholder && gradientColors.length > 0 ? (
                      <Text>
                        {idlePlaceholder.split("").map((ch, i) => (
                          <Text key={i} color={gradientColors[i] ?? undefined}>{ch}</Text>
                        ))}
                      </Text>
                    ) : !input && isStreaming && streamingPlaceholder && streamingGradientColors.length > 0 ? (
                      <Text>
                        {streamingPlaceholder.split("").map((ch, i) => (
                          <Text key={i} color={streamingGradientColors[i] ?? undefined}>{ch}</Text>
                        ))}
                      </Text>
                    ) : (
                      <TextInput
                        key={inputKey}
                        value={input}
                        onChange={setInput}
                        onSubmit={handleSubmit}
                        placeholder=""
                      />
                    )}
                  </Box>
                </Box>
                <Box>
                  <Text color="#00ffff" dimColor>
                    {"─".repeat(rightContentWidth)}
                  </Text>
                </Box>

                <SkillSelector skills={skills} input={input} selectedIndex={skillSelectIndex} />
                <FileSelector files={files} input={input} selectedIndex={fileSelectIndex} />
              </>
            )}
          </Box>
        ), [
          displayMessages, staticKey, isStreaming,
          currentContent, currentToolCalls, _currentUsage, _currentCost, _streamingModel,
          streamError, todoSnapshot, todoPanelVisible,
          selectingModel, modelOptions, activeModel, modelSelectIndex,
          setActiveModel, setModelSelectIndex,
          rewindSelecting, rewindList, rewindSelectIndex,
          setRewindSelecting, setRewindSelectIndex,
          rewindHintPhase, hasConversationStarted, sessionMode,
          streamingPhase,
          idlePlaceholder, gradientColors,
          streamingPlaceholder, streamingGradientColors,
          input, setInput, rightContentWidth, handleSubmit,
          skills, skillSelectIndex, files, fileSelectIndex,
          inputKey, cmdTips, cmdTipIndex, cmdTipGradientColors,
          doubleCtrlC,
        ])}
      </Box>

      {/* 底部提示 — 全宽 */}
      {doubleCtrlC && !isStreaming && (
        <Box marginTop={1}>
          <Text color="#ff1493" bold>{"  ⚠ 再按一次 Ctrl+C 退出 dskcode"}</Text>
        </Box>
      )}
      {isStreaming && (
        <Box marginTop={1}>
          <Text color="yellow" dimColor>{"  提示：按 Ctrl+C 取消当前请求"}</Text>
        </Box>
      )}
    </Box>
  );
}
