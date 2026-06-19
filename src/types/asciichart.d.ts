declare module "asciichart" {
  interface PlotConfig {
    height?: number;
    colors?: readonly number[];
    format?: (x: number) => string;
  }

  const asciichart: {
    plot(series: readonly number[], config?: PlotConfig): string;
    black: number;
    red: number;
    green: number;
    yellow: number;
    blue: number;
    magenta: number;
    cyan: number;
    lightgray: number;
    default: number;
    darkgray: number;
    lightred: number;
    lightgreen: number;
    lightyellow: number;
    lightblue: number;
    lightmagenta: number;
    lightcyan: number;
    white: number;
    reset: number;
    colored: boolean;
  };

  export default asciichart;
}
