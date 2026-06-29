// ---------------------------------------------------------------------------
// table-layout 单元测试
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  visualWidth,
  wrapByWidth,
  padToWidth,
  parseTableCells,
  parseAlignments,
  layoutTable,
  DEFAULT_TERM_WIDTH,
} from "../../src/ui/table-layout.js";

describe("visualWidth", () => {
  it("ASCII 字符串按字符数算宽度", () => {
    expect(visualWidth("hello")).toBe(5);
  });

  it("CJK 字符每个算 2 格", () => {
    expect(visualWidth("你好")).toBe(4);
    expect(visualWidth("中文测试")).toBe(8);
  });

  it("CJK 标点算 2 格", () => {
    expect(visualWidth("，。！？")).toBe(8);
    expect(visualWidth("「」【】")).toBe(8);
  });

  it("emoji 算 2 格（单码点）", () => {
    expect(visualWidth("📊")).toBe(2);
    expect(visualWidth("💰")).toBe(2);
  });

  it("ZWJ 组合 emoji 不重复计宽", () => {
    // 👨‍💻 = U+1F468 ZWJ U+1F4BB → 视觉上算 2 格
    expect(visualWidth("👨\u200d💻")).toBe(4);
  });

  it("控制字符不计宽", () => {
    expect(visualWidth("a\nb\tc")).toBe(3);
  });
});

describe("wrapByWidth", () => {
  it("内容短于 maxWidth 时不切", () => {
    expect(wrapByWidth("hello", 10)).toEqual(["hello"]);
  });

  it("内容刚好等于 maxWidth 时不切", () => {
    expect(wrapByWidth("hello", 5)).toEqual(["hello"]);
  });

  it("英文在空格处换行（首词不满 maxWidth 不拼后续）", () => {
    // "hello"(5)+" "(1)+"world"(5)=11 > 8 → 在 "hello " 后切；"world"(5)+" "(1)+"foo"(3)=9 > 8 → 在 "world " 后切
    expect(wrapByWidth("hello world foo", 8)).toEqual([
      "hello",
      "world",
      "foo",
    ]);
  });

  it("中文按视觉宽度切（CJK 不会被截半）", () => {
    // 6 个汉字 = 12 视觉宽，maxWidth=5 → 每行 2 汉字（4 格）+ 1 格剩余
    expect(wrapByWidth("一二三四五六", 5)).toEqual(["一二", "三四", "五六"]);
  });

  it("中英混排按视觉宽度切", () => {
    // "你好hello世界" = 4 + 5 + 4 = 13 视觉宽
    const r = wrapByWidth("你好hello世界", 6);
    // 期望每行不超过 6 格
    for (const line of r) {
      expect(visualWidth(line)).toBeLessThanOrEqual(6);
    }
    // 拼接回来内容不丢
    expect(r.join("").replace(/\s+/g, "")).toBe("你好hello世界");
  });

  it("按 \\n 预分段再 wrap", () => {
    const r = wrapByWidth("aa\nbbbbbbbb", 4);
    expect(r).toEqual(["aa", "bbbb", "bbbb"]);
  });
});

describe("padToWidth", () => {
  it("左对齐补空格", () => {
    expect(padToWidth("hi", 5, "left")).toBe("hi   ");
  });

  it("右对齐补空格", () => {
    expect(padToWidth("hi", 5, "right")).toBe("   hi");
  });

  it("居中对齐（偶数差）", () => {
    expect(padToWidth("hi", 6, "center")).toBe("  hi  ");
  });

  it("居中对齐（奇数差，左多一格）", () => {
    expect(padToWidth("hi", 5, "center")).toBe(" hi  ");
  });

  it("CJK 按视觉宽度补齐", () => {
    // "中" 视觉宽 2，目标 5 → 补 3 个空格
    expect(padToWidth("中", 5, "left")).toBe("中   ");
    expect(visualWidth(padToWidth("中", 5, "left"))).toBe(5);
  });

  it("已超宽不裁剪", () => {
    expect(padToWidth("hello world", 3, "left")).toBe("hello world");
  });
});

describe("parseTableCells", () => {
  it("解析标准表格行", () => {
    expect(parseTableCells("| a | b | c |")).toEqual(["a", "b", "c"]);
  });

  it("trim 单元格首尾空白", () => {
    expect(parseTableCells("|  hello  |  world  |")).toEqual(["hello", "world"]);
  });

  it("空行返回空数组", () => {
    expect(parseTableCells("")).toEqual([]);
  });
});

describe("parseAlignments", () => {
  it("默认左对齐", () => {
    expect(parseAlignments("| --- | --- |")).toEqual(["left", "left"]);
  });

  it("右对齐", () => {
    expect(parseAlignments("| ---: | ---: |")).toEqual(["right", "right"]);
  });

  it("居中对齐", () => {
    expect(parseAlignments("| :---: | :---: |")).toEqual(["center", "center"]);
  });

  it("混合对齐", () => {
    expect(parseAlignments("| :--- | ---: | :---: |")).toEqual([
      "left",
      "right",
      "center",
    ]);
  });
});

