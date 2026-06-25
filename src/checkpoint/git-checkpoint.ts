import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Checkpoint } from "./types.js";

const execFileAsync = promisify(execFile);
const EXEC_OPTIONS = { windowsHide: true } as const;

export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], { cwd, ...EXEC_OPTIONS });
    return true;
  } catch { return false; }
}

async function hasCommits(cwd: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["rev-parse", "--verify", "HEAD"], { cwd, ...EXEC_OPTIONS });
    return true;
  } catch { return false; }
}

async function hasWorkingChanges(cwd: string): Promise<boolean> {
  const out = await execFileAsync("git", ["status", "--porcelain"], { cwd, ...EXEC_OPTIONS });
  return out.stdout.trim().length > 0;
}

async function git(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, ...EXEC_OPTIONS });
    return stdout;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`git ${args.join(" ")} 失败: ${msg}`);
  }
}

async function listStashShas(cwd: string): Promise<string[]> {
  const out = await git(["stash", "list", "--format=%H"], cwd);
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

export async function createCheckpoint(cwd: string): Promise<Checkpoint> {
  const timestamp = Date.now();
  const inRepo = await isGitRepo(cwd);
  if (!inRepo) return { stashSha: "", timestamp, cwd, isGitRepo: false };
  if (!(await hasCommits(cwd))) return { stashSha: "", timestamp, cwd, isGitRepo: true };
  if (!(await hasWorkingChanges(cwd))) return { stashSha: "", timestamp, cwd, isGitRepo: true };

  const beforeShas = await listStashShas(cwd);
  await git(["stash", "push", "-m", `dskcode-cp-${timestamp}`, "-u"], cwd);

  const newShas = await listStashShas(cwd);
  if (newShas.length === 0) throw new Error("git stash push 未能创建 stash entry");
  const newSha = newShas.find((s) => !beforeShas.includes(s)) ?? newShas[0]!;
  return { stashSha: newSha, timestamp, cwd, isGitRepo: true };
}

export async function restoreCheckpointForce(checkpoint: Checkpoint): Promise<void> {
  if (!checkpoint.isGitRepo) throw new Error("非 git 仓库，无法恢复文件状态");
  if (!checkpoint.stashSha) throw new Error("检查点为空（工作区原本就干净），无需恢复");

  const { cwd, stashSha } = checkpoint;
  const currentShas = await listStashShas(cwd);
  if (!currentShas.includes(stashSha)) {
    throw new Error("检查点已失效（stash entry 已被消费或 GC），无法恢复");
  }
  await git(["checkout", "--", "."], cwd);
  await git(["clean", "-fd"], cwd);
  await git(["stash", "apply", stashSha], cwd);
  const refIndex = currentShas.indexOf(stashSha);
  if (refIndex >= 0) await git(["stash", "drop", `stash@{${refIndex}}`], cwd);
}

export async function discardCheckpoint(checkpoint: Checkpoint): Promise<void> {
  if (!checkpoint.isGitRepo || !checkpoint.stashSha) return;
  const { cwd, stashSha } = checkpoint;
  const shas = await listStashShas(cwd);
  const idx = shas.indexOf(stashSha);
  if (idx < 0) return;
  try { await git(["stash", "drop", `stash@{${idx}}`], cwd); } catch { /* ignore */ }
}
