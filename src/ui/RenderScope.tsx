import { render } from "ink";
import type { ReactNode } from "react";

export interface RenderScopeHandle {
  waitUntilExit: Promise<unknown>;
  unmount: () => void;
  clear: () => void;
}

export function renderApp(node: ReactNode): RenderScopeHandle {
  // exitOnCtrlC: false — 让组件自行处理 Ctrl+C（双击退出）
  const { waitUntilExit, clear, unmount } = render(node, { exitOnCtrlC: false });
  return { waitUntilExit: waitUntilExit(), clear, unmount };
}

export async function unmountApp(handle: RenderScopeHandle): Promise<void> {
  handle.unmount();
  await new Promise((resolve) => setTimeout(resolve, 50));
}
