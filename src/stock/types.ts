/** 单只股票的快照数据 */
export interface StockSnapshot {
  /** 股票代码 */
  code: string;
  /** 股票名称 */
  name: string;
  /** 当前价 */
  price: number;
  /** 涨跌幅（百分比，如 -3.32） */
  changePercent: number;
  /** 涨跌额 */
  changeAmount: number;
  /** 昨收 */
  prevClose: number;
  /** 今日最高 */
  high: number;
  /** 今日最低 */
  low: number;
  /** 成交量（手） */
  volume: number;
  /** 成交额 */
  amount: number;
  /** 换手率 */
  turnoverRate: number;
  /** 市盈率（动态） */
  pe?: number;
}

/** 股票详情（含分时数据） */
export interface StockDetail extends StockSnapshot {
  /** 开盘价 */
  open: number;
  /** 振幅 */
  amplitude: number;
  /** 量比 */
  volumeRatio: number;
  /** 外盘 */
  outerDisc: number;
  /** 内盘 */
  innerDisc: number;
  /** 涨停价 */
  limitUp: number;
  /** 跌停价 */
  limitDown: number;
  /** 总市值 */
  totalMarketCap: number;
  /** 流通市值 */
  floatMarketCap: number;
  /** 分时数据（待接入） */
  minutes?: unknown[];
}

/** 组件内使用的股票显示行 */
export interface StockRow {
  code: string;
  name: string;
  price: number;
  changePercent: number;
  changeAmount: number;
  high: number;
  low: number;
  /** 成交量（手） */
  volume: number;
  /** 成交额（元） */
  amount: number;
}
