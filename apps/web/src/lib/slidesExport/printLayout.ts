import { slideAspectRatio, type SlideSize } from '@paradocs/shared';

/**
 * How a deck is laid out on paper for the PDF: one slide per page at the
 * slide's own shape, a notes page (slide above its speaker notes), or
 * handouts with several slides on a portrait page. Sizes are CSS pixels (96
 * to the inch), which is what `@page` and the slide renderer both speak.
 */

export type HandoutPerPage = 2 | 3 | 4 | 6;
export const HANDOUT_COUNTS: HandoutPerPage[] = [2, 3, 4, 6];

export type PdfLayout = { kind: 'slides' } | { kind: 'notes' } | { kind: 'handout'; perPage: HandoutPerPage };

/** US Letter, portrait. */
export const PAPER = { width: 816, height: 1056, margin: 48 };

/** The width one slide is drawn at on a page of its own: 13.33 in for a 16:9 deck. */
export const SLIDE_PAGE_WIDTH = 1280;

export interface Sheet {
  width: number;
  height: number;
}

/** The size of every page of the document. */
export function sheetFor(layout: PdfLayout, size: SlideSize): Sheet {
  if (layout.kind !== 'slides') return { width: PAPER.width, height: PAPER.height };
  return { width: SLIDE_PAGE_WIDTH, height: Math.round(SLIDE_PAGE_WIDTH / slideAspectRatio(size)) };
}

/** The `size` of the `@page` rule for a sheet. */
export function pageSizeCss(sheet: Sheet): string {
  return `${sheet.width}px ${sheet.height}px`;
}

export function handoutGrid(perPage: HandoutPerPage): { columns: number; rows: number } {
  switch (perPage) {
    case 2:
      return { columns: 1, rows: 2 };
    case 3:
      return { columns: 1, rows: 3 };
    case 4:
      return { columns: 2, rows: 2 };
    case 6:
      return { columns: 2, rows: 3 };
  }
}

export function chunk<T>(items: T[], size: number): T[][] {
  const pages: T[][] = [];
  for (let i = 0; i < items.length; i += size) pages.push(items.slice(i, i + size));
  return pages;
}

/** Width of one slide thumbnail in a handout of this many to a page. */
export function handoutSlideWidth(perPage: HandoutPerPage, size: SlideSize): number {
  const { columns, rows } = handoutGrid(perPage);
  const gap = 24;
  const usableWidth = PAPER.width - PAPER.margin * 2 - gap * (columns - 1);
  const usableHeight = PAPER.height - PAPER.margin * 2 - gap * (rows - 1);
  const byWidth = usableWidth / columns;
  // Room is left under each for a caption line.
  const byHeight = (usableHeight / rows - 28) * slideAspectRatio(size);
  return Math.floor(Math.min(byWidth, byHeight));
}
