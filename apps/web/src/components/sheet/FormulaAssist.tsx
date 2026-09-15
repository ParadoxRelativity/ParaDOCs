import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import {
  activeArgument,
  formulaContext,
  functionHelp,
  suggestFunctions,
  type FunctionHelp,
} from '@paradocs/shared';
import { cx } from '../../lib/util';

/**
 * Help while a formula is typed, for the cell editor and the formula bar alike:
 * function names to pick from as a name is typed, and once inside a call, what
 * it takes with the current argument picked out.
 *
 * The input keeps the focus throughout. The list is driven from the keyboard
 * — arrows to move, Tab or Enter to take one, Escape to put it away — and a
 * click on it is caught before the input would blur, because a blur commits
 * the cell.
 */
export function useFormulaAssist(
  input: RefObject<HTMLInputElement | null>,
  /** What is in the input, or null while it is not being edited. */
  value: string | null,
  setValue: (value: string) => void,
) {
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const pendingCaret = useRef<number | null>(null);

  const context = value === null ? null : formulaContext(value, caret);
  const suggestions = !dismissed && context?.word ? suggestFunctions(context.word.text) : [];
  const call = context?.call ? functionHelp(context.call.name) : null;
  const wordKey = context?.word ? `${context.word.start}:${context.word.text}` : '';

  // A fresh word starts at the top of the list; editing brings it back after Escape.
  useEffect(() => setActive(0), [wordKey]);
  useEffect(() => setDismissed(false), [value]);

  // Puts the caret after an inserted name, and otherwise keeps up with where it
  // is — a keystroke changes the value before the input reports a selection.
  useLayoutEffect(() => {
    const element = input.current;
    if (!element) return;
    if (pendingCaret.current !== null) {
      element.setSelectionRange(pendingCaret.current, pendingCaret.current);
      setCaret(pendingCaret.current);
      pendingCaret.current = null;
    } else if (document.activeElement === element && element.selectionStart !== null && element.selectionStart !== caret) {
      setCaret(element.selectionStart);
    }
  });

  const syncCaret = () => {
    const element = input.current;
    if (element) setCaret(element.selectionStart ?? element.value.length);
  };

  const accept = (help: FunctionHelp) => {
    if (value === null || !context?.word) return;
    const { start } = context.word;
    const rest = value.slice(caret);
    const insert = rest.startsWith('(') ? help.name : `${help.name}(`;
    pendingCaret.current = start + insert.length + (rest.startsWith('(') ? 1 : 0);
    setValue(value.slice(0, start) + insert + rest);
  };

  /** Handles a key meant for the hints. Returns true when it was, so the input's own handling is skipped. */
  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): boolean => {
    if (suggestions.length === 0) return false;
    switch (event.key) {
      case 'ArrowDown':
        setActive((index) => (index + 1) % suggestions.length);
        break;
      case 'ArrowUp':
        setActive((index) => (index - 1 + suggestions.length) % suggestions.length);
        break;
      case 'Tab':
      case 'Enter':
        accept(suggestions[Math.min(active, suggestions.length - 1)]);
        break;
      case 'Escape':
        setDismissed(true);
        break;
      default:
        return false;
    }
    event.preventDefault();
    event.stopPropagation();
    return true;
  };

  const popup =
    value !== null && (suggestions.length > 0 || call) ? (
      <AssistPanel
        anchor={input}
        suggestions={suggestions}
        active={Math.min(active, suggestions.length - 1)}
        onPick={accept}
        call={call}
        argument={context?.call?.argument ?? 0}
      />
    ) : null;

  return {
    onKeyDown,
    /** Keeps track of where the caret is; wire to the input's onSelect. */
    onSelect: syncCaret,
    popup,
  };
}

function AssistPanel({
  anchor,
  suggestions,
  active,
  onPick,
  call,
  argument,
}: {
  anchor: RefObject<HTMLInputElement | null>;
  suggestions: FunctionHelp[];
  active: number;
  onPick: (help: FunctionHelp) => void;
  call: FunctionHelp | null;
  argument: number;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const element = anchor.current;
    const box = panel.current;
    if (!element || !box) return;
    const rect = element.getBoundingClientRect();
    const margin = 4;
    const below = rect.bottom + margin;
    const top = below + box.offsetHeight > window.innerHeight - 8 ? rect.top - box.offsetHeight - margin : below;
    const left = Math.min(Math.max(8, rect.left), window.innerWidth - box.offsetWidth - 8);
    setPosition((current) => (current?.left === left && current.top === top ? current : { left, top }));
  });

  const highlighted = suggestions[active];

  return createPortal(
    <div
      ref={panel}
      // Clicking here must not take the focus from the input, which would commit the cell.
      onMouseDown={(event) => event.preventDefault()}
      className="fixed z-[70] w-80 max-w-[calc(100vw-16px)] overflow-hidden rounded-lg border border-[var(--color-line)] bg-[var(--color-raised)] text-xs shadow-xl"
      style={{ left: position?.left ?? 0, top: position?.top ?? 0, visibility: position ? 'visible' : 'hidden' }}
    >
      {suggestions.length > 0 ? (
        <>
          <ul role="listbox" aria-label="Functions" className="max-h-56 overflow-y-auto py-1">
            {suggestions.map((help, index) => (
              <li
                key={help.name}
                role="option"
                aria-selected={index === active}
                onClick={() => onPick(help)}
                className={cx(
                  'flex cursor-pointer items-baseline gap-2 px-3 py-1',
                  index === active ? 'bg-[var(--color-accent-soft)]' : 'hover:bg-[var(--color-surface)]',
                )}
              >
                <span className="font-mono font-medium text-[var(--color-ink)]">{help.name}</span>
                <span className="truncate font-mono text-[11px] text-[var(--color-muted)]">({help.args.join(', ')})</span>
              </li>
            ))}
          </ul>
          {highlighted?.summary && (
            <div className="border-t border-[var(--color-line)] px-3 py-1.5 text-[11px] text-[var(--color-muted)]">
              {highlighted.summary}
              <span className="ml-1 opacity-70">Tab to insert</span>
            </div>
          )}
        </>
      ) : (
        call && <Signature help={call} argument={argument} />
      )}
    </div>,
    document.body,
  );
}

function Signature({ help, argument }: { help: FunctionHelp; argument: number }) {
  const current = activeArgument(help, argument);
  return (
    <div className="px-3 py-2">
      <div className="font-mono">
        <span className="font-medium">{help.name}</span>(
        {help.args.map((arg, index) => (
          <span key={index}>
            {index > 0 && ', '}
            <span
              className={cx(
                index === current ? 'rounded bg-[var(--color-accent-soft)] px-0.5 font-semibold text-[var(--color-accent)]' : 'text-[var(--color-muted)]',
              )}
            >
              {arg}
            </span>
          </span>
        ))}
        )
      </div>
      {help.summary && <div className="mt-1 text-[11px] text-[var(--color-muted)]">{help.summary}</div>}
    </div>
  );
}
