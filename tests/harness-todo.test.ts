// ---------------------------------------------------------------------------
// TodoList 单元测试
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { TodoList } from "../src/harness/todo-list.js";

describe("TodoList 基础操作", () => {
  it("add 返回递增的 id", () => {
    const t = new TodoList();
    expect(t.add("A")).toBe(0);
    expect(t.add("B")).toBe(1);
    expect(t.add("C")).toBe(2);
  });

  it("初始状态全是 pending", () => {
    const t = new TodoList();
    t.add("A");
    t.add("B");
    expect(t.items.every((todo) => todo.status === "pending")).toBe(true);
  });

  it("markRunning 成功转换", () => {
    const t = new TodoList();
    const id = t.add("A");
    expect(t.markRunning(id)).toBe(true);
    expect(t.items[0].status).toBe("running");
  });

  it("markRunning 在依赖未满足时静默失败", () => {
    const t = new TodoList();
    const a = t.add("A");
    const b = t.add("B", [a]);
    expect(t.markRunning(b)).toBe(false);
    expect(t.items[1].status).toBe("pending");
  });

  it("markRunning 依赖完成 + skip 也算满足", () => {
    const t = new TodoList();
    const a = t.add("A");
    const b = t.add("B", [a]);
    t.markSkipped(a, "n/a");
    expect(t.markRunning(b)).toBe(true);
    expect(t.items.find((x) => x.id === b)?.status).toBe("running");
  });

  it("markDone 附 evidence", () => {
    const t = new TodoList();
    const id = t.add("A");
    t.markRunning(id);
    t.markDone(id, "ok");
    expect(t.items[0].evidence).toBe("ok");
  });

  it("markFailed 附 reason", () => {
    const t = new TodoList();
    const id = t.add("A");
    t.markRunning(id);
    t.markFailed(id, "崩了");
    expect(t.items[0]?.status).toBe("failed");
    expect(t.items[0]?.evidence).toBe("崩了");
  });

  it("markDone 已 done 的不能再 markDone", () => {
    const t = new TodoList();
    const id = t.add("A");
    t.markRunning(id);
    t.markDone(id, "ok");
    expect(t.markDone(id, "twice")).toBe(false);
  });

  it("不存在 id 返回 false", () => {
    const t = new TodoList();
    expect(t.markRunning(99)).toBe(false);
    expect(t.markDone(99, "x")).toBe(false);
    expect(t.markFailed(99, "x")).toBe(false);
    expect(t.markSkipped(99, "x")).toBe(false);
  });
});

describe("pending() 找出可执行项", () => {
  it("无依赖的 pending 都可执行", () => {
    const t = new TodoList();
    t.add("A");
    t.add("B");
    t.add("C");
    expect(t.pending()).toHaveLength(3);
  });

  it("依赖未完成的不在 pending", () => {
    const t = new TodoList();
    const a = t.add("A");
    t.add("B", [a]);
    const ps = t.pending();
    expect(ps).toHaveLength(1);
    expect(ps[0]?.id).toBe(a);
  });

  it("依赖完成后 B 进入 pending", () => {
    const t = new TodoList();
    const a = t.add("A");
    const b = t.add("B", [a]);
    t.markRunning(a);
    t.markDone(a, "ok");
    expect(t.pending()).toHaveLength(1);
    expect(t.pending()[0]?.id).toBe(b);
  });

  it("多依赖：全部 done 才 pending", () => {
    const t = new TodoList();
    const a = t.add("A");
    const b = t.add("B");
    const c = t.add("C", [a, b]);
    t.markRunning(a); t.markDone(a, "ok");
    // B 还没完成，C 仍不在 pending
    expect(t.pending().map((todo) => todo.id)).not.toContain(c);
    t.markRunning(b); t.markDone(b, "ok");
    expect(t.pending().map((todo) => todo.id)).toContain(c);
  });
});

