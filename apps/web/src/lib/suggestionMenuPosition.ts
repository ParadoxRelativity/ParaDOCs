import { offset, shift, size, type Middleware } from '@floating-ui/react';
import type { FloatingUIOptions } from '@blocknote/react';

/**
 * Where the editor's `/`, `@` and `#` menus open.
 *
 * BlockNote's own positioning decides between below and above from the menu's
 * current size, but its last pass already cut the menu down to the room below
 * the cursor. A menu cut down to fit below always "fits" below, so near the
 * foot of the page it stayed there, shrunk to a sliver, with most of it out of
 * reach — however much room there was above.
 *
 * Here the side is chosen from the height the menu's items need, which the cut
 * does not change: below when they fit there, otherwise whichever side has more
 * room. The menu is then cut to that side's room and scrolls within it.
 */

const GAP = 10;
const PADDING = 10;

const roomierSide: Middleware = {
  name: 'roomierSide',
  fn({ placement, elements }) {
    const floating = elements.floating;
    // The list scrolls inside the popover, so its scroll height is what it
    // would take up uncut.
    const needed = Math.max(floating.scrollHeight, floating.firstElementChild?.scrollHeight ?? 0);
    const reference = elements.reference.getBoundingClientRect();
    const below = window.innerHeight - reference.bottom - GAP - PADDING;
    const above = reference.top - GAP - PADDING;
    const side = needed <= below || below >= above ? 'bottom-start' : 'top-start';
    return side === placement ? {} : { reset: { placement: side } };
  },
};

export const suggestionMenuPosition: FloatingUIOptions = {
  useFloatingOptions: {
    placement: 'bottom-start',
    middleware: [
      roomierSide,
      offset(GAP),
      shift({ padding: PADDING }),
      size({
        apply({ elements, availableHeight }) {
          elements.floating.style.maxHeight = `${Math.max(0, availableHeight)}px`;
        },
        padding: PADDING,
      }),
    ],
  },
};
