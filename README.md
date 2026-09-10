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
- **Desktop app** — a native macOS and Windows build that connects to any number
  of self-hosted servers, keeps local single-user workspaces that need no server
  at all, and updates itself from GitHub Releases or a channel you host
- **Chat** — per-workspace channels alongside the knowledge base, with live
  delivery, unread and mention counts, and links that work in both directions
  between documents and channels
- **Voice, video and screen sharing** — optional voice channels carried by a
  LiveKit server you run alongside the app

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

## Chat

Every workspace has channels as well as documents. The **Chat** tab in the
sidebar replaces the knowledge base with a chat client: the folder tree becomes
a channel list, and the document details panel goes away, since none of it
applies to a conversation. Switching back to **Docs** restores everything.

Owners and admins create and delete channels; everyone else reads and posts.
Channel names are addresses, so they are normalised the way a slug is —
"Design & Ops" becomes `#design-ops` — and have to be unique within the
workspace. A workspace always keeps at least one channel, because a chat tab
with nowhere to talk is a dead end. New workspaces start with `#general`.

Messages arrive over a websocket on `/chat`, on the same port and the same
session cookie as everything else. History is paged newest-first from the
database rather than held in a CRDT: a channel is an append-only log that grows
without bound, and a Yjs document would make every client load the whole thing
to show the last twenty lines. Unread counts are per person, and a channel you
are looking at never accumulates one.

**Links work in both directions.** In a message, `@` offers people, `#` offers
channels and `[[` offers documents; typing `#general` by hand links it too. In a
document, typing `#` offers the same channel list and inserts a link that opens
the channel in place rather than reloading the client.

Being mentioned is meant to be findable at a glance: your own name is painted
differently from anyone else's, and the whole message carries a highlight and a
marker down its edge. Mentions of other people are just links.

**Mentions are counted apart from unread.** A channel with unread messages shows
how many; a channel where someone named you shows an amber `@` count instead,
and the same rule applies to the Chat tab itself — being addressed directly
outranks ordinary chatter, and two numbers on one row would only be a puzzle.
Counts come from the server, matched on the stored id token, so someone renaming
themselves cannot change what counts as a mention.

The chat socket subscribes to every channel in the workspace rather than only
the open one. That is what lets a mention reach you while you are reading a
document or sitting in a different channel, and it keeps the unread counts live
without polling. Being mentioned also raises a desktop notification, which is
off until you ask for it: the chat header offers it once, and never again once
the browser has an answer. Nothing interrupts you for a channel you are already
looking at.

References are stored as ids — `<doc:…>`, `<#…>` and `<@…>` — and resolved when
the message is rendered, so renaming a document, or someone changing their
display name, updates every message that mentions them instead of leaving stale
names through the history. Resolution is scoped to the channel's workspace, and
people are resolved through workspace membership: an id pasted from somewhere
else simply does not resolve, so a message can never be used to read back a
title, or find out who somebody is, from a workspace the reader cannot see. A
reference to something since deleted renders as muted text rather than a broken
link.

## Voice and video

A workspace can also have voice channels, which sit in their own group in the
sidebar. They hold no messages — a voice channel is a room you drop into.
**Clicking one in the sidebar joins it**, with your microphone on and camera
and screen off until you turn them on. The people already inside are listed
under the channel, because whether anyone is in there is the thing you want to
know before joining, and a dot marks the one you are actually in.

The call belongs to the session rather than to the view, so wandering off to
read a document does not hang up on anyone. A bar above the sidebar footer
shows the call wherever you are, with mute and leave, and clicking it returns
you to the room. Clicking a different voice channel moves you: the old room is
left first, the way walking into another room works.

