import { Box, Text, useInput } from "ink";
import { useState, useCallback, useEffect } from "react";
import asciichart from "asciichart";
import type { StockRow } from "./types.js";
import { useDoubleCtrlC } from "../ui/useDoubleCtrlC.js";

// ---------------------------------------------------------------------------
// 分时数据接口
// ---------------------------------------------------------------------------

/** API 接口地址模板 */
const MINUTE_API = "https://web.ifzq.gtimg.cn/appstock/app/minute/query?code={code}&r=0.1";

interface MinuteResponse {
  code: number;
  data?: Record<string, {
    data?: { data?: string[]; date?: string };
    qt?: Record<string, (string | string[])[]>;
  }>;
}

/** 确保股票代码带市场前缀（如 513090 → sh513090） */
function normalizeApiCode(code: string): string {
  if (code.startsWith("sh") || code.startsWith("sz")) return code;
  if (/^60|^68|^51/.test(code)) return "sh" + code;
  if (/^00|^30|^39/.test(code)) return "sz" + code;
  return "sh" + code;
}

/**
 * 调用分时接口获取某只股票的全天分钟数据。
 * 返回 { prices: 每分钟价格数组, quote: 实时行情快照, date: 日期 }
 */
async function fetchStockMinute(code: string): Promise<{
  prices: number[];
  quote: StockRow | null;
  date: string;
} | null> {
  const url = MINUTE_API.replace("{code}", normalizeApiCode(code));
  try {
    const resp = await fetch(url);
    const json = (await resp.json()) as MinuteResponse;
    if (json.code !== 0) return null;

    const stockKey = normalizeApiCode(code);
    const stockData = json.data?.[stockKey];
    if (!stockData) return null;

    // 1. 分钟行情 — 用于折线图
    const rawMinutes = stockData.data?.data ?? [];
    const prices: number[] = [];
    for (const line of rawMinutes) {
      // 格式: "HHMM price volume amount"
      const parts = (line as string).split(" ");
      if (parts.length >= 2) {
        const p = parseFloat(parts[1]!);
        if (!isNaN(p)) prices.push(p);
      }
    }

    // 2. 实时行情快照 — 用于列表
    const qtKey = stockKey;
    const qt = stockData.qt?.[qtKey] as string[] | undefined;
    let quote: StockRow | null = null;
    if (qt && qt.length >= 35) {
      quote = {
        code,
        name: qt[1] ?? "",
        price: parseFloat(qt[3] ?? "0"),
        changePercent: parseFloat(qt[32] ?? "0"),
        changeAmount: parseFloat(qt[31] ?? "0"),
        high: parseFloat(qt[33] ?? "0"),
        low: parseFloat(qt[34] ?? "0"),
        volume: parseInt(qt[6] ?? "0", 10),
      };
    }

    return {
      prices,
      quote,
      date: stockData.data?.date ?? "",
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 缓存
// ---------------------------------------------------------------------------

/** 缓存各股票的分钟价格数据，key = 股票代码 */
const minuteCache = new Map<string, number[]>();

function cacheMinute(code: string, prices: number[]): void {
  minuteCache.set(code, prices);
}

/** 仅用于测试环境重置缓存 */
export function _clearMinuteCache(): void {
  minuteCache.clear();
}

function getCachedMinutes(code: string): number[] | undefined {
  return minuteCache.get(code);
}

// ---------------------------------------------------------------------------
// 演示兜底数据
// ---------------------------------------------------------------------------

const FALLBACK_STOCKS: StockRow[] = [
  { code: "000001", name: "上证指数", price: 3150.00, changePercent: 0.35, changeAmount: 11.02, high: 3160.00, low: 3140.00, volume: 285430000 },
  { code: "399006", name: "创业板指", price: 1820.00, changePercent: -0.52, changeAmount: -9.50, high: 1835.00, low: 1815.00, volume: 98650000 },
  { code: "601688", name: "华泰证券", price: 14.25, changePercent: 1.05, changeAmount: 0.15, high: 14.38, low: 14.10, volume: 452100 },
];

// ---------------------------------------------------------------------------
// fetchStocks — 加载列表数据
// ---------------------------------------------------------------------------

async function fetchStocks(codes: string[]): Promise<StockRow[]> {
  const results = await Promise.all(
    codes.map(async (code) => {
      const data = await fetchStockMinute(code);
      if (data?.quote) {
        // 同时缓存分钟数据，进详情就不用再请求了
        if (data.prices.length > 0) cacheMinute(code, data.prices);
        return data.quote;
      }
      return null;
    }),
  );

  // 用真实数据替换，缺失的用兜底
  const real: StockRow[] = results.filter((r): r is StockRow => r !== null);
  if (real.length > 0) return real;

  // 全都没取到？用兜底数据
  return FALLBACK_STOCKS;
}

// ---------------------------------------------------------------------------
// 格式化工具
// ---------------------------------------------------------------------------

function formatPrice(p: number): string {
  return p >= 100 ? p.toFixed(2) : p.toFixed(3);
}

function formatVolume(v: number): string {
  if (v >= 10000) return (v / 10000).toFixed(1) + "万";
  return v.toLocaleString();
}

/**
 * 取最新 maxPoints 个点，用于绘制折线图。
 * 分时数据从 09:30 累积到当前时间，取尾部最新的 60 点
 * 能展示最近的行情走势，同时适配终端宽度。
 */
function latestPoints(data: number[], maxPoints = 60): number[] {
  if (data.length <= maxPoints) return data;
  return data.slice(data.length - maxPoints);
}

// ---------------------------------------------------------------------------
// StockList 组件
// ---------------------------------------------------------------------------

interface StockListProps {
  /** 自选股代码列表 */
  codes?: string[];
  /** 按 q 时退出 */
  onExit: () => void;
  /** 按 q 时返回上级（从 chat 内跳转时使用） */
  onBackToChat?: () => void;
}

export function StockList({ codes, onExit, onBackToChat }: StockListProps) {
  const [stocks, setStocks] = useState<StockRow[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState<string>("");
  const [detailView, setDetailView] = useState<StockRow | null>(null);
  const [detailPrices, setDetailPrices] = useState<number[] | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailCountdown, setDetailCountdown] = useState(10);
  const [countdown, setCountdown] = useState(5);

  const { doubleCtrlC, handleCtrlC } = useDoubleCtrlC(onExit);

  // ---------- 数据加载 ----------
  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchStocks(codes ?? []);
      setStocks(data);
      setLastUpdate(new Date().toLocaleTimeString());
    } catch {
      // 保持旧数据
    }
    setLoading(false);
  }, [codes]);

  // 首次加载
  useEffect(() => {
    loadData();
  }, [loadData]);

  // 5 秒自动刷新 + 倒计时
  useEffect(() => {
    const interval = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          loadData();
          return 5;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [loadData]);

  // ---------- 进入详情时加载分钟数据，每 30s 自动刷新 ----------
  useEffect(() => {
    if (!detailView) {
      setDetailPrices(null);
      setDetailLoading(false);
      return;
    }

    const loadDetail = () => {
      // 清除缓存，强制走网络
      minuteCache.delete(detailView.code);
      fetchStockMinute(detailView.code).then((data) => {
        if (data && data.prices.length > 0) {
          cacheMinute(detailView.code, data.prices);
          setDetailPrices(data.prices);
        }
      });
    };

    // 立即加载
    loadDetail();

    // 重置倒计时
    setDetailCountdown(10);

    // 每 10 秒刷新
    const timer = setInterval(loadDetail, 10000);
    return () => clearInterval(timer);
  }, [detailView]);

  // 详情页倒计时
  useEffect(() => {
    if (!detailView) return;
    const timer = setInterval(() => {
      setDetailCountdown((prev) => (prev > 0 ? prev - 1 : 10));
    }, 1000);
    return () => clearInterval(timer);
  }, [detailView]);

  // ---------- 键盘控制 ----------
  useInput(
    useCallback(
      (input, key) => {
        // Ctrl+C：双击退出
        if (input === "c" && key.ctrl) {
          handleCtrlC();
          return;
        }

        if (detailView) {
          // 详情模式下按 Esc/q 返回列表
          if (key.escape || input === "q" || input === " ") {
            setDetailView(null);
          }
          return;
        }

        if (stocks.length === 0) return;

        if (key.upArrow || input === "k") {
          setSelectedIndex((prev) => (prev > 0 ? prev - 1 : stocks.length - 1));
        } else if (key.downArrow || input === "j") {
          setSelectedIndex((prev) => (prev < stocks.length - 1 ? prev + 1 : 0));
        } else if (key.return) {
          const stock = stocks[selectedIndex];
          if (stock) setDetailView(stock);
        } else if (key.escape || input === "q") {
          if (onBackToChat) onBackToChat();
          else onExit();
        } else if (input === "r") {
          setCountdown(5);
          loadData();
        }
      },
      [stocks, selectedIndex, detailView, onExit, onBackToChat, loadData, handleCtrlC],
    ),
  );

  // ---------- 详情视图 ----------
  if (detailView) {
    if (detailLoading) {
      return (
        <Box paddingLeft={1}>
          <Text dimColor>{"  ⟳ 加载分时数据..."}</Text>
        </Box>
      );
    }
    return renderDetail(detailView, () => setDetailView(null), detailPrices ?? undefined, detailCountdown);
  }

  // ---------- 列表视图 ----------
  return (
    <Box flexDirection="column">
      {/* 顶部状态栏 */}
      <Box marginBottom={1} justifyContent="space-between">
        <Text bold color="#00ffff">
          {"  📈 自选股监控"}
        </Text>
        <Text dimColor>
          {loading ? "  ⟳ 刷新中..." : `  每 ${countdown}s 自动刷新`}
        </Text>
      </Box>

      {/* 表头 */}
      <Box>
        <Box width={3} />
        <Box width={9}>
          <Text dimColor>代码</Text>
        </Box>
        <Box width={16}>
          <Text dimColor>名称</Text>
        </Box>
        <Box width={12}>
          <Text dimColor>最新价</Text>
        </Box>
        <Box width={12}>
          <Text dimColor>涨跌幅</Text>
        </Box>
        <Box width={12}>
          <Text dimColor>涨跌额</Text>
        </Box>
        <Box width={12}>
          <Text dimColor>最高</Text>
        </Box>
        <Box width={12}>
          <Text dimColor>最低</Text>
        </Box>
        <Box>
          <Text dimColor>成交量</Text>
        </Box>
      </Box>

      {/* 分隔线 */}
      <Box>
        <Text dimColor>{"  " + "─".repeat(100)}</Text>
      </Box>

      {/* 股票列表 */}
      <Box flexDirection="column">
        {stocks.map((stock, index) => {
          const isSelected = index === selectedIndex;
          const isUp = stock.changePercent >= 0;
          const color = isUp ? "#ff1493" : "#00ff41";

          return (
            <Box key={stock.code}>
              <Box width={3} flexShrink={0}>
                {isSelected ? (
                  <Text bold color="#00ffff">
                    {"▸ "}
                  </Text>
                ) : (
                  <Text>{"  "}</Text>
                )}
              </Box>
              <Box width={9}>
                <Text bold color={isSelected ? "#00ffff" : "#ffffff"}>
                  {stock.code}
                </Text>
              </Box>
              <Box width={16}>
                <Text color={isSelected ? "#ffffff" : "#cccccc"}>
                  {stock.name}
                </Text>
              </Box>
              <Box width={12}>
                <Text bold color={color}>
                  {formatPrice(stock.price)}
                </Text>
              </Box>
              <Box width={12}>
                <Text color={color}>
                  {isUp ? "+" : ""}{stock.changePercent.toFixed(2)}%
                </Text>
              </Box>
              <Box width={12}>
                <Text color={color}>
                  {isUp ? "+" : ""}{stock.changeAmount.toFixed(3)}
                </Text>
              </Box>
              <Box width={12}>
                <Text color="#cccccc">
                  {formatPrice(stock.high)}
                </Text>
              </Box>
              <Box width={12}>
                <Text color="#cccccc">
                  {formatPrice(stock.low)}
                </Text>
              </Box>
              <Box>
                <Text color="#888888">
                  {formatVolume(stock.volume)}
                </Text>
              </Box>
            </Box>
          );
        })}
      </Box>

      {/* 底栏 */}
      <Box marginTop={1}>
        <Text dimColor>
          {`  ↑/↓ 选择  Enter 详情  r 手动刷新  q 返回`}
        </Text>
      </Box>
      <Box>
        <Text dimColor>
          {`  最后更新: ${lastUpdate}`}
        </Text>
      </Box>

      {/* 双击 Ctrl+C 退出提示 */}
      {doubleCtrlC && (
        <Box marginTop={1}>
          <Text color="#ff1493" bold>
            {"  ⚠ 再按一次 Ctrl+C 退出 dskcode"}
          </Text>
        </Box>
      )}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// 详情视图（独立的渲染函数）
// ---------------------------------------------------------------------------

function renderDetail(stock: StockRow, _onBack: () => void, prices?: number[], countdown = 10) {
  const isUp = stock.changePercent >= 0;
  const colorCode = isUp ? "#ff1493" : "#00ff41";
  const arrow = isUp ? "▲" : "▼";

  // 折线图
  let chartLines: string[] = [];
  if (prices && prices.length > 0) {
    const chartColor = isUp ? asciichart.red : asciichart.green;
    // 取最新 60 条分时数据展示近期走势
    const latest = latestPoints(prices, 60);
    let raw = asciichart.plot(latest, {
      height: 10,
      colors: [chartColor],
    });
    // 弯角 → 直角，折线更硬朗
    raw = raw
      .replaceAll("╭", "┌")
      .replaceAll("╮", "┐")
      .replaceAll("╰", "└")
      .replaceAll("╯", "┘");
    chartLines = raw.split("\n");
  }

  return (
    <Box flexDirection="column" paddingLeft={1}>
      {/* 标题行 — 左：名称代码，右：刷新倒计时 */}
      <Box marginBottom={1} justifyContent="space-between">
        <Box>
          <Text bold color="#00ffff">
            {"  📊 "}{stock.name}{" "}
          </Text>
          <Text dimColor>
            {stock.code}
          </Text>
        </Box>
        <Text dimColor>
          {`每 ${countdown}s 刷新`}
        </Text>
      </Box>

      {/* 价格摘要 */}
      <Box>
        <Box width={16}>
          <Text bold color="#888888">当前价</Text>
        </Box>
        <Box>
          <Text bold color={colorCode}>
            {arrow} {formatPrice(stock.price)}
          </Text>
        </Box>
      </Box>
      <Box>
        <Box width={16}>
          <Text color="#888888">涨跌幅</Text>
        </Box>
        <Box>
          <Text color={colorCode}>
            {isUp ? "+" : ""}{stock.changePercent.toFixed(2)}%
            {"  "}
            {isUp ? "+" : ""}{stock.changeAmount.toFixed(3)}
          </Text>
        </Box>
      </Box>

      {/* 折线图 */}
      {chartLines.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          {chartLines.map((line, i) => (
            <Box key={i}>
              <Text color={colorCode}>
                {line || " "}
              </Text>
            </Box>
          ))}
        </Box>
      )}

      {/* 底部 */}
      <Box marginTop={1}>
        <Text dimColor>
          {"  Space/q 返回列表"}
        </Text>
      </Box>
    </Box>
  );
}
