import { useState } from 'react';
import {
  currentLayers,
  type PatternConfig,
  type RecurringConfig,
  type RotationConfig,
  type Schedule,
  type ScheduleLayer,
  type ScheduleLayerKind,
} from '@paradocs/shared';
import { useEndLayer, useMembers, useOrderLayers } from '../../api/hooks';
import Icon from '../Icon';
import { ConfirmDialog } from '../Modal';
import { useToast } from '../Toast';
import { Button, EmptyState, IconButton } from '../ui';
import { KIND_FIELDS, LAYER_KINDS, LayerEditor } from './LayerEditor';
import { WEEKDAYS, formatWhen } from './scheduleUi';

const dayNames = (days: number[]) =>
  days.length === 7 ? 'every day' : days.map((d) => WEEKDAYS[d - 1].label.slice(0, 3)).join(', ');

/** One line saying what a layer does. */
function describe(layer: ScheduleLayer): string {
  if (layer.kind === 'rotation') {
    const c = layer.config as RotationConfig;
    const unit = c.length.count === 1 ? c.length.unit.replace(/s$/, '') : `${c.length.count} ${c.length.unit}`;
    const people = `${layer.members.length} ${layer.members.length === 1 ? 'person' : 'people'}`;
    const hours = c.restrictions.length ? `, ${c.restrictions.map((w) => `${dayNames(w.days)} ${w.start}–${w.end}`).join('; ')}` : '';
    return `${people}, handing off every ${unit} at ${c.start.slice(11)}${hours}`;
  }
  if (layer.kind === 'pattern') {
    const c = layer.config as PatternConfig;
    return `${c.crews.length} crews on a ${c.cycle.length}-day cycle of ${c.shiftTypes.map((t) => `${t.name} ${t.start}–${t.end}`).join(', ')}`;
  }
  const c = layer.config as RecurringConfig;
  const people = new Set(c.entries.map((e) => e.userId)).size;
  return `${people} ${people === 1 ? 'person' : 'people'} with regular hours${c.oneOffs.length ? `, ${c.oneOffs.length} one-off shifts` : ''}`;
}

/**
 * A schedule's layers, highest first: the one on top wins where they overlap,
 * and gaps fall through to the ones below.
 */
export default function ScheduleLayers({ schedule }: { schedule: Schedule }) {
  const toast = useToast();
  const people = useMembers(schedule.workspaceId).data ?? [];
  const order = useOrderLayers(schedule.workspaceId, schedule.id);
  const end = useEndLayer(schedule.workspaceId, schedule.id);
  const [editing, setEditing] = useState<{ kind: ScheduleLayerKind; layer: ScheduleLayer | null } | null>(null);
  const [ending, setEnding] = useState<ScheduleLayer | null>(null);
  const [adding, setAdding] = useState(false);
  const now = new Date().toISOString();
  const layers = currentLayers(schedule.layers, now);
  const canEdit = schedule.can.edit;
  const name = (id: string) => people.find((p) => p.userId === id)?.name ?? 'Former member';

  const move = (index: number, to: number) => {
    const ids = layers.map((l) => l.lineageId);
    const [moved] = ids.splice(index, 1);
    ids.splice(to, 0, moved);
    order.mutate(ids, { onError: (err) => toast(err instanceof Error ? err.message : 'Could not reorder', 'error') });
  };

  return (
    <div className="scroll-thin h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-3 px-4 py-5">
        <div className="flex items-start gap-3">
          <p className="min-w-0 flex-1 text-xs text-[var(--color-muted)]">
            Layers higher in the list win where they overlap. Where a layer covers nobody, the one below shows through.
          </p>
          {canEdit && (
            <Button variant="primary" className="shrink-0 text-xs" onClick={() => setAdding(!adding)} aria-expanded={adding}>
              <Icon name="plus-lg" /> Add layer
            </Button>
          )}
        </div>

        {adding && (
          <div className="grid gap-2 sm:grid-cols-3">
            {(Object.keys(LAYER_KINDS) as ScheduleLayerKind[]).filter((kind) => KIND_FIELDS[kind]).map((kind) => (
              <button
                key={kind}
                onClick={() => {
                  setAdding(false);
                  setEditing({ kind, layer: null });
                }}
                className="rounded-lg border border-[var(--color-line)] px-3 py-2 text-left hover:bg-[var(--color-surface)]"
              >
                <span className="flex items-center gap-1.5 text-sm font-medium">
                  <Icon name={LAYER_KINDS[kind].icon} /> {LAYER_KINDS[kind].label}
                </span>
                <span className="mt-0.5 block text-xs text-[var(--color-muted)]">{LAYER_KINDS[kind].hint}</span>
              </button>
            ))}
          </div>
        )}

        {layers.length === 0 && !adding && (
          <EmptyState
            icon="layers"
            title="No layers yet"
            hint={canEdit ? 'Add a rotation, a shift pattern or regular hours to say who is on when.' : 'Nobody has set this schedule up yet.'}
          />
        )}

        <ol className="space-y-2">
          {layers.map((layer, index) => {
            const upcoming = schedule.layers.find((v) => v.lineageId === layer.lineageId && v.effectiveFrom > now && v.id !== layer.id);
            const starts = layer.effectiveFrom > now;
            return (
              <li key={layer.lineageId} className="rounded-lg border border-[var(--color-line)] px-3 py-2">
                <div className="flex items-center gap-2">
                  <Icon name={LAYER_KINDS[layer.kind].icon} className="text-[var(--color-muted)]" />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{layer.name}</span>
                  {canEdit && (
                    <>
                      <IconButton label="Move up" onClick={() => move(index, index - 1)} disabled={index === 0 || order.isPending}>
                        <Icon name="arrow-up" />
                      </IconButton>
                      <IconButton label="Move down" onClick={() => move(index, index + 1)} disabled={index === layers.length - 1 || order.isPending}>
                        <Icon name="arrow-down" />
                      </IconButton>
                      <IconButton label={`Edit ${layer.name}`} onClick={() => setEditing({ kind: layer.kind, layer })}>
                        <Icon name="pencil" />
                      </IconButton>
                      <IconButton label={`End ${layer.name}`} onClick={() => setEnding(layer)}>
                        <Icon name="stop-circle" />
                      </IconButton>
                    </>
                  )}
                </div>
                <p className="mt-0.5 text-xs text-[var(--color-muted)]">{describe(layer)}</p>
                {layer.kind !== 'recurring' && layer.members.length > 0 && (
                  <p className="mt-1 truncate text-xs">{layer.members.map((m) => name(m.userId)).join(' → ')}</p>
                )}
                {(starts || upcoming) && (
                  <p className="mt-1 text-[11px] text-[var(--color-accent)]">
                    <Icon name="clock-history" /> {starts ? `Starts ${formatWhen(layer.effectiveFrom)}` : `Changes from ${formatWhen(upcoming!.effectiveFrom)}`}
                  </p>
                )}
              </li>
            );
          })}
        </ol>
      </div>

      {editing && <LayerEditor schedule={schedule} kind={editing.kind} layer={editing.layer} onClose={() => setEditing(null)} />}
      {ending && (
        <ConfirmDialog
          title={`End ${ending.name}?`}
          description="It stops putting anyone on from now. Shifts it gave before now stay on the schedule."
          confirmLabel="End layer"
          onCancel={() => setEnding(null)}
          onConfirm={() => {
            const lineageId = ending.lineageId;
            setEnding(null);
            end.mutate(lineageId, { onError: (err) => toast(err instanceof Error ? err.message : 'Could not end the layer', 'error') });
          }}
        />
      )}
    </div>
  );
}
