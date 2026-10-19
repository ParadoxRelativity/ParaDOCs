import { useEffect, useRef, useState } from 'react';
import { canFrom } from '../../lib/permissions';
import { presentationRef } from '@paradocs/shared';
import { api } from '../../api/client';
import { useChannels, useMe, useWorkspaces } from '../../api/hooks';
import { useBackHandler } from '../../lib/back';
import { useLivePresenter } from '../../lib/liveShow';
import { cx } from '../../lib/util';
import Icon from '../Icon';
import { useToast } from '../Toast';
import { registerSlideShowAddon, type SlideShowAddonContext } from './slideShowExtensions';

/**
 * "Present to workspace" (PARA-99): inside the running slideshow, a control
 * that makes it live. People with `slides.present` choose where to announce it
 * (a text channel gets a message linking the deck; a voice channel gets a
 * banner on its call) and the show's position is then sent to everyone
 * following. Exiting the show ends the session.
 */

registerSlideShowAddon({
  id: 'live',
  order: 50,
  render: (ctx) => <LivePresenterControl ctx={ctx} />,
});

function LivePresenterControl({ ctx }: { ctx: SlideShowAddonContext }) {
  const { controller, presentationId, workspaceId } = ctx;
  const workspaces = useWorkspaces();
  const channels = useChannels(workspaceId);
  const me = useMe();
  const toast = useToast();
  const presenter = useLivePresenter(presentationId, controller.state);
  const [open, setOpen] = useState(false);
  const [channelId, setChannelId] = useState<string | null>(null);
  const announced = useRef(false);

  const allowed = canFrom(workspaces.data?.find((w) => w.id === workspaceId)?.permissions)('slides.present');
  useBackHandler(() => setOpen(false), { active: open });

  // A text channel is told once the show is really running; a voice channel carries no messages and shows a banner instead.
  const announceIn = presenter.channelId ? channels.data?.find((c) => c.id === presenter.channelId) : undefined;
  useEffect(() => {
    if (presenter.status === 'off') announced.current = false;
    if (presenter.status !== 'live' || announced.current || announceIn?.kind !== 'text') return;
    announced.current = true;
    const name = me.data?.user?.name ?? 'Someone';
    api
      .post(`/channels/${announceIn.id}/messages`, {
        body: `${name} is presenting ${presentationRef(presentationId)} live. Open it to follow along.`,
      })
      .catch(() => toast('The show is live, but the channel could not be told', 'error'));
  }, [presenter.status, announceIn, presentationId, me.data, toast]);

  useEffect(() => {
    if (presenter.error) toast(presenter.error, 'error');
  }, [presenter.error, toast]);

  if (!allowed) return null;
  const live = presenter.status === 'live';
  const postable = (channels.data ?? []).filter((c) => c.kind === 'text' || c.kind === 'voice');

  return (
    <div
      // Taps here are not taps on the slide.
      onPointerDown={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
      className="absolute left-3 top-3 z-20 text-xs"
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cx(
          'flex h-10 items-center gap-1.5 rounded-full px-3 opacity-70 transition-opacity hover:opacity-100 focus-visible:opacity-100',
          live ? 'bg-red-600 opacity-100' : 'bg-white/15',
        )}
      >
        <Icon name="broadcast" />
        {live ? `Live · ${presenter.viewers} following` : 'Present live'}
      </button>

      {open && (
        <div role="dialog" aria-label="Present to workspace" className="mt-2 w-72 max-w-[calc(100vw-1.5rem)] rounded-lg bg-neutral-900 p-3 shadow-xl ring-1 ring-white/15">
          {live ? (
            <>
              <p>
                Everyone in the workspace who can open this presentation can follow along. Exiting the show ends it.
              </p>
              <button type="button" onClick={presenter.stop} className="mt-3 w-full rounded-md bg-red-600 py-2 font-medium">
                Stop presenting live
              </button>
            </>
          ) : (
            <>
              <p className="font-medium">Present to workspace</p>
              <p className="mt-1 opacity-70">Members follow your slides on their own screens. Announce it in a channel so they can join.</p>
              <ul className="mt-2 max-h-40 overflow-y-auto" aria-label="Announce in">
                {[{ id: null, name: 'Do not announce', kind: 'none' as const }, ...postable].map((c) => (
                  <li key={c.id ?? 'none'}>
                    <button
                      type="button"
                      aria-pressed={channelId === c.id}
                      onClick={() => setChannelId(c.id)}
                      className={cx('flex w-full items-center gap-2 rounded-md px-2 py-2 text-left', channelId === c.id ? 'bg-white/20' : 'hover:bg-white/10')}
                    >
                      {c.kind === 'none' ? null : <Icon name={c.kind === 'voice' ? 'volume-up' : 'hash'} />}
                      <span className="min-w-0 flex-1 truncate">{c.name}</span>
                      {channelId === c.id && <Icon name="check-lg" />}
                    </button>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                disabled={presenter.status === 'starting'}
                onClick={() => {
                  presenter.start(channelId);
                  setOpen(false);
                }}
                className="mt-3 w-full rounded-md bg-[var(--color-accent)] py-2 font-medium text-white disabled:opacity-50"
              >
                Start presenting live
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
