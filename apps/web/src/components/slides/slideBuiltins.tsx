import { themeColor, type ShapeKind } from '@paradocs/shared';
import { registerSlideInsertTool, type SlideEditorContext } from './slideExtensions';

/**
 * What the editor can insert before any other story registers more: a text box
 * and the canvas shapes. Rich text boxes, tables, images and media (PARA-90)
 * register themselves the same way, and may take over these ids.
 */

/** A new element is centred on the slide, then offset a little per element already there so repeats do not stack exactly. */
function placed(ctx: SlideEditorContext, width: number, height: number) {
  const n = ctx.slide?.elements.length ?? 0;
  const nudge = (n % 6) * 24;
  return { x: Math.round(ctx.center.x - width / 2 + nudge), y: Math.round(ctx.center.y - height / 2 + nudge), width, height };
}

function insertShape(shape: ShapeKind) {
  return (ctx: SlideEditorContext) => {
    if (!ctx.slide) return;
    const id = ctx.actions.createElement(ctx.slide.id, {
      type: 'shape',
      shape,
      ...placed(ctx, 360, 240),
      fill: themeColor('accent1'),
      stroke: themeColor('accent1'),
      strokeWidth: 2,
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
      type: 'text',
      text: '',
      fontSize: 48,
      color: themeColor('dark1'),
      ...placed(ctx, 640, 90),
    });
    ctx.select([id]);
    ctx.edit(id);
  },
});
registerSlideInsertTool({ id: 'shape-rectangle', label: 'Rectangle', icon: 'square', order: 20, run: insertShape('rectangle') });
registerSlideInsertTool({ id: 'shape-ellipse', label: 'Ellipse', icon: 'circle', order: 21, run: insertShape('ellipse') });
registerSlideInsertTool({ id: 'shape-triangle', label: 'Triangle', icon: 'triangle', order: 22, run: insertShape('triangle') });
registerSlideInsertTool({ id: 'shape-diamond', label: 'Diamond', icon: 'diamond', order: 23, run: insertShape('diamond') });
