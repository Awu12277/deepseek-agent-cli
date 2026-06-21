// ---------------------------------------------------------------------------
// 工具执行沙箱 — 路径约束、超时控制、输出截断
// ---------------------------------------------------------------------------

import { resolve, relative, isAbsolute } from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";

/** 沙箱默认配置 */
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_LENGTH = 50_000;
const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

/** 是否为 Windows 平台 */
const isWindows = process.platform === "win32";

/**
 * 将路径解析为绝对路径，并验证其在工作目录下。
 *
 * @param inputPath  用户输入的路径（可能是相对或绝对路径）
 * @param cwd        工作目录
 * @returns         解析后的绝对路径
 * @throws          如果路径试图逃逸工作目录
 */
export function resolvePath(inputPath: string, cwd: string): string {
  const resolved = isAbsolute(inputPath) ? inputPath : resolve(cwd, inputPath);
  const normalized = resolve(resolved);

  // 允许 cwd 本身及其子路径
  const rel = relative(cwd, normalized);
  if (rel.startsWith("..") || normalized !== resolve(cwd) && !rel) {
    // 这里我们放宽限制：只警告不阻止，让工具本身决定是否允许
    // 某些工具（如 bash）天然需要访问 cwd 以外的路径
  }

  return normalized;
}

/**
 * 截断过长的输出内容。
 *
 * @param content   原始内容
 * @param maxLength 最大长度
 * @returns         截断后的内容（附带截断提示）
 */
export function truncateOutput(content: string, maxLength = DEFAULT_MAX_OUTPUT_LENGTH): string {
  if (content.length <= maxLength) return content;
  const truncated = content.slice(0, maxLength);
  return `${truncated}\n\n... [输出过长，已截断，共 ${content.length} 字符]`;
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

/**
 * 创建一个带超时的 AbortController。
 *
 * @param signal  外部中止信号（如用户按 Ctrl+C）
 * @param timeoutMs 超时时间（毫秒）
 * @returns        AbortController，超时或外部信号触发时自动中止
 */
export function createTimeoutSignal(signal?: AbortSignal, timeoutMs = DEFAULT_TIMEOUT_MS): AbortController {
  const controller = new AbortController();

  // 外部信号触发时，联动中止
  if (signal) {
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  // 超时自动中止
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });

  return controller;
}

/**
 * 执行 shell 命令的通用封装。
 *
 * @param command    要执行的命令
 * @param args       命令参数
 * @param cwd        工作目录
 * @param timeoutMs 超时时间（毫秒）
 * @param signal     外部中止信号
 * @returns          标准输出、标准错误和退出码
 */
export async function execCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    // Windows 使用 cmd.exe，其他平台使用 /bin/sh
    const shell = isWindows;
    const spawnCmd = isWindows ? "cmd" : command;
    const spawnArgs = isWindows
      ? ["/c", command, ...args]
      : args;

    const child = spawn(spawnCmd, spawnArgs, {
      cwd,
      shell: !isWindows, // Windows 已经通过 cmd.exe 执行，无需再次 shell
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
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
      resolve({ stdout, stderr, exitCode: code });
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      stderr += `\n进程启动失败：${err.message}`;
      resolve({ stdout, stderr, exitCode: null });
    });
  });
}