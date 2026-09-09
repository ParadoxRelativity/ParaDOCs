# ParaDOCs

A self-hosted, open-source document management system. Workspaces, folders, tags,
full-text search, a block editor, and a daily journal — running entirely on your
own hardware, with your documents in your own Postgres database.

Built to replace hosted tools like Confluence, Miro, and Affine without handing a
vendor the ability to change the terms underneath you.

## Status

Multi-user, multi-workspace. Working today:

- **Documents** — block editor (BlockNote) with markdown shortcuts, slash commands,
  code blocks, tables, and images
- **Organization** — nested folders, per-workspace tags, archive. Folder, tags and
  custom properties are editable inline on the document and in the right sidebar
- **All Documents** — flat view of every document, filed or not, with sorting,
  title filtering and one-click filing into a folder
- **Search** — Postgres full-text over titles and body, prefix-matched as you type,
  with highlighted snippets; filter by tag, folder, and date range
- **Daily journal** — one entry per day, created on first visit
- **Left sidebar** — collapsible; workspace switcher, folder tree, tag list. Shows
  organized documents only; new documents start unfiled and appear in All Documents
- **Right sidebar** — collapsible; table of contents, calendar with events and
  activity, document properties, comments
- **Markdown export** — every document exports with YAML frontmatter
- **Multiple users per workspace** — roles, invite links, and live collaborative
  editing with remote cursors and presence
- **Settings** — one dialog for account (name, email, password), appearance
  (theme), workspace (name, icon, delete), members and uploads
- **Canvas mode** — an infinite board per document: sticky notes, text, document
  cards, webpage/video embeds, images, audio, shapes, mind maps, connectors
  and presentation frames

Not yet built: OIDC single sign-on (stubbed, see below) and the automated backup
integrations (Backblaze/NAS) described below.

## Canvas mode

Any document is either a **page** (block editor) or a **canvas** (infinite
board). Switch in the right sidebar under Properties → Mode, or create one
directly with "New canvas". The two modes keep separate content, so switching
back and forth loses nothing.

A document's icon follows the mode it was last used in — 📄 for a page, 🎨 for a
canvas — in the sidebar, All Documents and search results. A document with its
own icon set keeps that instead, and journals stay 📔.

Canvas elements live in the *same Y.Doc* as the page body, under a separate root
map. Collaboration, websocket auth, role checks and persistence are therefore
identical to page documents — only the editing surface and the derived search
text differ.

| Element    | What it does                                                        |
| ---------- | ------------------------------------------------------------------- |
| Sticky note| Coloured note with editable text                                     |
| Text       | Plain label, no background                                            |
| Document   | A document rendered on the board: readable at rest, editable in place. ✚ creates a new one, 📄 links an existing one |
| Embed      | Any framable URL. YouTube, Vimeo and Loom links are converted to their embed form |
| Image      | Image by URL, upload, paste or drop                                    |
| Audio      | Audio by URL or upload, with transport controls                       |
| Video      | Video by URL or upload, with playback controls                        |
| Shape      | Rectangle, ellipse, diamond or triangle, with a solid or transparent fill and a connector-style edge |
| Mind node  | A mind-map node that draws its own branch to its parent; ✚ on a node adds a child, and children can have children |
| Frame      | A named region that doubles as a presentation slide                   |
| Connector  | A line joining any two elements: straight, curved or right-angled; arrows on either end, both or neither; solid, dashed or dotted; six colours; optional label |

**Adding media.** Images, audio and video can come from a URL, a file picker in
the insert dialog, a paste, or a drag from the desktop straight onto the board.
Dropped files land where you drop them; a paste lands where the pointer last
was. Files go through the workspace's upload endpoint and are stored under
`UPLOAD_DIR`, so they are covered by the same backup as the rest of the
workspace. Anything that is not an image, audio or video is refused with a
message rather than silently ignored.

Uploads record the document they were added from. When that document is deleted
the file is kept and its reference nulled, so nothing disappears silently — the
file shows up under **Settings → Uploads** instead.

