import { useMemo } from 'react';
import {
  connectorPath,
  dashArray,
  resolveEndpoints,
  routeHandle,
  type CanvasElement,
  type ConnectorElement,
} from '@paradocs/shared';

interface Props {
  connectors: ConnectorElement[];
  byId: Map<string, CanvasElement>;
  selectedIds: Set<string>;
  onSelect: (id: string, additive: boolean) => void;
  /** Live line drawn while dragging a new connection out of a port. */
  preview?: { path: string } | null;
  /**
   * Parent/child links of mind-map nodes. These are derived from the tree
   * rather than stored, so they are drawn here but are not selectable elements.
   */
  mindEdges: { from: CanvasElement; to: CanvasElement; color: string }[];
  /** Scale-corrected handle size, so handles stay a constant screen size. */
  scale: number;
  editable: boolean;
  onRouteHandleDown: (
    e: React.PointerEvent,
    connector: ConnectorElement,
    axis: 'x' | 'y' | 'free',
  ) => void;
}

/**
 * The transformed canvas container has no intrinsic size, so a percentage-sized
 * SVG collapses to 0x0 and paints nothing. This gives the layer an explicit,
 * generously large viewport centred on the canvas origin, and shifts the
 * contents back so lines can still be drawn in plain canvas coordinates.
 */
const SPAN = 50_000;

function markerId(color: string) {
  return `pd-arrow-${color.replace(/[^a-z0-9]/gi, '')}`;
}

export default function Connectors({
  connectors,
  byId,
  selectedIds,
  onSelect,
  preview,
  mindEdges,
  scale,
  editable,
  onRouteHandleDown,
}: Props) {
  // A marker cannot inherit the line's stroke reliably across browsers, so one
  // is defined per colour actually in use.
  const colors = useMemo(() => {
    const set = new Set<string>(['var(--color-accent)']);
    for (const c of connectors) set.add(c.color ?? 'var(--color-muted)');
    return [...set];
  }, [connectors]);

  return (
    <svg
      className="pointer-events-none absolute overflow-visible"
      style={{ left: -SPAN / 2, top: -SPAN / 2, width: SPAN, height: SPAN }}
    >
      <defs>
        {colors.map((color) => (
          <marker
            key={color}
            id={markerId(color)}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill={color} />
          </marker>
        ))}
      </defs>

      <g transform={`translate(${SPAN / 2}, ${SPAN / 2})`}>
        {mindEdges.map(({ from, to, color }) => {
          // Leave the parent's right face and enter the child's left face, with
          // horizontal handles, which reads as a branch rather than a wire.
          const start = { x: from.x + from.width, y: from.y + from.height / 2 };
          const end = { x: to.x, y: to.y + to.height / 2 };
          const pull = Math.max(30, (end.x - start.x) / 2);
          return (
            <path
              key={`${from.id}-${to.id}`}
              d={`M ${start.x} ${start.y} C ${start.x + pull} ${start.y}, ${end.x - pull} ${end.y}, ${end.x} ${end.y}`}
              fill="none"
              stroke={color}
              strokeWidth={2}
              strokeLinecap="round"
              opacity={0.75}
            />
          );
        })}

        {connectors.map((connector) => {
          const from = byId.get(connector.from);
          const to = byId.get(connector.to);
          if (!from || !to) return null;

          const { s1, s2, p1, p2 } = resolveEndpoints(
            from,
            to,
            connector.fromSide ?? 'auto',
            connector.toSide ?? 'auto',
          );
          const shape = connector.shape ?? 'straight';
          const route = { midX: connector.midX, midY: connector.midY, bend: connector.bend };
          const path = connectorPath(p1, s1, p2, s2, shape, route);
          const handle = routeHandle(p1, s1, p2, s2, shape, route);
          const selected = selectedIds.has(connector.id);
          const color = selected ? 'var(--color-accent)' : (connector.color ?? 'var(--color-muted)');
          const width = selected ? 3 : 2;
          // `arrow` predates the start/end pair; treat it as an end arrow.
          const arrowEnd = connector.arrowEnd ?? connector.arrow ?? true;
          const arrowStart = connector.arrowStart ?? false;

          return (
            <g key={connector.id}>
              {/* A wide invisible stroke makes a 2px line practical to click. */}
              <path
                d={path}
                data-connector-hit={connector.id}
                fill="none"
                stroke="transparent"
                strokeWidth={14}
                className="pointer-events-auto cursor-pointer"
                onPointerDown={(e) => {
                  e.stopPropagation();
                  onSelect(connector.id, e.shiftKey);
                }}
              />
              <path
                d={path}
                data-connector-line={connector.id}
                fill="none"
                stroke={color}
                strokeWidth={width}
                strokeLinecap={connector.dash === 'dotted' ? 'round' : 'butt'}
                strokeDasharray={dashArray(connector.dash ?? 'solid', width)}
                markerStart={arrowStart ? `url(#${markerId(color)})` : undefined}
                markerEnd={arrowEnd ? `url(#${markerId(color)})` : undefined}
              />
              {selected && editable && handle && (
                <circle
                  data-connector-handle={connector.id}
                  cx={handle.point.x}
                  cy={handle.point.y}
                  r={6 / scale}
                  fill="var(--color-accent)"
                  stroke="white"
                  strokeWidth={2 / scale}
                  className="pointer-events-auto"
                  style={{
                    cursor: handle.axis === 'x' ? 'ew-resize' : handle.axis === 'y' ? 'ns-resize' : 'move',
                  }}
                  onPointerDown={(e) => onRouteHandleDown(e, connector, handle.axis)}
                >
                  <title>Drag to reshape this connector</title>
                </circle>
              )}

              {connector.label && (
                <text
                  x={(p1.x + p2.x) / 2}
                  y={(p1.y + p2.y) / 2 - 6}
                  textAnchor="middle"
                  className="fill-[var(--color-muted)] text-[11px]"
                >
                  {connector.label}
                </text>
              )}
            </g>
          );
        })}

        {preview && (
          <path
            d={preview.path}
            fill="none"
            stroke="var(--color-accent)"
            strokeWidth={2}
            strokeDasharray="6 4"
            markerEnd={`url(#${markerId('var(--color-accent)')})`}
          />
        )}
      </g>
    </svg>
  );
}
