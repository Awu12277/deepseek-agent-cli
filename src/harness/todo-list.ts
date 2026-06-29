// ---------------------------------------------------------------------------
// TodoList — Harness 规划层的最小骨架
//
// 设计原则：
// - 纯数据 + 纯方法（除状态转换外不调任何 IO）
// - 状态机：pending → running → done | failed | skipped
// - 依赖关系：todo 声明 deps（其它 todo 的 id），deps 全 done 才进入 pending
// - 输出：toMarkdown() 拼到 system prompt，让模型每轮看到自己进度
//
// 函数注释规范见仓库根 AGENTS.md「函数注释规范」一节。
// ---------------------------------------------------------------------------

/** Todo 状态 */
export type TodoStatus = "pending" | "running" | "done" | "failed" | "skipped";

/** Todo 项 */
export interface TodoItem {
  /** 唯一 id（生成时分配 0/1/2...） */
  id: number;
  /** 给 LLM 看的人类可读步骤描述（中文） */
  content: string;
  /** 当前状态 */
  status: TodoStatus;
  /** 依赖的其它 todo id 列表（这些都 done 后本项才可 running） */
  deps: number[];
  /** 完成时的证据（如 "type-check 通过"、"read_file 拿到 8633 字符"）；失败时为错误信息 */
  evidence?: string;
  /** 状态最近一次变更的时间戳（毫秒） */
  updatedAt: number;
}

/**
 * TodoList — 任务列表状态机。
 *
 * 用法（典型流程）：
 *   const todo = new TodoList();
 *   const a = todo.add("读 edit-file.ts");
 *   const b = todo.add("修改错误信息", [a]);
 *   const c = todo.add("跑 type-check", [b]);
 *   todo.markRunning(a); todo.markDone(a, "读取成功");
 *   // ... 依次推进
 *
 * 状态转换：
 *   pending → running   (markRunning，前提是 deps 全 done)
 *   running → done      (markDone，附 evidence)
 *   running → failed    (markFailed，附 reason)
 *   pending → skipped   (markSkipped，附 reason)
 */
export class TodoList {
  #items: TodoItem[] = [];
  #nextId = 0;

