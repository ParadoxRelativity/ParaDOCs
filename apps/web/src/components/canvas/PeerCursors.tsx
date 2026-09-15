import type { CollabSession } from '../../lib/collaboration';
import { usePeerPointers } from '../../lib/canvasPresence';
import type { Viewport } from './CanvasSurface';

/**
 * Collaborators' pointers, drawn over the board at screen size whatever the
 * zoom. The layer follows this person's own panning instantly; only each
 * cursor's own motion is eased, which smooths over the gaps between updates.
 */
export default function PeerCursors({ session, viewport }: { session: CollabSession; viewport: Viewport }) {
  const pointers = usePeerPointers(session);
  const visible = pointers.filter((pointer) => pointer.active);
  if (visible.length === 0) return null;

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
      <div className="absolute left-0 top-0" style={{ transform: `translate(${viewport.x}px, ${viewport.y}px)` }}>
        {visible.map((pointer) => (
          <div
            key={pointer.clientId}
            className="absolute left-0 top-0"
            style={{
              transform: `translate(${pointer.x * viewport.scale}px, ${pointer.y * viewport.scale}px)`,
              transition: 'transform 80ms linear',
            }}
          >
            <svg width="18" height="18" viewBox="0 0 18 18" className="drop-shadow">
              <path d="M2 1.5 L2 15 L6 11.2 L8.6 16.5 L11 15.4 L8.5 10.2 L14 10.2 Z" fill={pointer.color} stroke="white" strokeWidth="1.2" strokeLinejoin="round" />
            </svg>
            <span
              className="absolute left-3.5 top-4 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11px] font-medium text-white shadow"
              style={{ background: pointer.color }}
            >
              {pointer.name}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
