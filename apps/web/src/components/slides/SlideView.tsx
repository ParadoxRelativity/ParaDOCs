import { memo, useMemo, type CSSProperties } from 'react';
import {
  buildPlan,
  fontStack,
  resolveBackground,
  resolveSlideColor,
  slideAspectRatio,
  type SlideBackground,
  type SlideElement,
  type SlideSize,
  type SlideSnapshot,
  type Theme,
  type WorkspaceMember,
} from '@paradocs/shared';
import { assetUrl } from '../../lib/server';
import { slideElementRenderer } from './slideExtensions';
import { BuildBox } from './SlideBuild';
import './slideContent';

const NO_MEMBERS: WorkspaceMember[] = [];
const noop = () => {};

/** A background as CSS: a color, a gradient (linear at an angle, or radial), or a picture over the theme's background color. */
export function backgroundStyle(background: SlideBackground, theme: Theme): CSSProperties {
  const resolved = resolveBackground(background, theme);
  const fallback = resolveSlideColor('theme:background1', theme);
  if (resolved.kind === 'image') {
    return { backgroundColor: fallback, backgroundImage: `url(${assetUrl(resolved.url)})`, backgroundSize: 'cover', backgroundPosition: 'center' };
  }
  if (resolved.kind === 'gradient') {
    const stops = resolved.stops.map((stop) => `${stop.color} ${Math.round(stop.offset * 100)}%`).join(', ');
    return { backgroundColor: fallback, backgroundImage: resolved.radial ? `radial-gradient(circle at center, ${stops})` : `linear-gradient(${resolved.angle}deg, ${stops})` };
  }
  return { background: resolved.color || fallback };
}

/** The page behind a slide's elements: its own background, else its layout's, else the master's. */
export function slideBackgroundStyle(slide: Pick<SlideSnapshot, 'background' | 'frame'>, theme: Theme): CSSProperties {
  const background = slide.background ?? slide.frame?.background;
  return background ? backgroundStyle(background, theme) : { background: resolveSlideColor('theme:background1', theme) };
}

/**
 * What a slide shows besides its own elements: decorations from its master and
 * layout, and the footer, slide number and date when the deck has them on.
 * Drawn under the elements and never selectable.
 */
export function SlideFrameLayer({ slide, theme }: { slide: Pick<SlideSnapshot, 'frame'>; theme: Theme }) {
  const frame = slide.frame;
  if (!frame || (frame.elements.length === 0 && frame.chrome.length === 0)) return null;
  const sorted = [...frame.elements].sort((a, b) => (a.z ?? 0) - (b.z ?? 0));
  return (
    <div className="pointer-events-none absolute inset-0" aria-hidden>
      {sorted.map((element) => {
        const Renderer = slideElementRenderer(element.type);
        return (
          <div key={element.id} className="absolute" style={elementBoxStyle(element)}>
            <Renderer element={element} theme={theme} selected={false} editing={false} readOnly members={NO_MEMBERS} onUpdate={noop} onStopEditing={noop} />
          </div>
        );
      })}
      {frame.chrome.map((item) => (
        <div
          key={item.kind}
          className="absolute"
          style={{
            left: item.x,
            top: item.y,
            width: item.width,
            height: item.height,
            display: 'flex',
            alignItems: item.style.verticalAlign === 'top' ? 'flex-start' : item.style.verticalAlign === 'bottom' ? 'flex-end' : 'center',
            justifyContent: item.style.align === 'right' ? 'flex-end' : item.style.align === 'center' ? 'center' : 'flex-start',
            fontFamily: fontStack(item.style.fontFamily ?? theme.fonts.body),
            fontSize: item.style.fontSize ?? 20,
            fontWeight: item.style.bold ? 700 : 400,
            fontStyle: item.style.italic ? 'italic' : 'normal',
            color: resolveSlideColor(item.style.color ?? 'theme:text2', theme),
            whiteSpace: 'nowrap',
            overflow: 'hidden',
          }}
        >
          {item.text}
        </div>
      ))}
    </div>
  );
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
  const plan = useMemo(() => buildPlan(slide.elements), [slide.elements]);
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
      <div className="absolute left-0 top-0 origin-top-left" style={{ width: size.width, height: size.height, transform: `scale(${scale})`, color: resolveSlideColor('theme:text1', theme) }}>
        <SlideFrameLayer slide={slide} theme={theme} />
        {slide.elements.map((element) => {
          const Renderer = slideElementRenderer(element.type);
          return (
            <BuildBox key={element.id} element={element} plan={plan} style={elementBoxStyle(element)}>
              {(shown) => (
                <Renderer
                  element={shown}
                  theme={theme}
                  selected={false}
                  editing={false}
                  readOnly
                  members={NO_MEMBERS}
                  onUpdate={noop}
                  onStopEditing={noop}
                />
              )}
            </BuildBox>
          );
        })}
      </div>
    </div>
  );
});

export default SlideView;
