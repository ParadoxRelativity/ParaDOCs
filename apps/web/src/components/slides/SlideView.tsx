import { memo, type CSSProperties } from 'react';
import {
  resolveSlideColor,
  slideAspectRatio,
  type SlideElement,
  type SlideSize,
  type SlideSnapshot,
  type Theme,
  type WorkspaceMember,
} from '@paradocs/shared';
import { assetUrl } from '../../lib/server';
import { slideElementRenderer } from './slideExtensions';
import './slideContent';

const NO_MEMBERS: WorkspaceMember[] = [];
const noop = () => {};

/** The page behind a slide's elements: its own background, else the theme's light color. */
export function slideBackgroundStyle(slide: Pick<SlideSnapshot, 'background'>, theme: Theme): CSSProperties {
  const background = slide.background;
  if (background?.kind === 'image') {
    return { backgroundColor: resolveSlideColor('theme:light1', theme), backgroundImage: `url(${assetUrl(background.url)})`, backgroundSize: 'cover', backgroundPosition: 'center' };
  }
  return { background: (background?.kind === 'color' && resolveSlideColor(background.color, theme)) || resolveSlideColor('theme:light1', theme) };
}

/** An element placed on the slide in slide units, turned about its centre. */
export function elementBoxStyle(element: Pick<SlideElement, 'x' | 'y' | 'width' | 'height' | 'rotation'>): CSSProperties {
  return {
    left: element.x,
    top: element.y,
    width: element.width,
    height: element.height,
    transform: element.rotation ? `rotate(${element.rotation}deg)` : undefined,
  };
}

/**
 * A slide drawn read-only at a given pixel width: never mounts an editor and
 * ignores the pointer. Thumbnails in the rail use it, and the slideshow
 * (PARA-93) and exports draw slides with it too. Memoised on the slide, so
 * the rail redraws only the slides that changed.
 */
const SlideView = memo(function SlideView({
  slide,
  size,
  theme,
  width,
  className,
}: {
  slide: SlideSnapshot;
  size: SlideSize;
  theme: Theme;
  width: number;
  className?: string;
}) {
  const scale = width / size.width;
  return (
    <div
      className={className}
      style={{
        position: 'relative',
        overflow: 'hidden',
        width,
        height: width / slideAspectRatio(size),
        pointerEvents: 'none',
        ...slideBackgroundStyle(slide, theme),
      }}
    >
      <div className="absolute left-0 top-0 origin-top-left" style={{ width: size.width, height: size.height, transform: `scale(${scale})`, color: resolveSlideColor('theme:dark1', theme) }}>
        {slide.elements.map((element) => {
          const Renderer = slideElementRenderer(element.type);
          return (
            <div key={element.id} className="absolute" style={elementBoxStyle(element)}>
              <Renderer
                element={element}
                theme={theme}
                selected={false}
                editing={false}
                readOnly
                members={NO_MEMBERS}
                onUpdate={noop}
                onStopEditing={noop}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
});

export default SlideView;
