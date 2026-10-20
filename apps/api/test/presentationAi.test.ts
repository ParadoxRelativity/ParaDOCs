import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { collectReferences, parseMessage, presentationRef, readDeck, readSlideOrder } from '@paradocs/shared';
import { startApi, type Api, type TestUser } from './harness.js';

const OUTLINE = `# Quarterly review
Everything we shipped
Notes: Welcome everyone, start with the glacier story.

# Revenue
- Up 12% on the quarter
- Enterprise leads
  - Three new logos
Notes: Mention the narwhal pilot only if asked.

# Customers
- Churn fell
- NPS rose

# Roadmap
- Slides app
- Search everywhere

# Thanks
Notes: Questions go to the channel.`;

/**
 * Presentations in search, links and the AI tools. The tools are run as the
 * MCP server runs them: through the app's own routes, as the connected person.
 */
describe('presentations for AI, search and links', () => {
  let api: Api;
  let owner: TestUser;
  let viewer: TestUser;
  let stranger: TestUser;
  let deckId: string;
  let run: (user: TestUser, name: string, args: object) => Promise<string>;

  beforeAll(async () => {
    api = await startApi();
    const { runTool } = await import('../src/mcp/tools.js');
    run = (user, name, args) =>
      runTool(
        {
          app: api.app,
          authorization: `Bearer ${user.token}`,
          userId: user.id,
          ai: { connectionId: 'test', workspaceId: null, canWrite: true },
          origin: 'https://docs.example.com',
        },
        name,
        args,
      );
    owner = await api.register('Owner');
    viewer = await api.register('Viewer');
    stranger = await api.register('Stan');
    await api.join(viewer, owner.workspaceId, 'Viewer');
    await api.join(stranger, owner.workspaceId, 'Editor');
  });

  afterAll(async () => {
    await api.close();
  });

  async function savedDeck(id: string) {
    const [row] = await api.sql<{ ydoc: Buffer }>('SELECT ydoc FROM presentations WHERE id = $1', [id]);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, new Uint8Array(row.ydoc));
    return { doc, deck: readDeck(doc) };
  }

  it('creates a deck from a five point outline, laid out from the layouts', async () => {
    const made = await run(owner, 'create_presentation', { title: 'Q3 review', outline: OUTLINE });
    expect(made).toContain('with 5 slides');
    deckId = /id ([0-9a-f-]{36})/.exec(made)![1];
    expect(made).toContain(`/w/${owner.workspaceId}/sl/${deckId}`);

    const { deck } = await savedDeck(deckId);
    expect(deck.slides).toHaveLength(5);
    expect(deck.slides.map((s) => s.layoutId)).toEqual(['title', 'titleAndContent', 'titleAndContent', 'titleAndContent', 'title']);
    const [title, revenue, , , thanks] = deck.slides;
    // A title slide's lone plain line is its subtitle, in the layout's own box.
    expect(title.elements.map((e) => (e.type === 'richText' ? e.placeholder : null))).toEqual(['title', 'subtitle']);
    expect(title.elements[0]).toMatchObject({ x: 160, y: 340, width: 1600, height: 220, text: 'Quarterly review' });
    expect(revenue.elements[1]).toMatchObject({ placeholder: 'body', x: 120, y: 260, text: 'Up 12% on the quarter\nEnterprise leads\nThree new logos' });
    expect(thanks.elements).toHaveLength(1);
    expect(revenue.notes).toBe('Mention the narwhal pilot only if asked.');
  });

  it('reads a deck as markdown matching its text and notes', async () => {
    const text = await run(owner, 'read_presentation', { presentation: 'Q3 review' });
    expect(text).toContain(`/sl/${deckId}`);
    expect(text).toContain('# Q3 review');
    expect(text).toContain('5 slides, 1920x1080');
    expect(text).toContain('## Slide 1: Quarterly review (layout: Title)\nEverything we shipped\n\nNotes:\nWelcome everyone, start with the glacier story.');
    expect(text).toContain('## Slide 2: Revenue (layout: Title and content)\n- Up 12% on the quarter\n- Enterprise leads\n- Three new logos');
    expect(text).toContain('Notes:\nMention the narwhal pilot only if asked.');
    expect(text).toContain('## Slide 5: Thanks');
    const listed = await run(owner, 'list_presentations', {});
    expect(listed).toContain(`"Q3 review" (id ${deckId}`);
  });

  it('finds a phrase that is only in speaker notes, and names the slide', async () => {
    const found = await api.call(viewer, 'GET', `/workspaces/${owner.workspaceId}/search?q=narwhal`);
    expect(found.body.presentations).toHaveLength(1);
    expect(found.body.presentations[0]).toMatchObject({ id: deckId, title: 'Q3 review', slide: 2, inNotes: true });
    expect(found.body.presentations[0].snippet).toContain('<mark>narwhal</mark>');

    const onSlide = await api.call(viewer, 'GET', `/workspaces/${owner.workspaceId}/search?q=churn`);
    expect(onSlide.body.presentations[0]).toMatchObject({ slide: 3, inNotes: false });

    const byTitle = await api.call(viewer, 'GET', `/workspaces/${owner.workspaceId}/search?q=q3`);
    expect(byTitle.body.presentations[0]).toMatchObject({ id: deckId, slide: null });

    expect(await run(owner, 'search', { query: 'narwhal' })).toContain(`presentation "Q3 review" (id ${deckId}), slide 2 notes`);
  });

  it('keeps a locked deck out of search, link targets and links', async () => {
    await api.call(owner, 'PUT', `/presentations/${deckId}/access`, {
      access: 'allow',
      entries: [{ userId: viewer.id, permission: 'view' }],
    });
    const seen = (user: TestUser) => api.call(user, 'GET', `/workspaces/${owner.workspaceId}/search?q=narwhal`);
    expect((await seen(viewer)).body.presentations).toHaveLength(1);
    expect((await seen(stranger)).body.presentations).toEqual([]);
    await expect(run(stranger, 'read_presentation', { presentation: deckId })).rejects.toThrow(/not found/i);

    const targets = (user: TestUser) =>
      api.call(user, 'GET', `/workspaces/${owner.workspaceId}/link-targets?kinds=presentations&q=Q3`);
    expect((await targets(viewer)).body.presentations).toEqual([{ id: deckId, title: 'Q3 review', icon: null }]);
    expect((await targets(stranger)).body.presentations).toEqual([]);

    const { resolveReferences } = await import('../src/lib/chatReferences.js');
    const body = `Deck <deck:${deckId}> and slide ${presentationRef(deckId, 'slide-1')}`;
    expect((await resolveReferences([body], owner.workspaceId, viewer.id)).presentations).toEqual([
      { id: deckId, title: 'Q3 review', icon: null },
    ]);
    expect((await resolveReferences([body], owner.workspaceId, stranger.id)).presentations).toEqual([]);
    // With no reader, only what is open to the workspace is named.
    expect((await resolveReferences([body], owner.workspaceId, null)).presentations).toEqual([]);

    await api.call(owner, 'PUT', `/presentations/${deckId}/access`, { access: 'open' });
    await api.sql(`UPDATE workspaces SET disabled_apps = '{slides}' WHERE id = $1`, [owner.workspaceId]);
    expect((await resolveReferences([body], owner.workspaceId, viewer.id)).presentations).toEqual([]);
    expect((await seen(viewer)).body.presentations).toEqual([]);
    await api.sql(`UPDATE workspaces SET disabled_apps = '{}' WHERE id = $1`, [owner.workspaceId]);
    expect((await resolveReferences([body], owner.workspaceId, null)).presentations).toHaveLength(1);
  });

  it('parses presentation and slide links', () => {
    const id = '11111111-2222-3333-4444-555555555555';
    const body = `<deck:${id}> then <deck:${id}#abc-123>`;
    expect(parseMessage(body)).toEqual([
      { type: 'presentation', id },
      { type: 'text', value: ' then ' },
      { type: 'presentation', id, slideId: 'abc-123' },
    ]);
    expect(collectReferences([body]).presentationIds).toEqual([id]);
  });

  it('adds, inserts and replaces slides, and renames', async () => {
    await run(owner, 'update_presentation', { presentation: deckId, outline: '# Appendix\n- Raw numbers\nNotes: Backup only' });
    let { deck } = await savedDeck(deckId);
    expect(deck.slides).toHaveLength(6);
    expect(deck.slides[5].notes).toBe('Backup only');

    await run(owner, 'update_presentation', { presentation: deckId, outline: '# Agenda\n- Revenue\n- Customers', mode: 'insert', slide: 2 });
    ({ deck } = await savedDeck(deckId));
    expect(deck.slides).toHaveLength(7);
    expect(deck.slides[1].elements[0]).toMatchObject({ text: 'Agenda' });

    await run(owner, 'update_presentation', { presentation: deckId, outline: '# Money\n- Big', mode: 'replace_slide', slide: 3 });
    ({ deck } = await savedDeck(deckId));
    expect(deck.slides).toHaveLength(7);
    expect(deck.slides[2].elements[0]).toMatchObject({ text: 'Money' });
    // Search reflects the edit: what was replaced is gone.
    const gone = await api.call(owner, 'GET', `/workspaces/${owner.workspaceId}/search?q=narwhal`);
    expect(gone.body.presentations).toEqual([]);

    await run(owner, 'update_presentation', { presentation: deckId, title: 'Q3 final' });
    expect(await run(owner, 'read_presentation', { presentation: 'Q3 final' })).toContain('7 slides');

    await run(owner, 'update_presentation', { presentation: deckId, outline: '# Only\n- One', mode: 'replace_all' });
    const { doc } = await savedDeck(deckId);
    expect(readSlideOrder(doc)).toHaveLength(1);
  });

  it('refuses what the person may not do', async () => {
    await expect(run(viewer, 'update_presentation', { presentation: deckId, outline: '# No' })).rejects.toThrow(/view this presentation/);
    await expect(run(owner, 'create_presentation', { title: 'Empty', outline: 'no headings? still text' })).resolves.toContain('with 1 slide');
    await expect(run(owner, 'update_presentation', { presentation: deckId, outline: '# x', mode: 'insert' })).rejects.toThrow(/needs slide/);
    await expect(run(owner, 'update_presentation', { presentation: deckId, outline: '# x', mode: 'replace_slide', slide: 9 })).rejects.toThrow(/has 1 slide/);
  });
});