**Shapes.** ▭ turns on the shape tool and leaves it on, with a picker for
rectangle, ellipse, diamond or triangle. Drag on the board to draw a shape at
whatever size you want, or click for a default size; Escape or Done puts the
tool away. Because the tool takes over the press, you can draw on top of
existing elements.

Each shape has a fill (a colour or fully transparent) and an edge styled like a
connector: colour, width and solid, dashed or dotted. Shapes carry text
natively — double-click one to write in it. Label colour is chosen to contrast
with the fill, so it stays readable on a pale fill in dark mode and on a
transparent one in either theme.

**Mind maps.** 🌳 drops a root node; every node carries a ✚ button that
adds a child, and children carry one too, so a tree grows to any depth. New
children open for typing immediately. Branches are drawn for you from the
parent-child relationship rather than being connectors you place — they follow
the nodes as you drag them and cannot be orphaned. A node's colour is its
branch colour, inherited from its parent and changeable from the selection bar.
Deleting a node deletes the branch beneath it.

**The toolbar.** Canvas controls are icon-only, so every one of them shows a
tooltip on hover or keyboard focus explaining what it does. Tooltips render into
a portal and are clamped to the viewport, so a control at the edge of the bar
still shows its full label.

**Navigation.** Drag empty space to pan, ⌘/Ctrl-scroll to zoom, plain scroll to
move around, shift-drag to marquee-select, hold space to pan even over elements,
and ⤢ to zoom to fit.

**Editing.** A single click selects and drags; a double-click enters text
editing, the same split edgeless boards use. Double-click empty space to drop a
note where you clicked, and Delete or Backspace removes the selection.

Dragging and resizing are applied straight to the DOM during the gesture and
written to the shared document once on release. Writing every pointer move into
the CRDT re-serialised the whole board on each frame, which made dragging feel
heavy; committing once per gesture also means a drag is a single change for
collaborators rather than sixty.

**Documents on the board.** A document card shows the document's real content,
not just its title. At rest it renders a lightweight read-only preview;
double-clicking mounts a live collaborative editor bound to that document's own
Y.Doc, so edits made on the board are the same edits as on the page. Only the
card being edited holds a websocket, so a board full of cards stays cheap. The
⇱ button in a card's header opens it as a full page.

The ✚ tool creates a real document in the workspace and drops a card for it, so
a board can spawn the documents it references without leaving the canvas.

**Connecting.** ↔ turns on the connector tool and leaves it on, so several
connections can be drawn in a row. With it active, hovering an element shows an
anchor port on each of its four faces.

Joining two elements works either way round, so nothing has to be held down:

- **Click** a port, move, then **click** the target. The line trails the cursor
  in between, and Escape or a click on empty space abandons it.
- Or **drag** from a port and release on the target.

Finishing on a port pins that face; finishing on the body leaves the side
automatic, so the line re-picks whichever faces are closest as the elements move.

Connectors are ordinary elements: click one to select it, Delete or Backspace to
remove it, and deleting an element takes its connectors with it. Selecting one
opens a bar for its shape (straight, curved, right angles), arrowheads (start,
end, both or none), line style (solid, dashed, dotted), colour and label.

**Reshaping.** A selected connector shows a routing handle. On a right-angled
line the handle slides along one axis to move where the turn happens; on a curve
it moves the point the curve passes through; on a straight line, dragging it
bends the line and switches it to a curve. Manual routing sticks until you press
Reset route, at which point the line goes back to deriving itself.

Endpoints are recomputed from live element positions, so moving either end
redraws the line. Connectors paint above elements, so a line crossing a shape —
and its arrowhead at the shape's edge — stays visible.

**Presenting.** Each frame is a slide, ordered by its Slide number. Press
Present to go fullscreen; arrow keys, space, PageUp/PageDown navigate and Escape
exits. The presentation takes keyboard focus while it is open and hands it back
on exit, so its keys work without clicking into it first. Anything overlapping a frame travels with that slide, and everything is
read-only while presenting so the board cannot be nudged mid-pitch.

Embeds are sandboxed and inert until selected, so a third-party iframe can never
swallow a drag or reach into the app. Some sites refuse to be framed at all;
that is the site's policy, not a ParaDOCs limitation.