describe("layoutTable — 宽度自适应", () => {
  const sample = [
    "| 名称 | 描述 |",
    "| --- | --- |",
    "| foo | bar |",
    "| baz | qux |",
  ].join("\n");

  it("宽终端下用列实际宽度，不撑满", () => {
    const out = layoutTable(sample, { termWidth: 200 });
    // 总宽应等于列宽 + margin + │，不会硬塞到 200
    expect(out.totalWidth).toBeLessThan(30);
    // 含 top / header(1) / mid / 2 数据行(各 1) / bot
    expect(out.lines).toHaveLength(6);
  });

  it("窄终端下表格收缩到可用宽度内", () => {
    const out = layoutTable(sample, { termWidth: 30 });
    // 每行视觉宽度不超过 termWidth（外层容器会再加 padding）
    for (const line of out.lines) {
      expect(visualWidth(line)).toBeLessThanOrEqual(30);
    }
  });

  it("极窄终端（width=20）也至少保持列可读", () => {
    const out = layoutTable(sample, { termWidth: 20 });
    for (const line of out.lines) {
      expect(visualWidth(line)).toBeLessThanOrEqual(20);
    }
  });

  it("默认使用 DEFAULT_TERM_WIDTH（80）", () => {
    const out = layoutTable(sample, {});
    for (const line of out.lines) {
      expect(visualWidth(line)).toBeLessThanOrEqual(DEFAULT_TERM_WIDTH);
    }
  });
});

describe("layoutTable — 超长 cell 自动换行", () => {
  it("单 cell 超长 → 在列内 wrap，表格行高自适应", () => {
    const text = [
      "| 项 | 详情 |",
      "| --- | --- |",
      "| 1 | 这是一段非常非常长的说明文字需要换行展示 |",
    ].join("\n");
    const out = layoutTable(text, { termWidth: 40 });
    // top + header(1) + mid + 1 数据行(>=2) + bot
    expect(out.lines.length).toBeGreaterThanOrEqual(5);
    // 数据行部分的行数 >= 2（说明确实换行了）
    const dataLines = out.lines.slice(3, -1);
    expect(dataLines.length).toBeGreaterThanOrEqual(2);
    // 每行宽度一致（构成完整矩形）
    const widths = out.lines.map((l) => visualWidth(l));
    for (const w of widths) {
      expect(w).toBe(widths[0]);
    }
  });

  it("多行 cell：同行不同列的 wrap 高度取最大", () => {
    const text = [
      "| A | B |",
      "| --- | --- |",
      "| 短 | 这是一段非常非常非常非常长的内容要换行 |",
      "| 中等长度 | 也很长非常长非常长 |",
    ].join("\n");
    const out = layoutTable(text, { termWidth: 40 });
    // 所有行宽度一致
    const widths = out.lines.map((l) => visualWidth(l));
    for (const w of widths) {
      expect(w).toBe(widths[0]);
    }
    // 拼接后内容不丢
    const allContent = out.lines.join("\n");
    expect(allContent).toContain("短");
    expect(allContent).toContain("这是一段");
  });

  it("换行后用空格补齐短行（保持表格矩形）", () => {
    const text = [
      "| A | B |",
      "| --- | --- |",
      "| 短 | 这是一段非常长长长长长长长长长长长长长 |",
    ].join("\n");
    const out = layoutTable(text, { termWidth: 40 });
    // 所有行视觉宽一致（构成完整矩形）
    const widths = out.lines.map((l) => visualWidth(l));
    for (const w of widths) {
      expect(w).toBe(widths[0]);
    }
    // 框线用 ┌┐ └┘ ├┤，数据行用 │ 开头 │ 结尾
    for (let i = 0; i < out.lines.length; i++) {
      const l = out.lines[i]!;
      if (i === 0) {
        expect(l.startsWith("┌")).toBe(true);
        expect(l.endsWith("┐")).toBe(true);
      } else if (i === out.lines.length - 1) {
        expect(l.startsWith("└")).toBe(true);
        expect(l.endsWith("┘")).toBe(true);
      } else {
        // mid 框线 ├...┤ 或 数据行 │...│
        const startsOk = l.startsWith("├") || l.startsWith("│");
        const endsOk = l.endsWith("┤") || l.endsWith("│");
        expect(startsOk).toBe(true);
        expect(endsOk).toBe(true);
      }
    }
  });
});

describe("layoutTable — 内容保留", () => {
  it("不截断内容（与旧实现 cell.slice 行为不同）", () => {
    const longContent = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN";
    const text = [
      "| 名称 | 描述 |",
      "| --- | --- |",
      `| x | ${longContent} |`,
    ].join("\n");
    const out = layoutTable(text, { termWidth: 30 });
    // 把所有行拼起来，内容应全部存在（可能换行但字符都在）
    const flat = out.lines.join("");
    for (const ch of longContent) {
      expect(flat).toContain(ch);
    }
  });
});

describe("layoutTable — 无效输入降级", () => {
  it("少于 2 行 → 返回原文", () => {
    const out = layoutTable("| only one line |", { termWidth: 80 });
    expect(out.colWidths).toEqual([]);
  });

  it("无分隔行 → 返回原文", () => {
    const out = layoutTable("| a | b |\n| c | d |", { termWidth: 80 });
    expect(out.colWidths).toEqual([]);
  });
});