describe("isAllTerminated", () => {
  it("空列表：true", () => {
    expect(new TodoList().isAllTerminated()).toBe(true);
  });

  it("全 done：true", () => {
    const t = new TodoList();
    const a = t.add("A");
    t.markRunning(a); t.markDone(a, "ok");
    expect(t.isAllTerminated()).toBe(true);
  });

  it("有 pending：false", () => {
    const t = new TodoList();
    t.add("A");
    expect(t.isAllTerminated()).toBe(false);
  });

  it("有 running：false", () => {
    const t = new TodoList();
    const a = t.add("A");
    t.markRunning(a);
    expect(t.isAllTerminated()).toBe(false);
  });

  it("混合 done + failed：true", () => {
    const t = new TodoList();
    const a = t.add("A");
    const b = t.add("B");
    t.markRunning(a); t.markDone(a, "ok");
    t.markRunning(b); t.markFailed(b, "x");
    expect(t.isAllTerminated()).toBe(true);
  });
});

describe("unfinished", () => {
  it("done 不算 unfinished", () => {
    const t = new TodoList();
    const a = t.add("A");
    t.markRunning(a); t.markDone(a, "ok");
    expect(t.unfinished()).toHaveLength(0);
  });

  it("failed 算 unfinished（方便重试）", () => {
    const t = new TodoList();
    const a = t.add("A");
    t.markRunning(a); t.markFailed(a, "x");
    expect(t.unfinished()).toHaveLength(1);
  });
});

describe("toMarkdown", () => {
  it("空列表返回空串", () => {
    expect(new TodoList().toMarkdown()).toBe("");
  });

  it("包含所有 todo 和状态图标", () => {
    const t = new TodoList();
    const a = t.add("读文件");
    t.add("改文件", [a]); // 声明依赖 a，让 markdown 体现 (依赖: #0)
    t.markRunning(a);
    t.markDone(a, "成功");
    const md = t.toMarkdown();
    expect(md).toContain("读文件");
    expect(md).toContain("改文件");
    expect(md).toContain("✅");
    expect(md).toContain("☐");
    expect(md).toContain("(依赖: #0)");
  });
});

describe("add 依赖校验", () => {
  it("deps 引用不存在的 id 抛错", () => {
    const t = new TodoList();
    expect(() => t.add("A")).not.toThrow();
    expect(() => t.add("B", [0])).not.toThrow();
    // 引用未来 / 不存在的 id
    expect(() => t.add("C", [99])).toThrow(/依赖 #99 不存在/);
  });

  it("deps 为空数组允许", () => {
    const t = new TodoList();
    expect(() => t.add("A", [])).not.toThrow();
  });
});

describe("resetForRetry 重试", () => {
  it("failed → pending，清空 evidence", () => {
    const t = new TodoList();
    const id = t.add("A");
    t.markRunning(id);
    t.markFailed(id, "原错误");
    expect(t.resetForRetry(id)).toBe(true);
    const item = t.items.find((x) => x.id === id)!;
    expect(item.status).toBe("pending");
    expect(item.evidence).toBeUndefined();
  });

  it("running / done / skipped 不允许重试", () => {
    const t = new TodoList();
    const a = t.add("A");
    t.markRunning(a);
    expect(t.resetForRetry(a)).toBe(false);
    t.markDone(a, "ok");
    expect(t.resetForRetry(a)).toBe(false);
    const b = t.add("B");
    t.markSkipped(b, "n/a");
    expect(t.resetForRetry(b)).toBe(false);
  });

  it("不存在的 id 返回 false", () => {
    expect(new TodoList().resetForRetry(99)).toBe(false);
  });
});

describe("toMarkdown 截断", () => {
  it("活跃项（pending/running/failed）始终保留", () => {
    const t = new TodoList();
    // 20 个 done
    for (let i = 0; i < 20; i++) {
      const id = t.add(`done-${i}`);
      t.markRunning(id);
      t.markDone(id, "ok");
    }
    // 1 个 pending
    t.add("active-pending");
    const md = t.toMarkdown(5);
    expect(md).toContain("active-pending");
  });

  it("已完成项超出 maxItems 时折叠", () => {
    const t = new TodoList();
    for (let i = 0; i < 10; i++) {
      const id = t.add(`done-${i}`);
      t.markRunning(id);
      t.markDone(id, "ok");
    }
    const md = t.toMarkdown(3);
    expect(md).toMatch(/另有 \d+ 条已完成已折叠/);
  });
});
