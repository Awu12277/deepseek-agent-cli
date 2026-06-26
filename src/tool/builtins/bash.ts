// ---------------------------------------------------------------------------
// bash 工具 — 执行 shell 命令
// ---------------------------------------------------------------------------

import process from "node:process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ToolKind, type AgentTool, type ToolContext, type ToolResult } from "../types.js";
import { execCommand, truncateOutput, getDefaultTimeout } from "../sandbox.js";

/** 是否为 Windows 平台 */
const isWindows = process.platform === "win32";

interface DetectResult {
  /** shell 可执行文件路径，Windows 未找到 Git Bash 时为 null */
  bin: string | null;
  /** shell 调用参数前缀，bash 用 ["-c"]，cmd 用 ["/c"] */
  args: string[];
  /** 给 LLM 看的 shell 名称 */
  label: string;
  /** 给 LLM 看的语法指引 */
  hint: string;
}

/**
 * 探测本机可用的 bash。
 *
 * Windows 上优先 Git Bash（命令语法与 Unix 一致，跨平台命令可复用），
 * 找不到才回退 cmd.exe。这样 LLM 生成的 `pwd && ls` 在装有 Git Bash 的
 * Windows 机器上能直接跑通，不再像旧的“硬走 cmd”实现那样在中文
 * GBK 报错里循环重试（见曾经的日志
 * e3cb5aff-34c0-499a-a3be-dee13c18d14f 中 round 2-6 的 EXIT_CODE_1 风暴）。
 */
function detectShell(): DetectResult {
  if (!isWindows) {
    return {
      bin: "sh",
      args: ["-c"],
      label: "sh",
      hint: "当前 shell 是 bash 兼容语法，支持 pwd/ls/&&/管道等标准 Unix 工具。",
    };
  }

  // 1. 用户显式指定的 bash 路径（优先级最高）
  const envBash = process.env.DSKCODE_BASH;
  if (envBash && existsSync(envBash)) {
    return { bin: envBash, args: ["-c"], label: "Git Bash", hint: SHELL_HINT_BASH };
  }

  // 2. 常见 Git for Windows 安装位置（C/D 盘 × Program Files × LocalAppData）
  //    同时覆盖 64 位默认目录与 32 位兼容目录，以及单用户安装。
  const roots = [
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Programs") : null,
    // 非 C 盘安装（你机器就是 D 盘），枚举几个常见盘符根
    "D:\\Program Files",
    "E:\\Program Files",
  ].filter((v): v is string => Boolean(v));

  for (const root of roots) {
    for (const sub of ["Git\\bin\\bash.exe", "Git\\usr\\bin\\bash.exe"]) {
      const candidate = join(root, sub);
      if (existsSync(candidate)) {
        return { bin: candidate, args: ["-c"], label: "Git Bash", hint: SHELL_HINT_BASH };
      }
    }
  }

  // 3. 回退 cmd.exe —— 命令语法不同，要在 hint 里明确告知 LLM
  return {
    bin: "cmd",
    args: ["/c"],
    label: "cmd.exe",
    hint:
      "当前 shell 是 Windows cmd.exe。请使用 cmd 语法：路径用反斜杠或正斜杠均可、命令链用 & 或换行，避免使用 pwd/ls/&& 等 Unix 命令。",
  };
}

/** Git Bash 检出后给 LLM 的语法提示 */
const SHELL_HINT_BASH =
  "当前 shell 是 bash 兼容语法，支持 pwd/ls/&&/管道等标准 Unix 工具。";

const SHELL_INFO = detectShell();

/** bash 工具的参数格式 */
export interface BashArgs {
  /** 要执行的命令 */
  command: string;
  /** 执行超时时间（毫秒），默认 30000 */
  timeout?: number;
}

/** 仅供测试导出当前探测到的 shell 信息（不参与运行期逻辑） */
export const __shellInfo = SHELL_INFO;

/**
 * bash 工具 — 在 shell 中执行命令。
 */
export const bashTool: AgentTool<BashArgs> = {
  name: "bash",
  kind: ToolKind.Other,
  description: [
    "在 shell 中执行命令，返回 stdout / stderr / 退出码。支持超时控制和信号中止。",
    `当前 shell：${SHELL_INFO.label}。${SHELL_INFO.hint}`,
    "读取文件请优先使用 read_file 工具，不要用 cat/type/Get-Content；",
    "搜索代码用 grep / glob，列目录用 ls——这些专用工具在所有平台都可用且无需关心 shell 语法。",
  ].join(""),
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: `要执行的 shell 命令（当前 shell：${SHELL_INFO.label}）`,
      },
      timeout: {
        type: "number",
        description: "执行超时时间（毫秒），默认 30000",
      },
    },
    required: ["command"],
    additionalProperties: false,
  },

  async execute(args: BashArgs, ctx: ToolContext): Promise<ToolResult> {
    if (!args?.command || typeof args.command !== "string") {
      return { success: false, data: "缺少必要参数 command", error: "INVALID_ARGS" };
    }

    const timeout = args.timeout ?? ctx.timeout ?? getDefaultTimeout();

    try {
      // shell 已在启动期按平台探测好：Windows 走 Git Bash，没有才回退 cmd
      const shellCommand = SHELL_INFO.bin ?? "cmd";
      const shellArgs = [...SHELL_INFO.args, args.command];

      const result = await execCommand(
        shellCommand,
        shellArgs,
        ctx.cwd,
        timeout,
        ctx.signal,
        true,
      );

      const parts: string[] = [];
      if (result.stdout) {
        parts.push(truncateOutput(result.stdout));
      }
      if (result.stderr) {
        parts.push(`[stderr]\n${truncateOutput(result.stderr)}`);
      }

      const success = result.exitCode === 0;
      const output = parts.length > 0 ? parts.join("\n") : "(无输出)";

      const cmdPreview = args.command.length > 60
        ? args.command.slice(0, 57) + "..."
        : args.command;
      const summary = `🔧 $ ${cmdPreview}（exit ${result.exitCode ?? "未知"}）`;

      return {
        success,
        data: `${output}\n[退出码: ${result.exitCode ?? "未知"}]`,
        summary,
        error: success ? undefined : `EXIT_CODE_${result.exitCode ?? "UNKNOWN"}`,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        data: `命令执行失败：${message}`,
        error: "EXECUTION_ERROR",
      };
    }
  },
};
