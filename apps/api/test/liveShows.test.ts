import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatEvent } from '@paradocs/shared';
import { subscribeToWorkspace } from '../src/chat/hub.js';
import type * as Shows from '../src/lib/liveShows.js';
import { startApi, type Api, type TestUser } from './harness.js';

/** Live slideshows: who may present, who may follow, and that only the presenter moves the show. */
describe('live shows', () => {
  // Loaded after the harness has pointed the database at PGlite.
  let shows: typeof Shows;
  let startShow: typeof Shows.startShow, updateShow: typeof Shows.updateShow, endShow: typeof Shows.endShow;
  let joinShow: typeof Shows.joinShow, leaveShow: typeof Shows.leaveShow, releaseOwner: typeof Shows.releaseOwner;
  let recheckOwner: typeof Shows.recheckOwner, showState: typeof Shows.showState;
  let MIN_PUBLISH_GAP_MS: number, MAX_FOLLOWERS: number;
  let api: Api;
  let owner: TestUser;
  let editor: TestUser;
  let viewer: TestUser;
  let outsider: TestUser;
  let ws: string;
  let deck: string;

  /** A socket's worth of state: a token, and everything it has been sent. */
  const socket = () => {
    const events: ChatEvent[] = [];
    return { token: Symbol('socket'), events, reply: (e: ChatEvent) => void events.push(e) };
  };
  const last = (s: { events: ChatEvent[] }, type: string) => [...s.events].reverse().find((e) => e.type === type) as any;
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const state = (slideId: string, step = 0) => ({ slideId, step, blank: null, jump: '' });
  const lock = (open: boolean) =>
    api.call(owner, 'PUT', `/presentations/${deck}/access`, open ? { access: 'open' } : { access: 'allow', entries: [{ userId: editor.id, permission: 'edit' }] });

  beforeAll(async () => {
    api = await startApi();
    shows = await import('../src/lib/liveShows.js');
    ({ startShow, updateShow, endShow, joinShow, leaveShow, releaseOwner, recheckOwner, showState, MIN_PUBLISH_GAP_MS, MAX_FOLLOWERS } = shows);
    owner = await api.register('Owner');
    editor = await api.register('Editor');
    viewer = await api.register('Viewer');
    outsider = await api.register('Outsider');
    ws = owner.workspaceId;
    await api.join(editor, ws, 'Editor');
    await api.join(viewer, ws, 'Viewer');
    deck = (await api.call(owner, 'POST', `/workspaces/${ws}/presentations`, { title: 'Town hall' })).body.id;
  });

  afterAll(async () => {
    await api.close();
  });

  it('starts for someone with slides.present, and refuses a viewer', async () => {
    const refused = socket();
    await startShow(viewer, refused.token, deck, null, refused.reply);
    expect(last(refused, 'show.refused')).toMatchObject({ reason: 'forbidden' });

    const presenter = socket();
    await startShow(editor, presenter.token, deck, null, presenter.reply);
    expect(last(presenter, 'show.started').show).toMatchObject({ title: 'Town hall', presenter: { id: editor.id }, viewers: 0 });
    expect((await api.call(viewer, 'GET', `/workspaces/${ws}/live-shows`)).body).toHaveLength(1);
    releaseOwner(presenter.token);
    expect((await api.call(viewer, 'GET', `/workspaces/${ws}/live-shows`)).body).toHaveLength(0);
  });

  it('tells the workspace, ids only, when a show starts and ends', async () => {
    const heard: ChatEvent[] = [];
    const stop = subscribeToWorkspace(ws, (e) => heard.push(e));
    const presenter = socket();
    await startShow(editor, presenter.token, deck, null, presenter.reply);
    endShow(presenter.token, deck);
    stop();
    expect(heard).toEqual([
      { type: 'shows.changed', workspaceId: ws, presentationId: deck },
      { type: 'shows.changed', workspaceId: ws, presentationId: deck },
    ]);
  });

  it('lets followers in with the current position, and ignores their attempts to move it', async () => {
    const presenter = socket();
    const follower = socket();
    await startShow(editor, presenter.token, deck, null, presenter.reply);
    updateShow(presenter.token, deck, state('s1', 2));
    await joinShow(viewer, follower.token, deck, follower.reply);
    expect(last(follower, 'show.joined')).toMatchObject({ state: { slideId: 's1', step: 2 }, show: { viewers: 1 } });
    expect(last(presenter, 'show.viewers').viewers).toBe(1);

    updateShow(follower.token, deck, state('hijack'));
    expect(showState(deck)?.slideId).toBe('s1');
    endShow(follower.token, deck);
    expect(showState(deck)).not.toBeNull();

    await wait(MIN_PUBLISH_GAP_MS + 10);
    updateShow(presenter.token, deck, state('s2'));
    expect(last(follower, 'show.state').state.slideId).toBe('s2');
    releaseOwner(presenter.token);
    expect(last(follower, 'show.ended')).toBeTruthy();
    releaseOwner(follower.token);
  });

  it('refuses followers without access to the deck, and when nothing is live', async () => {
    const presenter = socket();
    const stranger = socket();
    await joinShow(viewer, stranger.token, deck, stranger.reply);
    expect(last(stranger, 'show.refused')).toMatchObject({ reason: 'not-live' });

    await startShow(editor, presenter.token, deck, null, presenter.reply);
    await joinShow(outsider, stranger.token, deck, stranger.reply);
    expect(last(stranger, 'show.refused')).toMatchObject({ reason: 'forbidden' });

    // A lock that takes the deck from a viewer refuses them at the door.
    expect((await lock(false)).status).toBe(200);
    await joinShow(viewer, stranger.token, deck, stranger.reply);
    expect(last(stranger, 'show.refused')).toMatchObject({ reason: 'forbidden' });
    await lock(true);
    releaseOwner(presenter.token);
  });

  it('merges a burst of moves into a trailing update that lands on the final position', async () => {
    const presenter = socket();
    const follower = socket();
    await startShow(editor, presenter.token, deck, null, presenter.reply);
    await joinShow(viewer, follower.token, deck, follower.reply);
    await wait(MIN_PUBLISH_GAP_MS + 10);
    for (let i = 1; i <= 20; i++) updateShow(presenter.token, deck, state(`s${i}`));
    await wait(MIN_PUBLISH_GAP_MS * 3);
    const states = follower.events.filter((e) => e.type === 'show.state') as any[];
    expect(states.length).toBeLessThan(20);
    expect(states[states.length - 1].state.slideId).toBe('s20');
    expect(states.map((s) => s.seq)).toEqual([...states.map((s) => s.seq)].sort((a, b) => a - b));
    releaseOwner(presenter.token);
    releaseOwner(follower.token);
  });

  it('serves twenty followers the same position', async () => {
    const presenter = socket();
    const followers = Array.from({ length: 20 }, socket);
    await startShow(editor, presenter.token, deck, null, presenter.reply);
    await Promise.all(followers.map((f) => joinShow(viewer, f.token, deck, f.reply)));
    expect(last(presenter, 'show.viewers').viewers).toBe(20);
    await wait(MIN_PUBLISH_GAP_MS + 10);
    updateShow(presenter.token, deck, state('s9', 1));
    for (const f of followers) expect(last(f, 'show.state').state).toMatchObject({ slideId: 's9', step: 1 });
    leaveShow(followers[0].token, deck);
    expect(last(presenter, 'show.viewers').viewers).toBe(19);
    releaseOwner(presenter.token);
    followers.forEach((f) => releaseOwner(f.token));
    expect(MAX_FOLLOWERS).toBeGreaterThanOrEqual(20);
  });

  it('refuses a second presenter, lets the first take over from another window, and drops junk positions', async () => {
    const first = socket();
    const second = socket();
    const other = socket();
    await startShow(editor, first.token, deck, null, first.reply);
    await startShow(owner, other.token, deck, null, other.reply);
    expect(last(other, 'show.refused')).toMatchObject({ reason: 'busy' });

    await startShow(editor, second.token, deck, null, second.reply);
    expect(last(first, 'show.ended')).toBeTruthy();
    expect(last(second, 'show.started')).toBeTruthy();

    await wait(MIN_PUBLISH_GAP_MS + 10);
    updateShow(second.token, deck, state('keep'));
    for (const junk of [null, 'x', { slideId: 3, step: 0, blank: null }, { slideId: 'a', step: -1, blank: null }, { slideId: 'a', step: 1.5, blank: null }, { slideId: 'a', step: 0, blank: 'red' }]) {
      updateShow(second.token, deck, junk);
    }
    expect(showState(deck)?.slideId).toBe('keep');
    releaseOwner(second.token);
  });

  it('only announces in a channel the presenter can post in, in the same workspace', async () => {
    const [{ id: channelId }] = await api.sql<{ id: string }>(`SELECT id FROM channels WHERE workspace_id = $1 LIMIT 1`, [ws]);
    const good = socket();
    await startShow(editor, good.token, deck, channelId, good.reply);
    expect(last(good, 'show.started').show.channelId).toBe(channelId);
    releaseOwner(good.token);

    const [{ id: elsewhere }] = await api.sql<{ id: string }>(`SELECT id FROM channels WHERE workspace_id = $1 LIMIT 1`, [outsider.workspaceId]);
    const bad = socket();
    await startShow(editor, bad.token, deck, elsewhere, bad.reply);
    expect(last(bad, 'show.refused')).toMatchObject({ reason: 'forbidden' });
  });

  it('drops a follower whose access is taken away, and stops a presenter who loses the permission', async () => {
    const presenter = socket();
    const follower = socket();
    await startShow(editor, presenter.token, deck, null, presenter.reply);
    await joinShow(viewer, follower.token, deck, follower.reply);
    await lock(false);
    await recheckOwner(viewer, follower.token);
    expect(last(presenter, 'show.viewers').viewers).toBe(0);
    await lock(true);

    await api.sql(
      `UPDATE workspace_members SET role_id = (SELECT id FROM workspace_roles WHERE workspace_id = $1 AND name = 'Viewer') WHERE workspace_id = $1 AND user_id = $2`,
      [ws, editor.id],
    );
    await recheckOwner(editor, presenter.token);
    expect(last(presenter, 'show.ended')).toBeTruthy();
    expect(showState(deck)).toBeNull();
  });
});