Canvas text is searchable: notes, text, frame names, linked document titles,
embed URLs and connector labels are folded into the document's searchable body.

## Users, roles and sharing

A workspace has members, each with one role:

| Role     | Can do                                                        |
| -------- | ------------------------------------------------------------- |
| `owner`  | Everything, including deleting the workspace                   |
| `admin`  | Manage members and invites, plus everything an editor can do    |
| `editor` | Create and edit documents, folders and tags                     |
| `viewer` | Read, search and comment; cannot change content                 |

A workspace always keeps at least one owner: the last one cannot be demoted or
removed. Non-members get `404` rather than `403` so workspace ids stay unguessable.

**Inviting people.** This server does not send email. An admin creates an invite
from the Members panel and gets a link to pass along:

- with an email address — single use, and only that address may redeem it
- without one — a shareable link anyone can use until it expires (14 days default)

## Managing uploads

Owners and admins get a **Uploads** section in Settings listing the workspace's
files, with a running total of how much storage they use. A file counts as
*unattached* when no document owns it: it was uploaded on its own, or the
document holding it was deleted, which nulls the reference rather than removing
the file.

For each unattached file there are two ways out:

- **Attach…** creates a new document containing the file — an image, video,
  audio or file block, chosen from its type — and re-homes the attachment to it.
- **Delete** removes the row and the bytes from disk, tolerating a file that has
  already gone missing.

Editors can upload but cannot see or manage this list.

One limitation worth knowing: a file is judged unattached purely by whether a
document owns it. Removing the *element* that used a file, without deleting its
document, leaves the file counted as attached.

## Real-time collaboration

Documents are edited collaboratively over Yjs. The browser opens a websocket to
`/collab` on the same origin, so the session cookie authenticates it; the server
then checks workspace membership per document and marks viewers' connections
read-only.

While a document is open **the Y.Doc is the source of truth**. The server
persists it to `documents.ydoc` and re-derives `body` and `body_md` from it on
every save, so search, export and the REST API keep seeing current content.
A document that predates collaboration is seeded into a Y.Doc from its blocks
the first time it is opened.

One consequence worth knowing: writing `body` through `PATCH /api/documents/:id`
clears `ydoc`, so the next editing session reseeds from those blocks. That keeps
the REST API usable for scripts, but a REST write made *while* someone has the
document open will be overwritten by the live session.

## OIDC single sign-on

Stubbed in Phase 1. The groundwork is in place — an `auth_identities` table for
linking a provider subject to a local account, a nullable `users.password_hash`
for accounts that never set one, and the `OIDC_*` settings — but
`/api/auth/oidc/login` and `/api/auth/oidc/callback` return `501` on purpose
rather than half-working. When configured, the login screen shows the SSO button
as unavailable. Sign-in is email and password until Phase 2.

## How documents are stored

Documents live in Postgres. Each row carries three representations:

| Column    | What it is                                     | Who writes it            |
| --------- | ---------------------------------------------- | ------------------------ |
| `body`    | BlockNote block array (JSONB) — **canonical**   | The editor               |
| `body_md` | Markdown, regenerated on every save            | Derived from `body`      |
| `search`  | `tsvector` over title + markdown, generated     | Postgres                 |

The block array is what the editor round-trips, so nothing is lost to markdown
conversion while you type. The markdown is what search indexes and what export
produces, so your content is never trapped in a proprietary shape. If a document
is written by an API client that omits editor-specific fields, the web client
normalizes the blocks before rendering rather than failing.

## Requirements

- Node.js 20+
- PostgreSQL 14+ (uses `pgcrypto` and `pg_trgm`, both in contrib)

## Running it

### Docker (recommended for self-hosting)

```bash
cp .env.example .env

# Both secrets are required; compose refuses to start without them.
node -e "console.log('SESSION_SECRET=' + require('crypto').randomBytes(32).toString('hex'))" >> .env
node -e "console.log('POSTGRES_PASSWORD=' + require('crypto').randomBytes(18).toString('base64url'))" >> .env

docker compose up -d --build
```

Open <http://localhost:4000> and register. That is the whole deployment: one app
container plus Postgres. The image builds the SPA and runs the API, which serves
the client and the collaboration websocket, so there is no second service and no
reverse proxy to configure for the basic case.

