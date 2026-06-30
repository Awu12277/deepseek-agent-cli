// ---------------------------------------------------------------------------
// 工具执行沙箱 — 路径约束、路径安全、超时控制、输出截断
// ---------------------------------------------------------------------------

import { resolve, relative, isAbsolute } from "node:path";
import { realpath } from "node:fs/promises";
import { spawn } from "node:child_process";
import process from "node:process";

/** 沙箱默认配置 */
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_LENGTH = 50_000;
const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

/** 是否为 Windows 平台 */
const isWindows = process.platform === "win32";

// ---------------------------------------------------------------------------
// 路径安全 — confine / resolveIn / realPath
// ---------------------------------------------------------------------------

/**
 * 剩下一个开头的 `@` 引用标记。
 *
 * system prompt 把 `@<路径>` 定义为「文件路径引用」语法，但 LLM 经常把
 * `@test.ts` 原样传给工具，导致 read_file 拼出 `cwd\@test.ts` 而 ENOENT
 * （见会话日志 e65f0205 round 0）。`@` 不可能是一段真实路径的合法首字符，
 * 在路径解析边界统一剩下一个 `@` 即可让该语法在所有走 resolvePath 的工具上生效。
 * glob/grep 不走 resolvePath，可在解析 `directory` 参数时复用本函数。
 */
export function stripMentionPrefix(inputPath: string): string {
  if (inputPath.startsWith("@")) return inputPath.slice(1);
  return inputPath;
}

/**
 * 将路径解析为绝对路径。
 * 相对路径基于 cwd 解析，绝对路径原样返回。会先剩下一个开头的 `@` 引用标记。
 */
export function resolvePath(inputPath: string, cwd: string): string {
  const stripped = stripMentionPrefix(inputPath);
  const resolved = isAbsolute(stripped) ? stripped : resolve(cwd, stripped);
  return resolve(resolved);
}

/**
 * 获取路径的真实路径（解析符号链接）。
 * 如果路径不存在，则对其父目录逐级解析，尽可能获取真实路径。
 */
async function realPath(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch {
    // 路径可能还不存在（新建文件），尝试解析父目录
    const parent = resolve(target, "..");
    try {
      const realParent = await realpath(parent);
      return resolve(realParent, relative(parent, target));
    } catch {
      // 父目录也不存在，返回原路径
      return resolve(target);
    }
  }
}

/**
 * 检查目标路径是否在允许的根目录范围内。
 *
 * @param allowedRoots 允许的根目录列表（绝对路径）
 * @param target       要检查的目标路径（绝对路径）
 * @returns            如果目标在范围内返回 true，否则返回 false 及错误信息
 */
export async function confine(
  allowedRoots: string[],
  target: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (allowedRoots.length === 0) {
    return { ok: true }; // 没有限制，默认允许
  }

  const realTarget = await realPath(target);

  for (const root of allowedRoots) {
    const realRoot = await realPath(root);
    // 检查 target 是否在 root 之下
    const rel = relative(realRoot, realTarget);
    if (!rel.startsWith("..") && rel !== "" && !rel.startsWith("/") && !rel.startsWith("\\")) {
      return { ok: true };
    }
    // 允许 target 恰好等于 root
    if (realTarget === realRoot) {
      return { ok: true };
    }
  }

  return {
    ok: false,
    error: `路径 "${target}" 不在允许的写入范围内 ${allowedRoots.join(", ")}`,
  };
}

// ---------------------------------------------------------------------------
// 输出截断
// ---------------------------------------------------------------------------

/**
 * 截断过长的输出内容。
 */
export function truncateOutput(content: string, maxLength = DEFAULT_MAX_OUTPUT_LENGTH): string {
  if (content.length <= maxLength) return content;
  const truncated = content.slice(0, maxLength);
  return `${truncated}\n\n... [输出过长，已截断，共 ${String(content.length)} 字符]`;
}

/**
 * 获取默认超时时间。
 */
export function getDefaultTimeout(): number {
  return DEFAULT_TIMEOUT_MS;
}

/**
 * 获取默认最大文件大小。
 */
export function getDefaultMaxFileSize(): number {
  return DEFAULT_MAX_FILE_SIZE;
}

// ---------------------------------------------------------------------------
// 超时控制
// ---------------------------------------------------------------------------

/**
 * 创建一个带超时的 AbortController。
 */
export function createTimeoutSignal(signal?: AbortSignal, timeoutMs = DEFAULT_TIMEOUT_MS): AbortController {
  const controller = new AbortController();

  // 外部信号触发时，联动中止
  if (signal) {
    signal.addEventListener("abort", () => {
      controller.abort();
    }, { once: true });
  }

  // 超时自动中止
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  controller.signal.addEventListener("abort", () => {
    clearTimeout(timer);
  }, { once: true });

  return controller;
}

// ---------------------------------------------------------------------------
// Shell 命令执行
// ---------------------------------------------------------------------------

/**
 * 执行 shell 命令的通用封装。
 */
export async function execCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal?: AbortSignal,
  /** 如果为 true，表示 command 已经是 shell 程序（如 cmd/sh），不需要再包装 */
  isShellCommand?: boolean,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((_resolve) => {
      let spawnCmd: string;
    let spawnArgs: string[];
    let useShell: boolean;

    if (isShellCommand) {
      spawnCmd = command;
      spawnArgs = args;
      useShell = false;

      // cmd.exe 默认用 GBK 输出中文错误，会在 UTF-8 终端里变成乱码。
      // 所以在 cmd 这条路径下，把命令带上 `chcp 65001 >nul &&` 前缀
      // 切到 UTF-8 代码页，stderr 才能被 LLM 读懂。
      // 启动期探测出的 SHELL_INFO 已不允许这种耗时切换，能在 git bash 赏i
      // 就不进 cmd 这条分支；这里作为“找不到 Git Bash 时的兒底”出现。
      //
      // 注意：chcp 切换只对 cmd.exe /c 调用里可见，不会污染外层进程。
      if (isWindows && spawnCmd === "cmd" && spawnArgs[0] === "/c") {
        const prefixed = `chcp 65001 >nul && ${spawnArgs[1] ?? ""}`;
        spawnArgs = ["/c", prefixed];
      }
    } else {
      useShell = !isWindows;
      spawnCmd = isWindows ? "cmd" : command;
      spawnArgs = isWindows
        ? ["/c", command, ...args]
        : args;
    }

    const child = spawn(spawnCmd, spawnArgs, {
      cwd,
      shell: useShell,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString("utf8");
    });

    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString("utf8");
    });

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      // 给 5 秒优雅退出时间
      setTimeout(() => {
        child.kill("SIGKILL");
      }, 5000);
    }, timeoutMs);

    // 外部中止信号
    if (signal) {
      if (signal.aborted) {
        child.kill("SIGTERM");
      }
      signal.addEventListener("abort", () => {
        child.kill("SIGTERM");
      }, { once: true });
    }

    child.on("close", (code) => {
      clearTimeout(timeout);
      _resolve({ stdout, stderr, exitCode: code });
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      stderr += `\n进程启动失败：${err.message}`;
      _resolve({ stdout, stderr, exitCode: null });
    });
  });
}