Media is carried by [LiveKit](https://livekit.io), an SFU: each participant
sends one copy of their stream and the server fans it out, rather than everyone
sending to everyone. That is what makes a call with a dozen people work.
Screen sharing is an ordinary track alongside camera and microphone, and a
shared screen takes over the tile it is shared from.

**It is optional.** With `LIVEKIT_URL`, `LIVEKIT_API_KEY` and
`LIVEKIT_API_SECRET` unset, the voice section disappears and everything else is
unaffected — a deployment that only wants documents and chat runs exactly as
before. The bundled server sits behind a compose profile so it is not started
unless asked for:

```bash
# in .env
LIVEKIT_URL=ws://192.168.1.10:7880      # what browsers dial, not a service name
LIVEKIT_API_KEY=paradocs
LIVEKIT_API_SECRET=$(openssl rand -hex 32)
LIVEKIT_NODE_IP=192.168.1.10            # the address this host answers on

docker compose --profile voice up -d
```

`LIVEKIT_URL` is dialled by *browsers*, so it has to be an address they can
reach — the compose service name will not do.

**With TLS**, a page served over https may only open `wss://`, so voice goes
through Caddy alongside everything else:

```bash
docker compose -f docker-compose.yml -f docker-compose.tls.yml \
  --profile voice up -d --build
```

The Caddyfile proxies LiveKit's `/rtc` (the signalling websocket) and `/twirp`
(its management API) to the voice container, which means `LIVEKIT_URL` is just
`wss://your-domain` — no second hostname and no second certificate. Set
`LIVEKIT_BIND=127.0.0.1` so the signalling port is reachable only by Caddy.

What cannot go through Caddy is the media. WebRTC audio and video travel over
UDP directly between browsers and the LiveKit container, so its published UDP
range stays open whatever else you lock down, and `LIVEKIT_NODE_IP` has to be
the address browsers actually reach this host on — a reverse proxy has no part
in it.

Joining is authorised the same way everything else is: the server mints a
LiveKit token scoped to one room, named for the channel id, only after checking
workspace membership. The token is the only way into a room, identity is the
user id so a second tab replaces the first rather than appearing twice, and it
expires after six hours.

In the desktop app, screen sharing goes through the macOS system picker where
that exists and an explicit list of windows elsewhere — never an automatic
choice, since which screen you reveal should always be deliberate.

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

## Desktop app

`apps/desktop` packages ParaDOCs as a native application for macOS and Windows.
It is the same web client, so nothing about the interface changes — what the
desktop adds is a place to keep more than one ParaDOCs, and the option of not
running a server at all.

**Connections.** The app opens on a list of workspaces. One is a *server*: the
address of a ParaDOCs you host, checked against `/api/health` before it is
saved. The other is a *local workspace*, which lives entirely on the computer.
Add as many of either as you like; each opens in its own window and each keeps
its own login, because every connection gets its own Chromium session
partition. Signing out of one leaves the others alone. `⌘⇧O` / `Ctrl+Shift+O`
reopens the list, and `⌘1`…`⌘9` jump straight to a workspace.

**Local workspaces** run the whole server inside the app: the same Fastify
routes, the same migrations, the same collaboration layer, with
[PGlite](https://pglite.dev) — Postgres 16 compiled to WebAssembly — in place of
a Postgres server. Generated `tsvector` search, `ts_headline` snippets,
`pg_trgm` and recursive folder queries all behave as they do on a real server,
because it is a real Postgres. Everything is written under the OS application
data directory, one folder per workspace:

```
macOS    ~/Library/Application Support/ParaDOCs/local/<id>/
Windows  %APPDATA%\ParaDOCs\local\<id>\
```

with `pgdata/` for the database and `uploads/` for files, so one folder is the
whole backup. A local workspace signs itself in — asking for an account and a
password to read your own files would protect nothing, since the database sits
unencrypted beside them. It is for one person: sharing, invites and live
collaboration need a server. Removing a local workspace from the list only
forgets it; the documents stay on disk.

**How it works.** The main process serves the bundled client and reverse-proxies
`/api`, `/uploads` and the `/collab` websocket to whichever server that window
is connected to — the same arrangement as the Vite dev server. The renderer
therefore sees one origin, exactly as a browser hitting a self-hosted
deployment does, and the session cookie is an ordinary same-origin cookie
rather than a third-party one. A local workspace is proxied identically; it is
just a server that happens to live in the same process.

The proxy listens on a random loopback port, refuses requests whose `Host` is
not loopback (which is what defeats DNS rebinding), and strips `Secure` and
`Domain` from cookies on their way back, since they were minted for an https
origin and are being replayed over `http://127.0.0.1`. The hop from the app to
the server keeps its TLS. Windows showing the client are given no preload
bridge at all, may only navigate within the proxy origin — every other link
opens in the real browser — and run under a content security policy that
allows scripts only from the bundled client.

**Updates.** An installed build checks for a new version shortly after launch
and every six hours after that, downloads it in the background, and offers to
restart — the update is applied on the next quit either way, so nothing
interrupts you mid-sentence. Local workspaces are shut down cleanly before the
installer runs, so pending document saves are flushed first. Both behaviours
are switches in the workspace list, and **Check for Updates…** in the
application menu (Help on Windows) forces a check with visible results.

Where updates come from is not fixed to GitHub. A build published with
electron-builder carries its own channel; a deployment that would rather serve
its own can point the app at any static directory holding the release artifacts
and their `latest*.yml`:

```bash
PARADOCS_UPDATE_URL=https://updates.example.com/paradocs/
```

Set `publish.owner` and `publish.repo` in `apps/desktop/electron-builder.yml` to
your own repository before releasing. A build made without a publish target
carries no update metadata, and the app then says so plainly instead of
reporting an error on every launch.

Two things are worth knowing before relying on this. **An unsigned build cannot
update itself**: macOS refuses to replace an application whose signature it
cannot verify, and the app reports exactly that rather than failing silently.
And updates are only as trustworthy as the channel — electron-updater verifies
the sha512 in `latest*.yml`, so serve that file over HTTPS.

**Building it.**

```bash
npm install
npm run desktop              # build and run against the current source
npm run desktop:dist:mac     # .dmg and .zip, arm64 and x64
npm run desktop:dist:win     # NSIS installers, x64 and arm64
```

Windows installers can be produced from macOS or Linux; the macOS build has to
run on macOS. Builds are unsigned unless signing credentials are present.
For macOS set `CSC_LINK` and `CSC_KEY_PASSWORD` to a Developer ID certificate,
and `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` to notarise;
the hardened runtime entitlements in `apps/desktop/build` already allow the JIT
that Chromium and PGlite's WebAssembly need. For Windows set `CSC_LINK` and
`CSC_KEY_PASSWORD` to a code signing certificate. Without signing, both systems
will warn on first launch.

The app icon is generated from one script, `apps/desktop/build/make-icons.py`;
the generated `.icns`, `.ico` and `.png` are committed so packaging does not
need Python.

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
apps/desktop    Electron shell for macOS and Windows. Bundles apps/web and,
                for local workspaces, apps/api on PGlite.
packages/shared TypeScript types and zod schemas used by both sides.
```

The API is a plain REST surface under `/api` and is usable without the web client.
Sessions are an HttpOnly cookie backed by a `sessions` table; passwords are hashed
with scrypt.

## Releasing

Pushing a version tag builds the desktop app on both platforms and uploads the
installers, along with the `latest*.yml` manifests the updater reads, to a
**draft** GitHub Release. Publishing the draft is a separate, deliberate step,
because that is the moment every installed client starts seeing the update.

```bash
# 1. Bump the version electron-builder reads. The tag must match it.
npm version 0.1.1 --workspace=@paradocs/desktop --no-git-tag-version

# 2. Commit and tag. Use -a: `git push --follow-tags` ignores lightweight tags,
#    so a plain `git tag` would stay on your machine and never trigger a build.
git commit -am "Release 0.1.1"
git tag -a v0.1.1 -m "ParaDOCs 0.1.1"

# 3. Push the branch and the tag. Pushing the tag is what starts the release.
git push origin main
git push origin v0.1.1
```

If the Actions tab shows no run after pushing the tag, the tag did not reach
GitHub — check with `git ls-remote --tags origin`.

`.github/workflows/release.yml` then runs a typecheck, refuses the build if the
tag and `apps/desktop/package.json` disagree, and builds on macOS and Windows
runners. Review the draft release, write the notes, and publish it.

Signing is wired but optional: the workflow reads `CSC_LINK`,
`CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and
`APPLE_TEAM_ID` from repository secrets and skips signing when they are absent,
so adding certificates later needs no change to the workflow. Enabling Apple
notarisation additionally means setting `notarize: true` under `mac:` in
`apps/desktop/electron-builder.yml`.

Until macOS builds are signed, say so on the release page: **Mac users have to
download new versions manually**, because macOS refuses to replace an
application whose signature it cannot verify. The app reports this rather than
failing silently. Windows updates itself unsigned, with a SmartScreen warning on
first install.

To cut a release without CI, build locally and attach the files from
`apps/desktop/release/` — including `latest-mac.yml` and `latest.yml`, without
which nothing can update:

```bash
npm run desktop:dist:mac
npm run desktop:dist:win
```

## License

AGPL-3.0-or-later. The full text is in [LICENSE](LICENSE).
