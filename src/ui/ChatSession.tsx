// ---------------------------------------------------------------------------
// 交互式聊天会话组件 — 接入 Agent 主循环，实现流式对话
// ---------------------------------------------------------------------------

import { Box, Text, useInput, Static } from "ink";
import TextInput from "ink-text-input";
import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { useDoubleCtrlC } from "./useDoubleCtrlC.js";
import { CYBER_PALETTE, LOGO_LINES } from "./DskcodeSplash.js";
import { Spinner } from "./Spinner.js";
import InkSpinner from "ink-spinner";
import { AssistantMessage } from "./AssistantMessage.js";
import { DiffPreview } from "./DiffPreview.js";
import { SkillSelector } from "./SkillSelector.js";
import { FileSelector } from "./FileSelector.js";
import type { SkillInfo } from "../cli/skill-import.js";
import { CostTracker } from "../provider/cost-tracker.js";
import type { ModelId, ProviderToolCall, UsageInfo } from "../provider/index.js";
import type { FileDiff } from "../tool/types.js";
import { createProvider } from "../provider/index.js";
import { Session } from "../agent/index.js";
import type { AgentEvent } from "../agent/types.js";
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
import { saveModelConfig } from "../config/loader.js";

/** 命令处理结果的类型，支持文本响应和动作跳转 */
export type CommandAction =
  | { kind: "text"; content: string }
  | { kind: "exit" }
  | { kind: "clear" }
  | { kind: "navigate"; target: "game" | "stock" };

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
registerCommand("/version", { desc: "显示版本信息", handler: () => ({ kind: "text", content: "dskcode v0.1.10" }) });
registerCommand("/model", { desc: "切换模型", handler: () => ({ kind: "text", content: "请直接输入 /model 进入选择界面" }) });
registerCommand("/thinking", { desc: "切换深度思考模式", handler: () => ({ kind: "text", content: "请直接输入 /thinking 切换" }) });
registerCommand("/effort", { desc: "切换推理等级 High/Max", handler: () => ({ kind: "text", content: "请直接输入 /effort 切换" }) });
registerCommand("/game", { desc: "启动游戏", handler: () => ({ kind: "navigate", target: "game" }) });
registerCommand("/stock", { desc: "查看股票行情", handler: () => ({ kind: "navigate", target: "stock" }) });

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
  const termWidth = typeof process.stdout.columns === "number" ? process.stdout.columns : 80;
  const dividerWidth = Math.max(termWidth - 2, 1);

  const [offset, setOffset] = useState(0);
  const [displayMessages, setDisplayMessages] = useState<DisplayMessage[]>([]);
  const [staticKey, setStaticKey] = useState(0);
  const [input, setInput] = useState("");
  const [balance, setBalance] = useState<number | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [todayCost, setTodayCost] = useState<number | null>(null);

  // 流式状态
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingPlaceholder, setStreamingPlaceholder] = useState("");
  const [idlePlaceholder, setIdlePlaceholder] = useState(() => pickRandom(IDLE_PLACEHOLDERS));
  const [gradientColors, setGradientColors] = useState<string[]>([]);
  const gradientPhaseRef = useRef(0);
  const [streamingGradientColors, setStreamingGradientColors] = useState<string[]>([]);
  const streamingPhaseRef = useRef(0);
  const [currentContent, setCurrentContent] = useState("");
  const [currentToolCalls, setCurrentToolCalls] = useState<ProviderToolCall[]>([]);
  const [currentUsage, setCurrentUsage] = useState<UsageInfo | undefined>(undefined);
  const [currentElapsed, setCurrentElapsed] = useState<number | undefined>(undefined);
  const [currentCost, setCurrentCost] = useState<number | undefined>(undefined);
  const [activeModel, setActiveModel] = useState<ModelId>(model as ModelId);
  const [streamingModel, setStreamingModel] = useState<string | undefined>(undefined);
  const [streamError, setStreamError] = useState<string | undefined>(undefined);

  // 高级设置
  const [thinkingEnabled, setThinkingEnabled] = useState(true);
  const [thinkingEffort, setThinkingEffort] = useState<"high" | "max">("high");
  const [responseFormat, setResponseFormat] = useState<"text" | "json_object">("text");
  const [toolChoice, setToolChoice] = useState<"auto" | "required" | "none" | undefined>(undefined);

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

  // 模型选择模式
  const [selectingModel, setSelectingModel] = useState(false);
  const [modelSelectIndex, setModelSelectIndex] = useState(0);
  const modelOptions: ModelId[] = ["deepseek-v4-flash", "deepseek-v4-pro"];

  // Session 引用（保持跨渲染稳定）
  const sessionRef = useRef<Session | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // 用 ref 跟踪流式内容的最新值，以便 finally 块能获取非闭包过期的值
  const currentContentRef = useRef("");
  const currentToolCallsRef = useRef<ProviderToolCall[]>([]);
  const currentUsageRef = useRef<UsageInfo | undefined>(undefined);
  const currentElapsedRef = useRef<number | undefined>(undefined);
  const currentCostRef = useRef<number | undefined>(undefined);
  const currentModelRef = useRef<string | undefined>(undefined);
  const streamErrorRef = useRef<string | undefined>(undefined);

  // 输入变更时重置选择索引
  useEffect(() => {
    setSkillSelectIndex(0);
    setFileSelectIndex(0);
  }, [input]);

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

  const { doubleCtrlC, handleCtrlC } = useDoubleCtrlC(() => {
    // 双击 Ctrl+C 退出进程
    process.exit(0);
  });

  // 捕获 Ctrl+C 和渐变占位符状态下的字符输入
  useInput(
    useCallback(
      (_input, key) => {
        // 模型选择模式
        if (selectingModel) {
          if (key.upArrow) {
            setModelSelectIndex((prev) => (prev - 1 + modelOptions.length) % modelOptions.length);
          } else if (key.downArrow) {
            setModelSelectIndex((prev) => (prev + 1) % modelOptions.length);
          } else if (key.return) {
            const selected = modelOptions[modelSelectIndex]!;
            if (selected === activeModel) {
              setDisplayMessages((prev) => [
                ...prev,
                { role: "assistant", content: `已经在使用 ${SUPPORTED_MODELS[selected].displayName}` },
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
                { role: "assistant", content: `模型已切换为 ${SUPPORTED_MODELS[selected].displayName}（${selected}）` },
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
            setSkillSelectIndex((prev) => (prev - 1 + skillList.length) % skillList.length);
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

        // 渐变占位符显示时（TextInput 未渲染），将按键字符加入 input 触发切换
        if (!input && !isStreaming && _input) {
          setInput(_input);
        }
      },
      [selectingModel, modelSelectIndex, modelOptions, activeModel, isStreaming, handleCtrlC, input, skills, skillSelectIndex, fileSelectIndex, getFilteredSkills, getFilteredFiles]
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
      cmdTipPhaseRef.current = (cmdTipPhaseRef.current + GRADIENT_ANIMATION.cmdTipPhaseStep) % 1;
      // 反向 phase 使色彩从左到右流动
      setCmdTipGradientColors(getGradientColors(text, 1 - cmdTipPhaseRef.current, CMD_TIP_GRADIENT_STOPS));
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
    import("../provider/deepseek.js").then(({ DeepSeekProvider }) => {
      const provider = new DeepSeekProvider({
        apiKey,
        baseUrl,
        model: "deepseek-v4-flash",
      });
      return provider.getBalance();
    }).then((result) => {
      if (cancelled) return;
      const cny = result.balances.find((b) => b.currency === "CNY");
      if (cny) {
        setBalance(cny.totalBalance);
      }
    }).catch(() => {
      // 查询失败静默处理，不影响主流程
    }).finally(() => {
      if (!cancelled) setBalanceLoading(false);
    });
    return () => { cancelled = true; };
  }, [apiKey, baseUrl]);

  // 加载今日消耗历史数据，并定时刷新
  useEffect(() => {
    if (!externalCostTracker) return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    const refresh = () => {
      setTodayCost(externalCostTracker.todayTotalCost);
    };

    externalCostTracker.load().then(() => {
      if (cancelled) return;
      refresh();
      timer = setInterval(refresh, 5000);
    }).catch(() => {
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
      gradientPhaseRef.current = (gradientPhaseRef.current + GRADIENT_ANIMATION.idlePhaseStep) % 1;
      setGradientColors(getGradientColors(idlePlaceholder, 1 - gradientPhaseRef.current, IDLE_GRADIENT_STOPS));
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
    setStreamingGradientColors(getGradientColors(streamingPlaceholder, 1, STREAMING_GRADIENT_STOPS));

    const interval = setInterval(() => {
      streamingPhaseRef.current = (streamingPhaseRef.current + GRADIENT_ANIMATION.streamingPhaseStep) % 1;
      setStreamingGradientColors(getGradientColors(streamingPlaceholder, 1 - streamingPhaseRef.current, STREAMING_GRADIENT_STOPS));
    }, GRADIENT_ANIMATION.streamingInterval);

    return () => clearInterval(interval);
  }, [isStreaming, streamingPlaceholder]);

  /** 处理用户输入 */
  const handleSubmit = useCallback(async (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;

    // 处理斜杠命令
    if (trimmed.startsWith("/") && trimmed.length > 1) {
      const cmdLower = trimmed.toLowerCase();

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
          { role: "assistant", content: `深度思考已${thinkingEnabled ? "关闭" : "开启"}` },
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
          { role: "assistant", content: `推理等级已切换为 ${next === "high" ? "High" : "Max"}` },
        ]);
        setInput("");
        return;
      }



      // /tools 命令：切换工具调用策略
      if (cmdLower === "/tools") {
        const next = toolChoice === undefined ? "none"
          : toolChoice === "none" ? "required"
          : toolChoice === "required" ? "auto"
          : undefined;
        setToolChoice(next);
        const label = next === undefined ? "自动（默认）"
          : next === "none" ? "禁止调用"
          : next === "required" ? "强制调用"
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
        { role: "assistant", content: "⚠ 无法连接到 Provider。请检查 API Key 和网络配置。" },
      ]);
      setInput("");
      return;
    }

    // ---- 正常对话：接入 Agent 流式主循环 ----

    // 追加用户消息到显示列表
    setDisplayMessages((prev) => [
      ...prev,
      { role: "user", content: trimmed },
    ]);

    // 进入流式状态
    setInput("");
    // 重置流式状态
    setIsStreaming(true);
    setStreamingPlaceholder(pickRandom(STREAMING_PLACEHOLDERS));
    setCurrentContent("");
    setCurrentToolCalls([]);
    setCurrentUsage(undefined);
    setCurrentElapsed(undefined);
    setCurrentCost(undefined);
    setStreamingModel(undefined);
    setStreamError(undefined);
    // 同步重置 ref
    currentContentRef.current = "";
    currentToolCallsRef.current = [];
    currentUsageRef.current = undefined;
    currentElapsedRef.current = undefined;
    currentCostRef.current = undefined;
    currentModelRef.current = undefined;
    streamErrorRef.current = undefined;

    const session = sessionRef.current;
    const abortController = new AbortController();
    abortRef.current = abortController;

    try {
      for await (const event of session!.chat(trimmed, {
        thinkingAllowed: thinkingEnabled || undefined,
        thinkingEffort: thinkingEnabled ? thinkingEffort : undefined,
        responseFormat: responseFormat !== "text" ? responseFormat : undefined,
        toolChoice,
      })) {
        // 如果请求被取消，跳过后续事件
        if (abortController.signal.aborted) break;

        switch (event.type) {
          case "text_delta":
            setCurrentContent((prev) => {
              const next = prev + event.content;
              currentContentRef.current = next;
              return next;
            });
            break;

          case "tool_calls":
            setCurrentToolCalls((prev) => {
              const next = [...prev, ...event.calls];
              currentToolCallsRef.current = next;
              return next;
            });
            break;

          case "tool_result":
            // 工具执行完成 — 重置流式状态，准备接收模型的新一轮回复
            // 这是因为 Agent 循环会在工具执行后再次调用模型
            setCurrentContent("");
            currentContentRef.current = "";
            setCurrentToolCalls([]);
            currentToolCallsRef.current = [];
            // 将工具结果追加为一条用户可见的消息
            // 优先使用工具提供的 summary（一行简短摘要），避免在 UI 中撑出大段文件内容
            const r = event.result;
            const line = r.success
              ? r.summary ?? `✅ ${event.name}: ${r.data.slice(0, 500)}${r.data.length > 500 ? "..." : ""}`
              : `❌ ${event.name}: ${r.error ?? "执行失败"}`;
            setDisplayMessages((prev) => [
              ...prev,
              {
                role: "tool" as const,
                content: line,
                diff: r.diff,
              },
            ]);
            break;

          case "usage":
            setCurrentUsage(event.usage);
            setStreamingModel(event.model);
            currentUsageRef.current = event.usage;
            currentModelRef.current = event.model;
            // 同步计算费用
            {
              const cost = calculateCost(event.usage, event.model as ModelId);
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
      setIdlePlaceholder(pickRandom(IDLE_PLACEHOLDERS));
      abortRef.current = null;

      // 流式结束后，用 ref 拿到最新值，直接追加完成的助手消息
      const finContent = currentContentRef.current;
      const finToolCalls = currentToolCallsRef.current.length > 0 ? currentToolCallsRef.current : undefined;
      const finStreamError = streamErrorRef.current;

      if (finContent || finToolCalls || finStreamError) {
        const completed: CompletedAssistant = {
          content: finStreamError ? `⚠ 请求出错：${finStreamError}` : (finContent || ""),
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
    }
  }, [onLaunchGame, onLaunchStock, currentContent, currentToolCalls, skills, skillSelectIndex, getFilteredSkills, thinkingEnabled, thinkingEffort, responseFormat, toolChoice, activeModel]);

  // 从 costTracker 更新今日消耗（每次流式结束后刷新）
  useEffect(() => {
    if (!isStreaming && externalCostTracker) {
      setTodayCost(externalCostTracker.todayTotalCost);
    }
  }, [isStreaming, externalCostTracker]);



  return (
    <Box flexDirection="column" paddingLeft={1} paddingRight={1}>
      {/* Logo + 状态栏 + 余额 — 三栏布局（仅对话未开始时显示） */}
      {!hasConversationStarted && (
        <Box flexDirection="row" marginBottom={1}>
          {/* Logo */}
          <Box flexDirection="column" marginRight={4}>
            {LOGO_LINES.map((line, i) => {
              const colorIndex = (i + offset) % CYBER_PALETTE.length;
              return (
                <Box key={i}>
                  <Text bold color={CYBER_PALETTE[colorIndex]}>
                    {line}
                  </Text>
                </Box>
              );
            })}
          </Box>

          {/* 状态信息 */}
          <Box flexDirection="column" justifyContent="center">
            <Text color="#00ff41">{"  ✔ "}已就绪 {skillCount} 个 Skill</Text>
            <Text color="#00ffff">{"  ℹ "}已就绪 {toolCount} 个工具</Text>
            <Text color="#00ffff">{"  🔧 模型 "}{SUPPORTED_MODELS[activeModel]?.displayName ?? activeModel}</Text>
            {thinkingEnabled && (
              <Text color="#ff9800">{"  🧠 深度思考 "}{thinkingEffort === "max" ? "Max" : "High"}</Text>
            )}
            {responseFormat === "json_object" && (
              <Text color="#4caf50">{"  📄 JSON"}</Text>
            )}
            {toolChoice !== undefined && (
              <Text color="#e91e63">{"  🛠 "}{
                toolChoice === "none" ? "禁止工具"
                : toolChoice === "required" ? "强制工具"
                : ""
              }</Text>
            )}
            {/* 命令提示轮播 */}
            {cmdTips.length > 0 && (() => {
              const tip = cmdTips[cmdTipIndex % cmdTips.length];
              if (!tip) return null;
              const text = `${tip.name} ${tip.desc}`;
              return (
                <Text>
                  <Text color="#808080">{"  💡 "}</Text>
                  {cmdTipGradientColors.length > 0
                    ? text.split("").map((ch, i) => (
                        <Text key={i} color={cmdTipGradientColors[i] || undefined}>{ch}</Text>
                      ))
                    : <Text color="#808080">{text}</Text>}
                </Text>
              );
            })()}
            {verbose ? <Text color="#ff1493">{"  ⚡ Verbose"}</Text> : null}
          </Box>

          {/* 右侧余额 + 今日消耗 */}
          <Box flexGrow={1} flexDirection="column" justifyContent="center" alignItems="flex-end">
            {balanceLoading && balance === null ? (
              <Text color="yellow">{"  ⏳ 查询余额..."}</Text>
            ) : balance !== null ? (
              <Box flexDirection="row">
                <Text color="yellow">{"💰 "}</Text>
                <Text color="yellow">{"余额 ¥"}{balance.toFixed(2)}</Text>
              </Box>
            ) : null}
            {todayCost !== null ? (
              <Box flexDirection="row">
                <Text color="cyan">{"📊 "}</Text>
                <Text color="cyan">{"今日 ¥"}{todayCost.toFixed(2)}</Text>
              </Box>
            ) : null}
          </Box>
        </Box>
      )}

      {/* 消息列表 - 已完成的消息用 Static 固定，避免重绘时丢失滚动位置 */}
      <Box flexDirection="column" marginTop={1}>
        <Static key={staticKey} items={displayMessages}>
          {(msg, i) => {
            if (msg.role === "user") {
              return (
                <Box key={i} marginTop={1}>
                  <Box width={4} flexShrink={0}>
                    <Text bold color="#00ff41">{"👤"}</Text>
                  </Box>
                  <Box flexGrow={1}>
                    <Text wrap="wrap">{msg.content}</Text>
                  </Box>
                </Box>
              );
            }

            // 工具消息 — 显示文本内容 + Diff 预览
            if (msg.role === "tool") {
              return (
                <Box key={i} marginTop={1} flexDirection="column">
                  <Box flexDirection="row">
                    <Box width={4} flexShrink={0}>
                      <Text bold color="#f59e0b">{"🔧"}</Text>
                    </Box>
                    <Box flexGrow={1}>
                      <Text wrap="wrap">{msg.content}</Text>
                    </Box>
                  </Box>
                  {msg.diff && <DiffPreview diff={msg.diff} />}
                </Box>
              );
            }

            // 已完成的助手消息
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

        {/* 正在流式输出的助手消息 */}
        {isStreaming && (
          <AssistantMessage
            content={currentContent}
            toolCalls={currentToolCalls.length > 0 ? currentToolCalls : undefined}
            isStreaming={true}
          />
        )}

        {/* 思考中 Spinner */}
        {isStreaming && !currentContent && currentToolCalls.length === 0 && (
          <Box marginTop={1} marginLeft={4}>
            <Spinner type="dots" label="思考中..." />
          </Box>
        )}

        {/* 错误信息（流式结束后显示） */}
        {!isStreaming && streamError && (
          <Box marginTop={1} marginLeft={3}>
            <Text color="red">⚠ {streamError}</Text>
          </Box>
        )}
      </Box>

      {/* 输入区 */}
      {selectingModel ? (
        <Box marginTop={1} flexDirection="column">
          <Text color="#00ffff" dimColor>{"─".repeat(dividerWidth)}</Text>
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
                  <Text
                    color={isSelected ? "#00ff41" : undefined}
                    bold={isSelected}
                  >
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
          <Text color="#00ffff" dimColor>{"─".repeat(dividerWidth)}</Text>
        </Box>
      ) : (
        <>
          <Box marginTop={1}>
            {hasConversationStarted && (balance !== null || sessionCost > 0 || isStreaming) ? (
              <Text color="#00ffff" dimColor>
                {"─".repeat(Math.max(dividerWidth - 35, 10))}
                {balance !== null && (
                  <Text color="yellow">{" 💰 余额 ¥"}{balance.toFixed(2)}</Text>
                )}
                {isStreaming ? (
                  <Text color="cyan">{"  📊 本次 ¥"}{sessionCost > 0 ? sessionCost.toFixed(4) + " " : ""}<InkSpinner type="dots" /></Text>
                ) : sessionCost > 0 ? (
                  <Text color="cyan">{"  📊 本次 ¥"}{sessionCost.toFixed(4)}</Text>
                ) : null}
              </Text>
            ) : (
              <Text color="#00ffff" dimColor>{"─".repeat(dividerWidth)}</Text>
            )}
          </Box>
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
            <Text color="#00ffff" dimColor>{"─".repeat(dividerWidth)}</Text>
          </Box>

          {/* 用户输入 / 时显示 skill 列表 */}
          <SkillSelector skills={skills} input={input} selectedIndex={skillSelectIndex} />
          {/* 用户输入 @ 时显示文件列表 */}
          <FileSelector files={files} input={input} selectedIndex={fileSelectIndex} />
        </>
      )}

      {/* 双击 Ctrl+C 退出提示 */}
      {doubleCtrlC && !isStreaming && (
        <Box marginTop={1}>
          <Text color="#ff1493" bold>
            {"  ⚠ 再按一次 Ctrl+C 退出 dskcode"}
          </Text>
        </Box>
      )}

      {/* 流式中 Ctrl+C 取消提示 */}
      {isStreaming && (
        <Box marginTop={1}>
          <Text color="yellow" dimColor>
            {"  提示：按 Ctrl+C 取消当前请求"}
          </Text>
        </Box>
      )}
    </Box>
  );
}
