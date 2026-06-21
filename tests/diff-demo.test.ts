// ---------------------------------------------------------------------------
// Diff 终端输出演示脚本 — 用 vitest 运行查看实际 diff 输出
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { computeFileDiff } from "../src/tool/diff.js";

describe("Diff 终端输出演示", () => {
  it("场景 1：新建文件", () => {
    const diff = computeFileDiff(
      "",
      "import { hello } from './hello';\n\nhello();\n",
      "/src/new-module.ts",
    );

    console.log("\n╔══════════════════════════════════════════╗");
    console.log("║  场景 1：新建文件                         ║");
    console.log("╚══════════════════════════════════════════╝");
    console.log(`existedBefore: ${diff.existedBefore}`);
    console.log(`+${diff.additions} -${diff.deletions}`);
    console.log(`\n${diff.patch}`);

    expect(diff.existedBefore).toBe(false);
    expect(diff.additions).toBe(3);
    expect(diff.deletions).toBe(0);
    expect(diff.patch).toContain("--- /dev/null");
    expect(diff.patch).toContain("+++ b/new-module.ts");
  });

  it("场景 2：edit_file 替换一行", () => {
    const oldContent = "function hello() {\n  console.log('hello');\n}\n";
    const newContent = "function hello() {\n  console.log('world');\n}\n";
    const diff = computeFileDiff(oldContent, newContent, "/src/index.ts");

    console.log("\n╔══════════════════════════════════════════╗");
    console.log("║  场景 2：edit_file 替换一行               ║");
    console.log("╚══════════════════════════════════════════╝");
    console.log(`existedBefore: ${diff.existedBefore}`);
    console.log(`+${diff.additions} -${diff.deletions}`);
    console.log(`\n${diff.patch}`);

    // 模拟 write_file 的 data 返回
    const action = diff.existedBefore ? "已修改" : "已创建";
    const diffSummary = diff.existedBefore
      ? `，+${diff.additions} -${diff.deletions}`
      : `，+${diff.additions} 行（新建）`;
    console.log(`\n→ write_file data: 文件${action}：/src/index.ts（3 行，47 字节${diffSummary}）`);

    expect(diff.additions).toBe(1);
    expect(diff.deletions).toBe(1);
  });

  it("场景 3：write_file 覆盖已有文件", () => {
    const oldContent = "line1\nline2\nline3\nline4\nline5\n";
    const newContent = "line1\nMODIFIED\nline3\nline4\nline5\n";
    const diff = computeFileDiff(oldContent, newContent, "/src/existing.ts");

    console.log("\n╔══════════════════════════════════════════╗");
    console.log("║  场景 3：write_file 覆盖已有文件           ║");
    console.log("╚══════════════════════════════════════════╝");
    console.log(`existedBefore: ${diff.existedBefore}`);
    console.log(`+${diff.additions} -${diff.deletions}`);
    console.log(`\n${diff.patch}`);

    expect(diff.existedBefore).toBe(true);
    expect(diff.additions).toBe(1);
    expect(diff.deletions).toBe(1);
    expect(diff.patch).toContain("-line2");
    expect(diff.patch).toContain("+MODIFIED");
    // 上下文行应该出现
    expect(diff.patch).toContain(" line1");
    expect(diff.patch).toContain(" line3");
  });

  it("场景 4：多处分散修改（React 组件）", () => {
    const oldCode = [
      "import React from 'react';",
      "",
      "function App() {",
      "  const [count, setCount] = useState(0);",
      "  return (",
      "    <div>",
      "      <h1>Hello</h1>",
      "      <button onClick={() => setCount(count + 1)}>",
      "        Click me",
      "      </button>",
      "      <p>Count: {count}</p>",
      "    </div>",
      "  );",
      "}",
      "",
      "export default App;",
    ].join("\n");

    const newCode = [
      "import React, { useState } from 'react';",
      "",
      "function App() {",
      "  const [count, setCount] = useState(0);",
      "  return (",
      "    <div>",
      "      <h1>Hello World</h1>",
      "      <button onClick={() => setCount(count + 1)}>",
      "        Click me",
      "      </button>",
      "      <p>You clicked {count} times</p>",
      "    </div>",
      "  );",
      "}",
      "",
      "export default App;",
    ].join("\n");

    const diff = computeFileDiff(oldCode, newCode, "/src/App.tsx");

    console.log("\n╔══════════════════════════════════════════╗");
    console.log("║  场景 4：多处分散修改（React 组件）       ║");
    console.log("╚══════════════════════════════════════════╝");
    console.log(`existedBefore: ${diff.existedBefore}`);
    console.log(`+${diff.additions} -${diff.deletions}`);
    console.log(`\n${diff.patch}`);

    expect(diff.additions).toBe(3);
    expect(diff.deletions).toBe(3);
    expect(diff.patch).toContain("-import React from 'react';");
    expect(diff.patch).toContain("+import React, { useState } from 'react';");
    expect(diff.patch).toContain("-      <h1>Hello</h1>");
    expect(diff.patch).toContain("+      <h1>Hello World</h1>");
  });

  it("场景 5：无变更", () => {
    const diff = computeFileDiff("abc\ndef\n", "abc\ndef\n", "/test/same.ts");

    console.log("\n╔══════════════════════════════════════════╗");
    console.log("║  场景 5：无变更                           ║");
    console.log("╚══════════════════════════════════════════╝");
    console.log(`existedBefore: ${diff.existedBefore}`);
    console.log(`+${diff.additions} -${diff.deletions}`);
    console.log(`patch: "${diff.patch}"`);

    expect(diff.patch).toBe("");
    expect(diff.additions).toBe(0);
    expect(diff.deletions).toBe(0);
  });

  it("场景 6：Agent 消息完整输出格式", () => {
    // 模拟 Agent 追加到消息历史的 tool content
    const oldContent = "const greeting = 'hello';\nconsole.log(greeting);\n";
    const newContent = "const greeting = 'world';\nconsole.log(greeting);\n";
    const diff = computeFileDiff(oldContent, newContent, "/src/app.ts");
    const data = `文件已编辑：/src/app.ts\n替换位置：第 1 行\n1 行 → 1 行\n变更：+1 -1`;

    // 这是 Agent 追加到消息历史的内容
    let toolContent = data;
    if (diff.patch) {
      toolContent += `\n\n${diff.patch}`;
    }

    console.log("\n╔══════════════════════════════════════════╗");
    console.log("║  场景 6：Agent 消息完整输出格式             ║");
    console.log("╚══════════════════════════════════════════╝");
    console.log("——— tool_content（模型可见）———");
    console.log(toolContent);
    console.log("—————————————————————————————");

    // 同时展示事件流的结构化数据
    console.log("\n——— tool_result 事件（UI 渲染用）———");
    console.log(JSON.stringify({
      type: "tool_result",
      name: "edit_file",
      result: {
        success: true,
        data,
        diff: {
          filePath: diff.filePath,
          additions: diff.additions,
          deletions: diff.deletions,
          existedBefore: diff.existedBefore,
          patch: diff.patch,
        },
      },
    }, null, 2));

    expect(toolContent).toContain(diff.patch);
    expect(toolContent).toContain("+1 -1");
  });
});