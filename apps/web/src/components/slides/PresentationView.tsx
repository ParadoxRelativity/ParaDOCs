import {
  resolveSlideColor,
  slideAspectRatio,
  slideElementText,
  type SlideElement,
  type SlideSnapshot,
  type SlideSize,
  type Theme,
} from '@paradocs/shared';
import { DEFAULT_THEME } from '@paradocs/shared';
import { usePresentationDeck } from '../../api/hooks';
import { EmptyState, Spinner } from '../ui';

/** How wide a thumbnail is drawn, in pixels. A phone fits one a row, a desktop several. */
const THUMBNAIL_WIDTH = 280;

/**
 * The placeholder view of an open presentation: its slides as read-only
 * thumbnails, as the deck was last saved. The slide editor (PARA-89) replaces
 * this with the live stage and slide rail; the record, route and tab around
 * it are already the real ones.
 */
export default function PresentationView({ presentationId }: { presentationId: string }) {
  const deck = usePresentationDeck(presentationId);

  if (deck.isLoading) return <Spinner />;
  if (deck.error || !deck.data) {
    return (
      <EmptyState
        icon="exclamation-triangle"
        title="Could not open that presentation"
        hint={deck.error instanceof Error ? deck.error.message : 'It may have been deleted.'}
      />
    );
  }

  const { slides, settings, themes } = deck.data;
  const theme = themes.find((t) => t.id === settings.themeId) ?? themes[0] ?? DEFAULT_THEME;

  return (
    <div className="scroll-thin h-full overflow-y-auto p-4">
      <p className="mb-4 text-xs text-[var(--color-muted)]">
        The slide editor is coming. Until then a presentation can be created, filed, shared and found, and its slides
        are shown here as they were last saved.
      </p>
      {slides.length === 0 ? (
        <EmptyState icon="easel2" title="No slides yet" hint="This presentation is blank." />
      ) : (
        <ol className="flex flex-wrap gap-4">
          {slides.map((slide, index) => (
            <li key={slide.id} className="shrink-0">
              <div className="mb-1 text-[11px] text-[var(--color-muted)]">{index + 1}</div>
              <SlideThumbnail slide={slide} size={settings.size} theme={theme} />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** One slide drawn small and inert: shapes as boxes, text as text, everything else as a labelled box. */
function SlideThumbnail({ slide, size, theme }: { slide: SlideSnapshot; size: SlideSize; theme: Theme }) {
  const scale = THUMBNAIL_WIDTH / size.width;
  const background =
    slide.background?.kind === 'color'
      ? (resolveSlideColor(slide.background.color, theme) ?? '#ffffff')
      : resolveSlideColor('theme:light1', theme);
  return (
    <div
      className="relative overflow-hidden rounded-md border border-[var(--color-line)]"
      style={{ width: THUMBNAIL_WIDTH, height: THUMBNAIL_WIDTH / slideAspectRatio(size), background }}
      aria-label={`Slide ${slide.id}`}
    >
      <div
        className="absolute left-0 top-0 origin-top-left"
        style={{ width: size.width, height: size.height, transform: `scale(${scale})` }}
      >
        {[...slide.elements]
          .sort((a, b) => a.z - b.z)
          .map((element) => (
            <ThumbnailElement key={element.id} element={element} theme={theme} />
          ))}
      </div>
    </div>
  );
}

function ThumbnailElement({ element, theme }: { element: SlideElement; theme: Theme }) {
  const text = slideElementText(element);
  const fill =
    element.type === 'shape' && element.fill && element.fill !== 'transparent'
      ? resolveSlideColor(element.fill, theme)
      : undefined;
  return (
    <div
      className="absolute overflow-hidden"
      style={{
        left: element.x,
        top: element.y,
        width: element.width,
        height: element.height,
        transform: element.rotation ? `rotate(${element.rotation}deg)` : undefined,
        background: fill,
        color: resolveSlideColor(element.color, theme) ?? resolveSlideColor('theme:dark1', theme),
        fontSize: 48,
        lineHeight: 1.2,
        whiteSpace: 'pre-wrap',
      }}
    >
      {text}
    </div>
  );
}