**Serving it on a domain with HTTPS.** The TLS overlay adds Caddy, which obtains
and renews certificates automatically:

```bash
# in .env
DOMAIN=docs.example.com
BIND_ADDR=127.0.0.1     # keep the app off the public interface

docker compose -f docker-compose.yml -f docker-compose.tls.yml up -d --build
```

Point the domain at the host first, or the certificate order fails. The overlay
also sets `SECURE_COOKIES=true`, which is required once traffic is HTTPS.

**Upgrading** is `docker compose pull` (or `--build`) then `up -d`. Migrations
are idempotent and run on boot, so there is no separate step. If you ever run
more than one app replica, run migrations once out of band instead, so two
containers do not apply them at the same time.

**What the image contains.** A multi-stage build: the web client is compiled in
a build stage, and the runtime stage installs only production dependencies. The
API runs from TypeScript source through `tsx`, which is therefore a runtime
dependency rather than a dev tool. The server-side Yjs to markdown conversion
pulls BlockNote and ProseMirror in, so the runtime dependency tree is around
250 MB — most of the image.

The container runs as the unprivileged `node` user, under `tini` so `docker
stop` reaches the server and its graceful shutdown flushes any pending
collaborative document saves. `docker compose ps` reports health from the app's
own `/api/health` route.

**Data lives in two volumes**: `db-data` for Postgres and `uploads` for attached
files. Back up both together — see below.

### Local development

```bash
cp .env.example .env          # then set DATABASE_URL and SESSION_SECRET
createdb paradocs
npm install
npm run migrate
npm run seed                  # optional demo content
npm run dev                   # API on :4000, web on :5173
```

Open <http://localhost:5173>. Vite proxies `/api` to the API, so the session cookie
is same-origin in development exactly as it is in production.

## Configuration

All settings come from `.env` at the repo root, read by both the API and Vite.

| Variable             | Default                 | Purpose                                                     |
| -------------------- | ----------------------- | ----------------------------------------------------------- |
| `DATABASE_URL`       | —                       | Postgres connection string (required)                        |
| `SESSION_SECRET`     | —                       | 32+ chars, required; the server refuses to start without it  |
| `API_PORT`           | `4000`                  | API listen port                                              |
| `CORS_ORIGIN`        | `http://localhost:5173` | Comma-separated origins allowed to send credentials          |
| `SECURE_COOKIES`     | `false`                 | Set `true` when serving over HTTPS                           |
| `UPLOAD_DIR`         | `./data/uploads`        | Where attachments are written                                |
| `ALLOW_REGISTRATION` | `true`                  | Set `false` to close signups; the first account is always allowed |

## Backing it up

Everything lives in two places, both easy to hand to any backup tool:

```bash
pg_dump "$DATABASE_URL" | gzip > paradocs-$(date +%F).sql.gz
tar czf uploads-$(date +%F).tar.gz ./data/uploads
```

Point restic, rclone, or Duplicati at those two artifacts to reach Backblaze B2,
S3, or a NAS. Built-in scheduled backups to those targets are planned; until then
the export above is the whole database.

Individual documents can also be pulled out as markdown at any time:

```
GET /api/documents/:id/markdown
```

## Keyboard shortcuts

| Shortcut      | Action                  |
| ------------- | ----------------------- |
| `⌘K` / `Ctrl+K` | Open search           |
| `⌘\` / `Ctrl+\` | Toggle left sidebar   |
| `⌘⇧\`          | Toggle right sidebar   |
| `⌘⇧J`          | Open today's journal   |
| `/`            | Block commands in the editor |

## Layout

```
apps/api        Fastify + node-postgres. Raw SQL, numbered migrations.
apps/web        React SPA. Vite, TanStack Query, BlockNote, Tailwind.
packages/shared TypeScript types and zod schemas used by both sides.
```

The API is a plain REST surface under `/api` and is usable without the web client.
Sessions are an HttpOnly cookie backed by a `sessions` table; passwords are hashed
with scrypt.

## License

AGPL-3.0-or-later.
