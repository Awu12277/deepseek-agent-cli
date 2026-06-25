import { useState, useCallback, useEffect, useRef } from "react";

const CTRL_C_TIMEOUT_MS = 1500;

/**
 * 提供"双击 Ctrl+C 才退出"的交互逻辑。
 *
 * - 第一次 Ctrl+C：设置提示状态，1.5 秒后自动重置
 * - 第二次 Ctrl+C（1.5 秒内）：执行 onExit 回调
 *
 * 返回 { doubleCtrlC, handleCtrlC }，组件通过 useInput 捕获
 * Ctrl+C 后调用 handleCtrlC，并根据 doubleCtrlC 显示提示。
 */
export function useDoubleCtrlC(onExit: () => void) {
  const [doubleCtrlC, setDoubleCtrlC] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(null);
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;

  // 组件卸载时清理定时器
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleCtrlC = useCallback(() => {
    if (doubleCtrlC) {
      // 第二次 Ctrl+C → 退出
      onExitRef.current();
      return;
    }

    // 第一次 Ctrl+C → 显示提示，启动倒计时重置
    setDoubleCtrlC(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setDoubleCtrlC(false);
      timerRef.current = null;
    }, CTRL_C_TIMEOUT_MS);
  }, [doubleCtrlC]);

  return { doubleCtrlC, handleCtrlC };
}