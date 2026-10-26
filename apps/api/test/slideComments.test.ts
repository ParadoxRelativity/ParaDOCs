import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApi, type Api, type TestUser } from './harness.js';

/** Comments on slides: threads, permissions, mentions that open the deck on the slide, and search. */
describe('slide comments', () => {
  let api: Api;
  let owner: TestUser;
  let editor: TestUser;
  let viewer: TestUser;
  let outsider: TestUser;
  let ws: string;
  let deck: string;

  const post = (user: TestUser, body: Record<string, unknown>, id = deck) =>
    api.call(user, 'POST', `/presentations/${id}/comments`, { slideId: 's1', ...body });
  const mentions = async (user: TestUser) =>
    ((await api.call(user, 'GET', '/notifications')).body.slideMentions ?? []) as { presentationId: string; slideId: string; title: string }[];

  beforeAll(async () => {
    api = await startApi();
    owner = await api.register('Owner');
    editor = await api.register('Editor');
    viewer = await api.register('Viewer');
    outsider = await api.register('Outsider');
    ws = owner.workspaceId;
    await api.join(editor, ws, 'Editor');
    await api.join(viewer, ws, 'Viewer');
    deck = (await api.call(owner, 'POST', `/workspaces/${ws}/presentations`, { title: 'Roadmap' })).body.id;
  });

  afterAll(async () => {
    await api.close();
  });

  it('threads comments on a slide, keeping replies with their parent', async () => {
    const root = await post(editor, { body: 'Tighten this title', elementId: 'e1' });
    expect(root.status).toBe(201);
    expect(root.body).toMatchObject({ slideId: 's1', elementId: 'e1', resolved: false, parentId: null });
    // A reply follows its thread, whatever slide the request names.
    const reply = await post(owner, { body: 'Done', parentId: root.body.id, slideId: 'other', elementId: null });
    expect(reply.body).toMatchObject({ slideId: 's1', elementId: 'e1', parentId: root.body.id });

    const read = await api.call(viewer, 'GET', `/presentations/${deck}/comments`);
    expect(read.status).toBe(200);
    const thread = read.body.comments.find((c: { id: string }) => c.id === root.body.id);
    expect(thread.replies.map((r: { body: string }) => r.body)).toEqual(['Done']);
  });

  it('lets viewers comment and resolve, but only authors edit or delete', async () => {
    const made = await post(viewer, { body: 'Looks good' });
    expect(made.status).toBe(201);
    expect((await api.call(owner, 'PATCH', `/slide-comments/${made.body.id}`, { resolved: true })).body.resolved).toBe(true);
    expect((await api.call(owner, 'PATCH', `/slide-comments/${made.body.id}`, { body: 'Mine now' })).status).toBe(403);
    expect((await api.call(viewer, 'PATCH', `/slide-comments/${made.body.id}`, { body: 'Looks great' })).body.body).toBe('Looks great');
    expect((await api.call(owner, 'DELETE', `/slide-comments/${made.body.id}`)).status).toBe(403);
    expect((await api.call(viewer, 'DELETE', `/slide-comments/${made.body.id}`)).status).toBe(204);
  });

  it('keeps people without access out', async () => {
    expect((await api.call(outsider, 'GET', `/presentations/${deck}/comments`)).status).toBe(404);
    expect((await post(outsider, { body: 'hi' })).status).toBe(404);
  });

  it('refuses a role without the comment permission', async () => {
    await api.sql(
      `UPDATE workspace_roles SET permissions = array_remove(permissions, 'slides.comment')
        WHERE workspace_id = $1 AND name = 'Viewer'`,
      [ws],
    );
    expect((await post(viewer, { body: 'nope' })).status).toBe(403);
    expect((await api.call(viewer, 'GET', `/presentations/${deck}/comments`)).status).toBe(200);
    await api.sql(
      `UPDATE workspace_roles SET permissions = permissions || ARRAY['slides.comment'] WHERE workspace_id = $1 AND name = 'Viewer'`,
      [ws],
    );
  });

  it('keeps a comment after its slide is gone', async () => {
    // Slides are not rows, so nothing the deck does can remove a comment.
    const made = await post(editor, { body: 'About a slide that will go', slideId: 'gone' });
    const read = await api.call(owner, 'GET', `/presentations/${deck}/comments`);
    expect(read.body.comments.some((c: { id: string; slideId: string }) => c.id === made.body.id && c.slideId === 'gone')).toBe(true);
  });

  it('tells a mentioned member, opening the deck on the slide, and nobody else', async () => {
    const note = await post(editor, { body: `Over to you <@${viewer.id}> and <@${editor.id}> and <@${outsider.id}>`, slideId: 's7' });
    expect(note.status).toBe(201);

    const told = await mentions(viewer);
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ presentationId: deck, slideId: 's7', title: 'Roadmap' });
    // Not the author, and not someone who cannot open the deck.
    expect(await mentions(editor)).toHaveLength(0);
    expect(await mentions(outsider)).toHaveLength(0);

    await api.call(viewer, 'POST', '/notifications/slide-mentions/read', { presentationIds: [deck] });
    expect(await mentions(viewer)).toHaveLength(0);
  });

  it('collapses several comments on one slide into one notification', async () => {
    await post(editor, { body: `First <@${viewer.id}>`, slideId: 's9' });
    await post(owner, { body: `Second <@${viewer.id}>`, slideId: 's9' });
    expect((await mentions(viewer)).filter((m) => m.slideId === 's9')).toHaveLength(1);
  });

  it('finds a deck by what is said about it, for people who can open it', async () => {
    await post(editor, { body: 'Needs a narwhalian rewrite' });
    const found = await api.call(viewer, 'GET', `/workspaces/${ws}/search?q=narwhalian`);
    expect(found.body.presentations.map((p: { id: string }) => p.id)).toContain(deck);
    // Locked away, the deck and what was said about it stay out of results.
    await api.sql(`UPDATE presentations SET access = 'allow' WHERE id = $1`, [deck]);
    const hidden = await api.call(viewer, 'GET', `/workspaces/${ws}/search?q=narwhalian`);
    expect(hidden.body.presentations.map((p: { id: string }) => p.id)).not.toContain(deck);
    await api.sql(`UPDATE presentations SET access = 'inherit' WHERE id = $1`, [deck]);
  });

  it('removes comments with their presentation', async () => {
    const other = (await api.call(owner, 'POST', `/workspaces/${ws}/presentations`, { title: 'Scratch' })).body.id;
    await post(owner, { body: 'temp' }, other);
    await api.call(owner, 'DELETE', `/presentations/${other}`);
    expect(await api.sql('SELECT 1 FROM slide_comments WHERE presentation_id = $1', [other])).toHaveLength(0);
  });
});
