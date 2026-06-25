import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/session-store/index.js";
import type { StoredSession } from "../src/session-store/index.js";

describe("SessionStore", () => {
  let tempDir: string;
  let store: SessionStore;
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "dskcode-sessions-"));
    store = new SessionStore(tempDir);
  });
  afterEach(async () => { try { await rm(tempDir, { recursive: true, force: true }); } catch { /* ignore */ } });

  function makeSession(overrides: Partial<StoredSession> = {}): StoredSession {
    const id = overrides.id ?? SessionStore.newId();
    return {
      id, title: "测试", createdAt: 1700000000000, updatedAt: 1700000001000,
      cwd: "/tmp", model: "deepseek-v4-flash",
      messages: [{ role: "user", content: "你好" }, { role: "assistant", content: "你好！" }],
      totalCost: 0.001, ...overrides,
    };
  }

  it("save 后 load 还原完整数据", async () => {
    const s = makeSession();
    await store.save(s);
    expect(await store.load(s.id)).toEqual(s);
  });
  it("load 不存在的会话返回 null", async () => {
    expect(await store.load("nope")).toBeNull();
  });
  it("覆盖已存在的会话", async () => {
    await store.save(makeSession({ id: "abc" }));
    const u = { ...makeSession({ id: "abc" }), title: "新", updatedAt: 2000000000000 };
    await store.save(u);
    const l = await store.load("abc");
    expect(l?.title).toBe("新");
  });
  it("空目录 list 返回空数组", async () => { expect(await store.list()).toEqual([]); });
  it("list 按 updatedAt 降序", async () => {
    await store.save(makeSession({ id: "a", updatedAt: 1000 }));
    await store.save(makeSession({ id: "b", updatedAt: 3000 }));
    await store.save(makeSession({ id: "c", updatedAt: 2000 }));
    const list = await store.list();
    expect(list.map((s) => s.id)).toEqual(["b", "c", "a"]);
  });
  it("list 忽略损坏 JSON", async () => {
    await store.save(makeSession({ id: "good" }));
    await writeFile(join(tempDir, "bad.json"), "{ bad", "utf-8");
    expect(await store.list()).toHaveLength(1);
  });
  it("delete 移除存在的会话", async () => {
    await store.save(makeSession({ id: "x" }));
    await store.delete("x");
    expect(await store.exists("x")).toBe(false);
  });
  it("delete 不存在的会话不报错", async () => {
    await expect(store.delete("nope")).resolves.not.toThrow();
  });
  it("newId 生成 UUID 格式", () => {
    expect(SessionStore.newId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });
  it("Checkpoint 字段能正确往返", async () => {
    const s = makeSession({
      id: "with-cp",
      messages: [{ role: "user", content: "m", checkpoint: { stashSha: "abc", timestamp: 1, cwd: "/", isGitRepo: true } }],
    });
    await store.save(s);
    const l = await store.load("with-cp");
    expect((l?.messages[0] as { checkpoint?: { stashSha: string } })?.checkpoint?.stashSha).toBe("abc");
  });
});
