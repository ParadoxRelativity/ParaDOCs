import { useEffect, useRef } from 'react';
import { isNativeApp } from './server';

/**
 * Android's back button, undoing the last thing opened. Dialogs, menus and
 * panels are component state rather than routes, so each one says it handles
 * back for as long as it is open, and a press goes to whichever was opened
 * most recently. Moving between the phone's menu and what was chosen from it
 * is the floor beneath all of those; with nothing left to undo the app is put
 * away, as Android would have done.
 */
interface Entry {
  run: () => void;
  base: boolean;
}

const stack: Entry[] = [];

/** The handler a press goes to: the newest overlay, or failing that the newest floor. */
function top(): Entry | undefined {
  for (let i = stack.length - 1; i >= 0; i--) if (!stack[i].base) return stack[i];
  return stack[stack.length - 1];
}

/**
 * Has back call `onBack` while `active`. A `base` handler is only reached once
 * every overlay has closed, however the two were mounted: a link straight to
 * an open work item mounts its panel before the view it sits in.
 */
export function useBackHandler(onBack: () => void, { active = true, base = false } = {}) {
  const handler = useRef(onBack);
  handler.current = onBack;
  useEffect(() => {
    if (!active) return;
    const entry: Entry = { run: () => handler.current(), base };
    stack.push(entry);
    return () => {
      const index = stack.lastIndexOf(entry);
      if (index >= 0) stack.splice(index, 1);
    };
  }, [active, base]);
}

/** Undoes the last thing opened, saying whether there was anything to undo. */
export function goBack(): boolean {
  const entry = top();
  entry?.run();
  return entry !== undefined;
}

/**
 * Takes over the back button in the mobile app. Registering any listener turns
 * off Android's own handling, so at the root this minimises the app itself.
 */
export function listenForBackButton() {
  if (!isNativeApp) return;
  void (async () => {
    const { App } = await import('@capacitor/app');
    await App.addListener('backButton', () => {
      if (!goBack()) void App.minimizeApp();
    });
  })();
}