  /**
   * 新增一个 todo，返回分配的 id。
   *
   * @param content — 步骤描述（中文）
   * @param deps — 依赖的 todo id 列表；为空表示无依赖，立即可 running
   * @returns 新 todo 的 id
   * @throws 当 deps 引用了不存在的 id 时抛出，避免 LLM 错把不存在的依赖塞进计划
   */
  add(content: string, deps: number[] = []): number {
    // 校验 deps：所有 id 必须已存在（避免引用未来 / 不存在的 id）
    for (const d of deps) {
      if (!this.#items.find((it) => it.id === d)) {
        throw new Error(`todo 依赖 #${d} 不存在（已分配的 id: ${this.#items.map((it) => it.id).join(", ") || "(空)"}）`);
      }
    }
    const id = this.#nextId++;
    this.#items.push({
      id,
      content,
      status: "pending",
      deps: [...deps],
      updatedAt: Date.now(),
    });
    return id;
  }

  /**
   * 把失败的 todo 重置回 pending（用于"重试"工作流）。
   *
   * 不允许把 done / skipped 重置（一旦完成不应反悔）。
   * 不允许把 running 重置（应该先 markFailed 再重试）。
   *
   * @param id — todo id
   * @returns 是否成功
   */
  resetForRetry(id: number): boolean {
    const item = this.#find(id);
    if (!item) return false;
    if (item.status !== "failed") return false;
    item.status = "pending";
    item.evidence = undefined;
    item.updatedAt = Date.now();
    return true;
  }

  /**
   * 把 todo 标记为 running。
   *
   * 前提：该 todo 存在 + 当前是 pending + 依赖全 done。
   * 不满足时静默返回 false（不抛错，避免污染 agent 主循环）。
   *
   * @param id — todo id
   * @returns 是否成功转换
   */
  markRunning(id: number): boolean {
    const item = this.#find(id);
    if (!item) return false;
    if (item.status !== "pending") return false;
    if (!this.#depsAllDone(item.deps)) return false;
    item.status = "running";
    item.updatedAt = Date.now();
    return true;
  }

  /**
   * 标记完成。
   *
   * @param id — todo id
   * @param evidence — 完成证据（如 "读取成功"、"type-check 通过"）
   * @returns 是否成功
   */
  markDone(id: number, evidence?: string): boolean {
    const item = this.#find(id);
    if (!item) return false;
    if (item.status !== "running" && item.status !== "pending") return false;
    item.status = "done";
    if (evidence !== undefined) item.evidence = evidence;
    item.updatedAt = Date.now();
    return true;
  }

  /**
   * 标记失败。
   *
   * @param id — todo id
   * @param reason — 失败原因（人类可读）
   * @returns 是否成功
   */
  markFailed(id: number, reason: string): boolean {
    const item = this.#find(id);
    if (!item) return false;
    if (item.status === "done") return false;
    item.status = "failed";
    item.evidence = reason;
    item.updatedAt = Date.now();
    return true;
  }

  /**
   * 标记跳过。
   *
   * @param id — todo id
   * @param reason — 跳过原因（如 "项目无测试基建"）
   * @returns 是否成功
   */
  markSkipped(id: number, reason: string): boolean {
    const item = this.#find(id);
    if (!item) return false;
    if (item.status === "done" || item.status === "failed") return false;
    item.status = "skipped";
    item.evidence = reason;
    item.updatedAt = Date.now();
    return true;
  }

  /**
   * 取出所有"立即可做"的 todo（deps 全 done 且 pending）。
   *
   * @returns 可执行的 todo 列表
   */
  pending(): TodoItem[] {
    return this.#items.filter(
      (it) => it.status === "pending" && this.#depsAllDone(it.deps),
    );
  }

  /**
   * 取出所有未完成项（pending / running / failed）。
   */
  unfinished(): TodoItem[] {
    return this.#items.filter(
      (it) => it.status === "pending" || it.status === "running" || it.status === "failed",
    );
  }

  /**
   * 是否全部结束（done / failed / skipped）。
   */
  isAllTerminated(): boolean {
    return this.#items.every(
      (it) => it.status === "done" || it.status === "failed" || it.status === "skipped",
    );
  }

  /** 全部条目（只读快照） */
  get items(): ReadonlyArray<TodoItem> {
    return this.#items;
  }

  /**
   * 把 todo 列表拼成 markdown，用于注入 system prompt。
   *
   * @param maxItems — 最多展示多少条；超出时保留"最近 N 条 + 进行中"，折叠已完成
   * @returns markdown 字符串
   */
  toMarkdown(maxItems = 20): string {
    if (this.#items.length === 0) return "";

    // 截断策略：保留所有 running/pending/failed（活跃项），剩下的按时间倒序补到 maxItems
    const active = this.#items.filter(
      (it) => it.status === "pending" || it.status === "running" || it.status === "failed",
    );
    const finished = this.#items.filter(
      (it) => it.status === "done" || it.status === "skipped",
    );
    const finishedSorted = [...finished].sort((a, b) => b.updatedAt - a.updatedAt);

    const truncated = finishedSorted.length > maxItems;
    const finishedToShow = truncated
      ? finishedSorted.slice(0, Math.max(0, maxItems - active.length))
      : finishedSorted;

    const lines = [...active, ...finishedToShow].map((it) => {
      const box = this.#statusBox(it.status);
      const depStr = it.deps.length > 0 ? ` (依赖: #${it.deps.join(", #")})` : "";
      const eviStr = it.evidence ? ` — ${it.evidence}` : "";
      return `- ${box} #${it.id} ${it.content}${depStr}${eviStr}`;
    });
    if (truncated) {
      const hidden = finishedSorted.length - finishedToShow.length;
      lines.push(`- ...（另有 ${hidden} 条已完成已折叠）`);
    }

    return [
      "## 📋 当前任务进度",
      ...lines,
      "",
      "规则：按顺序推进；未完成依赖时不要跳步；完成请调用 todo_mark_done，失败请调用 todo_mark_failed；重试失败项先调 todo_retry 再重跑。",
    ].join("\n");
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  #find(id: number): TodoItem | undefined {
    return this.#items.find((it) => it.id === id);
  }

  #depsAllDone(deps: readonly number[]): boolean {
    return deps.every((d) => {
      const item = this.#items.find((it) => it.id === d);
      return item?.status === "done" || item?.status === "skipped";
    });
  }

  #statusBox(status: TodoStatus): string {
    switch (status) {
      case "pending": return "☐";
      case "running": return "▶";
      case "done":    return "✅";
      case "failed":  return "❌";
      case "skipped": return "⏭";
    }
  }
}
