import { useState } from 'react';
import { useCalendarFeed, useDeleteCalendarFeed, useResetCalendarFeed } from '../../api/hooks';
import { cx } from '../../lib/util';
import Icon from '../Icon';
import { Modal } from '../Modal';
import { FIELD } from '../SettingsParts';
import { useToast } from '../Toast';
import { Button } from '../ui';
import { formatWhen } from './scheduleUi';

/**
 * A calendar feed: an address a phone or desktop calendar subscribes to. It
 * is shown once, when made or reset; resetting it stops the old one working.
 */
export function CalendarFeedDialog({
  workspaceId,
  scheduleId,
  title,
  onClose,
}: {
  workspaceId: string;
  /** A whole schedule's feed; your own shifts when left out. */
  scheduleId?: string;
  title: string;
  onClose: () => void;
}) {
  const toast = useToast();
  const status = useCalendarFeed(workspaceId, scheduleId);
  const reset = useResetCalendarFeed(workspaceId, scheduleId);
  const remove = useDeleteCalendarFeed(workspaceId, scheduleId);
  const [url, setUrl] = useState<string | null>(null);
  const exists = Boolean(status.data?.hint);

  const make = () =>
    reset.mutate(undefined, {
      onSuccess: (made) => setUrl(made.url ?? null),
      onError: (err) => toast(err instanceof Error ? err.message : 'Could not make the feed', 'error'),
    });

  return (
    <Modal
      title={title}
      description="Subscribe to this address in your phone or desktop calendar. It shows shifts from a month ago to six months ahead, and keeps up as they change."
      onClose={onClose}
      footer={
        <Button variant="subtle" className="text-xs" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="space-y-3 text-sm">
        {url ? (
          <>
            <div className="flex gap-1.5">
              <input readOnly value={url} onFocus={(e) => e.target.select()} className={cx(FIELD, 'font-mono text-xs')} aria-label="Feed address" />
              <Button
                variant="primary"
                className="shrink-0 text-xs"
                onClick={() => void navigator.clipboard?.writeText(url).then(() => toast('Copied'))}
              >
                <Icon name="clipboard" /> Copy
              </Button>
            </div>
            <p className="text-xs text-amber-700 dark:text-amber-300">
              <Icon name="exclamation-triangle" /> Copy it now: it will not be shown again. Anyone with it can see these shifts.
            </p>
          </>
        ) : exists ? (
          <p className="text-xs text-[var(--color-muted)]">
            A feed ending in …{status.data?.hint} was made {status.data?.createdAt ? formatWhen(status.data.createdAt) : ''}. Its address is
            only shown when it is made. Reset it to get a new one; the old address stops working.
          </p>
        ) : (
          <p className="text-xs text-[var(--color-muted)]">There is no feed yet.</p>
        )}
        <div className="flex gap-2">
          <Button variant={exists || url ? 'subtle' : 'primary'} className="text-xs" disabled={reset.isPending || status.isLoading} onClick={make}>
            <Icon name="link-45deg" /> {exists || url ? 'Reset address' : 'Make an address'}
          </Button>
          {(exists || url) && (
            <Button
              variant="danger"
              className="text-xs"
              disabled={remove.isPending}
              onClick={() =>
                remove.mutate(undefined, {
                  onSuccess: () => {
                    setUrl(null);
                    toast('Feed turned off');
                  },
                })
              }
            >
              Turn off
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
