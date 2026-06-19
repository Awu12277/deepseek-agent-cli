/**
 * 股票行情模块
 * 基于腾讯免费行情接口 qt.gtimg.cn 获取实时报价
 */
import iconv from "iconv-lite";
import chalk from "chalk";
import type { StockSymbol } from "../config/types.js";

// ---------------------------------------------------------------------------
// 行情接口
// ---------------------------------------------------------------------------

const QT_URL = "https://qt.gtimg.cn/q={code}";

/** 解析后的单只股票行情 */
export interface StockQuote {
  /** 股票名称 */
  name: string;
  /** 股票代码 */
  code: string;
  /** 当前价 */
  price: number;
  /** 昨收价 */
  prevClose: number;
  /** 涨跌额 */
  change: number;
  /** 涨跌幅 (%) */
  changePct: number;
  /** 行情时间 (yyyyMMddHHmmss) */
  time: string;
}

/**
 * 批量获取多只股票的实时行情
 */
export async function fetchQuotes(symbols: StockSymbol[]): Promise<(StockQuote | null)[]> {
  const codes = symbols.map((s) => s.code).join(",");
  const url = QT_URL.replace("{code}", codes);

  try {
    const resp = await fetch(url);
    const buffer = Buffer.from(await resp.arrayBuffer());
    const text = iconv.decode(buffer, "gbk");

    const lines = text.trim().split("\n");
    return lines.map((line, i): StockQuote | null => {
      const m = /="([^"]+)"/.exec(line);
      if (!m || !m[1]) return null;

      const fields = m[1].split("~");
      if (fields.length < 50) return null;

      const name = symbols[i]?.name ?? fields[1] ?? "";
      const code = fields[2] ?? "";
      const price = parseFloat(fields[3] ?? "0");
      const prevClose = parseFloat(fields[4] ?? "0");
      const change = parseFloat(fields[31] ?? "0");
      const changePct = parseFloat(fields[32] ?? "0");
      const time = fields[30] ?? "";

      return { name, code, price, prevClose, change, changePct, time };
    });
  } catch (err) {
    console.error(chalk.red(`[错误] 获取行情失败: ${String(err)}`));
    return symbols.map(() => null);
  }
}

// ---------------------------------------------------------------------------
// 格式化输出
// ---------------------------------------------------------------------------

/** 计算字符串在终端中的显示宽度（中文/全角字符算2，英文/数字算1） */
function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    // CJK 统一表意文字、全角符号、韩文等
    if (
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0x3400 && cp <= 0x4dbf) ||
      (cp >= 0x20000 && cp <= 0x2a6df) ||
      (cp >= 0x2e80 && cp <= 0x2eff) ||
      (cp >= 0x3000 && cp <= 0x303f) ||
      (cp >= 0xff00 && cp <= 0xffef) ||
      (cp >= 0xac00 && cp <= 0xd7af)
    ) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}

/** 按显示宽度左对齐填充空格 */
function padDisplayEnd(s: string, width: number): string {
  return s + " ".repeat(Math.max(0, width - displayWidth(s)));
}

/** 按显示宽度右对齐填充空格 */
function padDisplayStart(s: string, width: number): string {
  return " ".repeat(Math.max(0, width - displayWidth(s))) + s;
}

/**
 * 将行情数据以表格形式打印到终端，一行一只股票
 * A 股红色涨、绿色跌
 */
export function printQuotes(quotes: (StockQuote | null)[]): void {
  // 收集有效行情，计算列宽
  const valid = quotes.filter((q): q is StockQuote => q !== null);
  if (valid.length === 0) {
    console.log(chalk.yellow("\n暂无行情数据\n"));
    return;
  }

  const nameW = Math.max(
    ...valid.map((q) => displayWidth(q.name)),
    displayWidth("名称"),
  ) + 2;
  const codeW = 8;
  const priceW = 10;
  const pctW = 10;

  const totalW = nameW + codeW + priceW + pctW;

  console.log(chalk.bold("\n📈 实时行情\n"));

  // 表头
  const header =
    "  " +
    chalk.dim(padDisplayEnd("名称", nameW)) +
    chalk.dim(padDisplayEnd("代码", codeW)) +
    chalk.dim(padDisplayStart("当前价", priceW)) +
    chalk.dim(padDisplayStart("涨跌幅", pctW));
  console.log(header);
  console.log(chalk.dim("  " + "─".repeat(totalW)));

  for (const q of quotes) {
    if (!q) {
      console.log(chalk.gray("  " + "获取失败".padEnd(totalW)));
      continue;
    }

    const color = q.change >= 0 ? chalk.redBright : q.change < 0 ? chalk.green : chalk.gray;

    const priceStr = q.price.toFixed(3);
    const pctStr = (q.changePct >= 0 ? "+" : "") + q.changePct.toFixed(2) + "%";

    const row =
      "  " +
      chalk.bold(padDisplayEnd(q.name, nameW)) +
      chalk.yellow(padDisplayEnd(q.code, codeW)) +
      color(padDisplayStart(priceStr, priceW)) +
      color(padDisplayStart(pctStr, pctW));

    console.log(row);
  }

  console.log();
}
