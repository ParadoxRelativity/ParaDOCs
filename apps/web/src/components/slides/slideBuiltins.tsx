import { themeColor, type SlideShapeKind } from '@paradocs/shared';
import type { IconName } from '../Icon';
import { registerSlideInsertTool, type SlideEditorContext } from './slideExtensions';

/**
 * What the editor can insert: a text box, shapes, and a table. Pictures,
 * video and web pages register themselves from SlideMediaElements.tsx the same
 * way. The text box is a rich text box (a Y.XmlFragment body), not the canvas
 * text element it started as.
 */

/** A new element is centred on the slide, then offset a little per element already there so repeats do not stack exactly. */
function placed(ctx: SlideEditorContext, width: number, height: number) {
  const n = ctx.slide?.elements.length ?? 0;
  const nudge = (n % 6) * 24;
  return { x: Math.round(ctx.center.x - width / 2 + nudge), y: Math.round(ctx.center.y - height / 2 + nudge), width, height };
}

function insertShape(shape: SlideShapeKind) {
  return (ctx: SlideEditorContext) => {
    if (!ctx.slide) return;
    const line = shape === 'line';
    const id = ctx.actions.createElement(ctx.slide.id, {
      type: 'shape',
      shape,
      ...(line ? placed(ctx, 480, 40) : placed(ctx, 360, 240)),
      fill: line ? 'transparent' : themeColor('accent1'),
      stroke: line ? themeColor('text1') : themeColor('accent1'),
      strokeWidth: line ? 6 : 2,
    });
    ctx.select([id]);
  };
}

registerSlideInsertTool({
  id: 'text',
  label: 'Text box',
  icon: 'fonts',
  order: 10,
  run: (ctx) => {
    if (!ctx.slide) return;
    const id = ctx.actions.createElement(ctx.slide.id, {
      type: 'richText',
      fontSize: 48,
      color: themeColor('text1'),
      ...placed(ctx, 800, 150),
    });
    ctx.select([id]);
    ctx.edit(id);
  },
});

const SHAPES: [SlideShapeKind, string, IconName][] = [
  ['rectangle', 'Rectangle', 'square'],
  ['roundRect', 'Rounded rectangle', 'app'],
  ['ellipse', 'Ellipse', 'circle'],
  ['triangle', 'Triangle', 'triangle'],
  ['diamond', 'Diamond', 'diamond'],
  ['arrowRight', 'Arrow', 'arrow-right'],
  ['callout', 'Callout', 'chat-square'],
  ['star', 'Star', 'star'],
  ['line', 'Line', 'dash-lg'],
];
SHAPES.forEach(([shape, label, icon], i) => registerSlideInsertTool({ id: `shape-${shape}`, label, icon, order: 20 + i / 10, run: insertShape(shape) }));

registerSlideInsertTool({
  id: 'table',
  label: 'Table',
  icon: 'table',
  order: 40,
  run: (ctx) => {
    if (!ctx.slide) return;
    const id = ctx.actions.createElement(ctx.slide.id, {
      type: 'table',
      rows: 3,
      columns: 3,
      cells: {},
      headerRow: true,
      ...placed(ctx, 1200, 360),
    });
    ctx.select([id]);
  },
});
