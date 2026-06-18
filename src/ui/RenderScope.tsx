import { render } from "ink";
import type { ReactNode } from "react";

export interface RenderScopeHandle {
  waitUntilExit: Promise<unknown>;
  unmount: () => void;
  clear: () => void;
}

export function renderApp(node: ReactNode): RenderScopeHandle {
  const { waitUntilExit, clear, unmount } = render(node);
  return { waitUntilExit: waitUntilExit(), clear, unmount };
}

export async function unmountApp(handle: RenderScopeHandle): Promise<void> {
  handle.unmount();
  await new Promise((resolve) => setTimeout(resolve, 50));
}
