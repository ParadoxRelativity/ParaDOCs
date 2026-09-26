# ParaDOCs

A self-hosted, open-source document management system. Workspaces, folders, tags,
full-text search, and a block editor, plus chatrooms and spreadsheets, running entirely on your
own hardware, with your documents in your own Postgres database.

Own your data and collaborate with friends and colleagues!

## Status

Multi-user, multi-workspace. Working today:

- **Documents** — block editor (BlockNote) with markdown shortcuts, slash commands,
  code blocks, tables and images; `@` tags a person, `#` links a channel, and `/`
  inserts a live spreadsheet cell or chart
- **Organization** — nested folders, per-workspace tags, archive. Folder, tags and
  custom properties are editable in a collapsible block under the title and in
  the right sidebar
- **All Documents** — flat view of every document, filed or not, with sorting,
  title filtering and one-click filing into a folder
- **Search** — Postgres full-text over document titles and bodies, and over
  spreadsheet titles and cells, prefix-matched as you type, with highlighted
  snippets; filter by tag, folder, and date range
- **Left sidebar** — collapsible; workspace switcher, an app grid for moving
  between Docs, Chat and Sheets, and the folder tree, channel list or
  spreadsheet list of whichever is open. Shows organized documents only; new
  documents start unfiled and appear in All Documents
- **Right sidebar** — collapsible; table of contents, calendar with events and
  activity, document properties, comments
- **Tabs** — documents, canvases, spreadsheets and chats open side by side in a
  tab strip, across workspaces
- **Notifications** — one bell for unread messages, tags in documents and
  canvases, and invitations to other workspaces
- **Markdown export** — every document exports with YAML frontmatter
- **Multiple users per workspace** — roles, invite links, live collaborative
  editing with remote cursors and presence, and teams with access locks on
  folders, documents and channels
- **Settings** — one dialog for account (picture, name, email, password,
  status), appearance (theme, notification and call layout), voice and video
  devices, workspace (name, icon, picture, delete), members, teams and uploads;
  the desktop app adds servers and updates
- **Canvas mode** — an infinite board per document: sticky notes, text, document
  cards, webpage/video embeds, images, audio, shapes, mind maps, connectors,
  spreadsheet cells and charts, and presentation frames
- **Spreadsheets** — collaborative workbooks with multiple sheets, over 80
  formula functions with inline help, number formats, sorting, charts, and
  Excel import and export
- **Desktop app** — a native macOS and Windows build that connects to any number
  of self-hosted servers, keeps local single-user workspaces that need no server
  at all, pops conversations and calls out into windows of their own, and
  updates itself from GitHub Releases or a channel you host
- **Chat** — per-workspace channels alongside the knowledge base, with topics,
  live delivery, typing indicators, files, emoji and reactions, unread and
  mention counts, and links that work in both directions between documents,
  spreadsheets and channels
- **Direct messages and presence** — one-to-one conversations and calls that
  ring wherever you are in the app, with online, away, busy and offline statuses
- **Voice, video and screen sharing** — optional voice channels carried by a
  LiveKit server you run alongside the app

Not yet built: the automated backup integrations (Backblaze/NAS) described below.

## Canvas mode

Any document is either a **page** (block editor) or a **canvas** (infinite
board). Switch in the right sidebar under Properties → Mode, or create one
directly with "New canvas". The two modes keep separate content, so switching
back and forth loses nothing.

A document's icon follows the mode it was last used in — 📄 for a page, 🎨 for a
canvas — in the sidebar, All Documents and search results. A document with its
own icon set keeps that instead.

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
| Sheet cell | A spreadsheet cell's current value (see [Spreadsheets](#spreadsheets)) |
| Sheet chart| A spreadsheet chart, drawn from the spreadsheet's current data         |
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
Canvas text can also tag a person with `@`, stored as the same `<@…>` id token
chat uses, so the tag follows a rename.

## Spreadsheets

The **Sheets** app sits beside Docs and Chat in the sidebar's app grid. A
spreadsheet is its own record, not a document in another mode: it has no
blocks, folders, tags or comments, so the sidebar lists a workspace's
spreadsheets flat, most recently edited first. What it shares with documents is
the collaboration machinery. The grid is a Y.Doc served over the same
`/collab` socket, so several people edit at once, and each cell is its own key,
so two people changing different cells never overwrite each other.

**The grid.** A name box and formula bar above the grid show where you are and
what is really in the cell. Only the rows and columns on screen are rendered,
so a sheet can grow well past its starting hundred rows by twenty-six columns
without slowing down. Columns resize from their headers, ⌘/Ctrl-click adds
separate ranges to a selection, and copy and paste work within the grid and
with other spreadsheet apps. The toolbar and the right-click menu cover number
formats (number, whole number, currency, percent, scientific, date, time,
plain text) and decimal places, bold, italic and alignment, sorting a
selection, summing it into the cell below, and inserting or deleting rows and
columns. Anyone whose role cannot edit spreadsheets gets the same grid, read-only.

**Formulas.** Over 80 functions across maths, statistics, logic, lookup
(`VLOOKUP`, `HLOOKUP`, `INDEX`, `MATCH`), text and dates. While a formula is being
typed, matching function names are offered, and inside a call the function's
arguments are shown with the current one picked out. Only what was typed is
stored. Values are computed from the formulas, so a result never goes stale
when someone else edits a cell it depends on.

**Sheets.** A spreadsheet holds any number of sheets, in tabs under the grid.
Double-click a tab to rename it, right-click for the rest, drag to reorder.
Every formula that names a sheet follows a rename and shows `#REF!` after a
delete, which is why deleting asks first.

**Charts.** Select data and choose **Chart the selection** to draw a bar, line,
pie or scatter chart on the sheet. A chart stores its range the way a formula
does, never the numbers, so it always shows what the sheet holds now, and a row
inserted inside its range stretches it. Ranges can be split — `A1:A10,C1:C10` —
and individual rows can be left out from the chart's data panel.

**Excel files.** Importing an `.xlsx` from the spreadsheet list creates a new
spreadsheet with all of its sheets, and any spreadsheet exports back to `.xlsx`.
Formulas travel as formulas, with their computed values alongside so Excel
shows the right numbers before it recalculates. Anyone who can read a
spreadsheet can export it. The Excel library is loaded only when a file is
imported or exported, so opening a spreadsheet never pays for it.

**Using a spreadsheet elsewhere.** A document can show a cell's value in the
middle of a sentence, or a whole chart as a block: type `/` and choose
**Spreadsheet cell** or **Spreadsheet chart**. A canvas has the same two tools,
and a chat message can link to a spreadsheet the way it links to a document.
What is stored is the address, never the value. The server reads the
spreadsheet's live grid if someone has it open and its saved copy otherwise, so
a document opened a week later shows this week's numbers. A reference names the
sheet by id, so renaming a tab does not break it, and the cell by address, so —
as with any link into a spreadsheet — inserting rows above the cell moves the
data out from under it. A reference the reader cannot see shows as unavailable,
without saying whether the spreadsheet exists.

Spreadsheets follow workspace roles: a role can edit them, only read them, or
not see Sheets at all. Unlike
folders, documents and channels, they cannot be locked individually yet.

## Chat

Every workspace has channels as well as documents. Choosing **Chat** from the
app grid at the top of the sidebar replaces the knowledge base with a chat
client: the folder tree becomes a channel list, and the document details panel
goes away, since none of it applies to a conversation. Switching back to
**Docs** restores everything.

Owners and admins create and delete channels; everyone else reads and posts.
Channel names are addresses, so they are normalised the way a slug is —
"Design & Ops" becomes `#design-ops` — and have to be unique within the
workspace. A workspace always keeps at least one channel, because a chat tab
with nowhere to talk is a dead end. New workspaces start with `#general`.

Each channel has a topic, shown beside its name, so people know what belongs
there before they post. While someone is writing, the line above the message
box says who is typing; the line keeps its height when nobody is, so the
conversation does not jump.

Messages arrive over a websocket on `/chat`, on the same port and the same
session cookie as everything else. History is paged newest-first from the
database rather than held in a CRDT: a channel is an append-only log that grows
without bound, and a Yjs document would make every client load the whole thing
to show the last twenty lines. Unread counts are per person, and a channel you
are looking at never accumulates one.

**Links work in both directions.** In a message, `@` offers people, `#` offers
channels and `[[` offers documents and spreadsheets; typing `#general` by hand
links it too. In a
document, typing `#` offers the same channel list and inserts a link that opens
the channel in place rather than reloading the client.

In a document or on a canvas, `@` tags a person. The person tagged hears about
it in the notifications bell, once per document rather than once per tag:
being named three times in one document is one thing to go and read. Opening
the document clears it.

Being mentioned is meant to be findable at a glance: your own name is painted
differently from anyone else's, and the whole message carries a highlight and a
marker down its edge. Mentions of other people are just links.

**Mentions are counted apart from unread.** A channel with unread messages shows
how many; a channel where someone named you shows an amber `@` count instead,
and the same rule applies to Chat in the app grid — being addressed directly
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

References are stored as ids — `<doc:…>`, `<sheet:…>`, `<#…>` and `<@…>` — and resolved when
the message is rendered, so renaming a document, or someone changing their
display name, updates every message that mentions them instead of leaving stale
names through the history. Resolution is scoped to the channel's workspace, and
people are resolved through workspace membership: an id pasted from somewhere
else simply does not resolve, so a message can never be used to read back a
title, or find out who somebody is, from a workspace the reader cannot see. A
reference to something since deleted renders as muted text rather than a broken
link.

**Files.** Drop files onto a channel, paste them, or use the **+** button in the
message box; up to ten go out with one message. Each uploads as soon as it is
added, with its progress shown, so sending is instant, and a message sent while
files are still uploading goes out once they finish. Pictures and videos appear
in the conversation and open full-window, where the arrow keys move between the
ones in that message. Audio gets a player, and anything else is a card to
download. Deleting a message deletes its files.

Like document attachments, files are served from `/uploads/` at long,
unguessable addresses without a login check. Pictures, audio, video and PDFs
display in place; anything else is sent as a download inside a sandbox, so an
uploaded HTML or SVG file cannot run script as whoever opens it. Files added to
a message that is never sent are removed after a day. The size limit is the
server's `MAX_UPLOAD_MB` (see [Configuration](#configuration)).

**Emoji.** The smiley button opens a picker, and typing `:` with a couple of
letters offers matching emoji — `:tada` finds 🎉. A shortcode typed out in full
is converted when the message is sent, and a message of only a few emoji is
shown large. Hovering a message offers a reaction. Reactions show who added
them, clicking one joins it or takes yours back, and they update live for
everyone in the channel.

## Direct messages and presence

Beside the channels, the chat sidebar lists your direct conversations: one to
one, with another member of the workspace. A direct conversation is a channel
that only its two people can see, so files, reactions, mentions, unread counts
and calls all work in it exactly as they do in a channel. Start one with **New
direct message**, or from someone's card in the member list. A conversation
appears in the other person's list once it has a message in it, not merely
because you opened it.

The member list beside the chat shows everyone in the workspace, the people who
are around first. Rows stay alphabetical within each group rather than sorting
by status, so the list does not reshuffle under the pointer as people come and
go. Pressing a name opens that person's card, with buttons to message or call
them. On your own card, you can set your status instead.

**Status** is online, away, busy or offline. *Online* means "work it out for
me": you show as away once every window you have open has had no mouse or
keyboard activity for a set time, ten minutes by default, and being in a call
counts as activity. *Offline* is appearing offline while still signed in. Your
status is kept on your account, so it follows you to every device; the away
timeout, including never, is under **Settings → Account**.

## Voice and video

A workspace can also have voice channels, which sit in their own group in the
sidebar. They hold no messages — a voice channel is a room you drop into.
**Clicking one in the sidebar joins it**, with your microphone on and camera
and screen off until you turn them on. The people already inside are listed
under the channel, because whether anyone is in there is the thing you want to
know before joining, and a dot marks the one you are actually in. LiveKit
tells the app as people join and leave, so that list updates for everyone
straight away.

The call belongs to the session rather than to the view, so wandering off to
read a document does not hang up on anyone. A bar above the sidebar footer
shows the call wherever you are, with mute and leave, and clicking it returns
you to the room. Clicking a different voice channel moves you: the old room is
left first, the way walking into another room works.

**Calling someone.** A voice or video call from a direct conversation, or from
someone's card, rings them wherever they are in the app, even in another
document or workspace. A card in the corner of their screen offers to accept,
to accept with or without video, or to decline, and says first if accepting
would leave a call they are already in.

Clicking a camera or a shared screen makes it large, with the other videos
moved beside or below it, whichever is set under **Settings → Appearance**.
Microphone, speaker and camera, and their volumes, are chosen under
**Settings → Voice & video** and apply straight away, even mid-call.

Media is carried by [LiveKit](https://livekit.io), an SFU: each participant
sends one copy of their stream and the server fans it out, rather than everyone
sending to everyone. That is what makes a call with a dozen people work.
Screen sharing is an ordinary track alongside camera and microphone, and a
shared screen takes over the tile it is shared from.

**It is on by default** in the Docker deployment, with nothing to configure.
The `livekit` container starts alongside the app, the app generates the API key
pair it shares with LiveKit on first start, and new workspaces come with a
**lounge** voice channel beside `#general`. Set `VOICE_ENABLED=false` to turn
it off; voice channels then disappear and everything else is unaffected.

Browsers reach LiveKit through the app. Its connection setup, the `/rtc`
websocket, is relayed on the app's own address, so it follows the app onto
HTTPS behind Caddy with no second hostname, certificate or published port. Each
browser is handed the address it used to reach the app, so the same server
works by IP address, by domain name, and from the desktop app.

What cannot be relayed is the media. WebRTC audio and video travel directly
between browsers and the LiveKit container, so its media ports are published
and have to be open in the firewall: a single UDP port, **7882**, however many
people are in calls — LiveKit tells callers apart by their address rather than
giving each a port of its own — and TCP **7881** as the fallback for networks
that block UDP. Browsers are told these exact numbers, so if you change one,
change both LiveKit's config and its published ports, which sit together in
`docker-compose.yml`. On a very busy server, raise the kernel's UDP receive
buffer (`net.core.rmem_max`) so that one socket is not the place packets get
dropped.

LiveKit also has to tell browsers where to send that media. It finds this
host's public address by asking a STUN server as it starts. Set
`LIVEKIT_NODE_IP` for a server where that answer is wrong or unavailable, such
as one used only on a private network.

Outside Docker, point the API at a LiveKit server browsers can reach with
`LIVEKIT_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET`. For the sidebar to
see people join and leave, give LiveKit a webhook to
`/api/voice/webhook`, signed with the same key; `.env.example` shows the
config. Without it, the list only updates on page load, reconnect, or when you
join or leave yourself.

Networks that allow nothing but web traffic, such as some corporate and guest
networks, block both media ports. Reaching people on them needs TURN over TLS
on port 443, which this setup does not include yet;
[docs/voice-turn.md](docs/voice-turn.md) is the plan for adding it.

Joining is authorised the same way everything else is: the server mints a
LiveKit token scoped to one room, named for the channel id, only after checking
workspace membership. The token is the only way into a room, identity is the
user id so a second tab replaces the first rather than appearing twice, and it
expires after six hours.

In the desktop app, screen sharing goes through the macOS system picker where
that exists and an explicit list of windows elsewhere — never an automatic
choice, since which screen you reveal should always be deliberate.

## Tabs

The strip across the top of the window holds tabs. Each is a place in the app:
a document, canvas, spreadsheet, chat or All Documents, in any workspace.
⌘/Ctrl-click a document or workspace in the sidebar to open it in a new tab.
**New tab** opens a blank one; middle-click or × closes one; drag to reorder;
right-click to close the others. When the open tabs span more than one
workspace, each tab is marked with its workspace, so switching tabs never moves
you somewhere without saying so.

Only the tab in front is mounted. A background tab keeps its address and its
label, not a live collaboration session and chat socket, so a bar full of tabs
costs what one does. Up to 24 tabs are kept, and they are remembered between
sessions. A call is not tied to any tab. It belongs to the session, and keeps
running whichever tab you move to.

## Notifications

The bell collects what is waiting for you:

- **Messages** — unread messages in channels and direct conversations
- **Mentions** — documents and canvases where someone tagged you
- **Invitations** — invites made out to your email address, which you can
  accept or decline in place

Clicking an item opens it in the current tab or a new one, as set under
**Settings → Appearance**; holding ⌘ or Ctrl does the other. **Mark all as read**
clears the lot. In the desktop app, the bell gathers notifications from every
server you are signed in to.

## Users, roles and sharing

A workspace has members, each with one role. Every workspace starts with four:

| Role     | Can do                                                        |
| -------- | ------------------------------------------------------------- |
| Owner    | Everything, including deleting the workspace. Built in         |
| Admin    | Everything but deleting the workspace: people, roles, locks and settings. Built in |
| Editor   | Create and edit content in every app                           |
| Viewer   | Read, search and comment on documents; post in chat            |

Owner and Admin are fixed. Every other role, Editor and Viewer included, is a
set of permissions that owners and admins choose under **Access → Roles**, and
they can add as many roles as they like: one that writes documents but never
touches chat or projects, one that works on queue requests without being able to
change how the queue is set up, one that never sees Sheets at all. Permissions
cover each app separately — seeing it, commenting, editing, creating and
deleting, and for projects and queues (held apart) working on items, running
sprints, configuring them and deleting them — plus inviting people, managing
the members of teams and managing uploads. One that needs another brings it along: deleting
documents needs editing them, which needs seeing them.

Some things stay with owners and admins whatever a role says: locks, roles,
who holds which role, removing people, making, renaming and deleting teams, the
workspace's name, picture and apps, and getting past a workflow's rules. Someone whose role lets them invite people
can only invite with a role that allows nothing theirs does not.

New invites start with the role marked as the default, Editor to begin with. A
role in use can be deleted by choosing the role its members and pending invites
move to.

A workspace always keeps at least one owner: the last one cannot be demoted or
removed. Non-members get `404` rather than `403` so workspace ids stay unguessable.

**Inviting people.** This server does not send email. Anyone whose role allows
it creates an invite from the Members panel, choosing the role it joins with,
and gets a link to pass along:

- with an email address — single use, and only that address may redeem it. If
  that address already has an account, the invitation also appears in its
  notifications bell.
- without one — a shareable link anyone can use until it expires (14 days default)

### Teams and access

**Teams** are named groups of members, under **Access → Teams**, so access can
be given to a group in one line instead of a list of people. Everyone in a
workspace can see who is on which team. Owners and admins make, rename and
delete teams, and can put anyone on one or take them off — themselves included.
A role with **Manage team members** lets someone else add and remove other
people on the teams they are on themselves, but never their own place, and
never on a team they are not on: joining a team an allow list names, or leaving
one a deny list names, would get them past a lock.

Teams and roles do different jobs. A team says whose things are whose, by being
named on a lock. A role says what kind of work someone does, everywhere in the
workspace.

**Locks.** Everything in a workspace is open to all its members until someone
locks it. Owners and admins can lock a folder, a document or a channel in one
of two ways:

- **Allow list** — only the teams and people listed get in, each able to view or
  edit
- **Deny list** — everyone gets in except those listed, each kept out entirely
  or limited to viewing

On a text channel the two levels read as *read only* and *can post*, and on a
voice channel as *listen only* and *can speak*. A locked item shows a padlock.

Folders and documents inherit by default: they take the setting of the nearest
folder above them that has one, so locking a folder covers everything filed
under it, and a document or subfolder with a setting of its own overrides it. A
channel has no folder, so it is open or locked on its own, and a direct
conversation is only ever its two people.

A list gives a person the level of the line naming them. With no such line, it
gives the most any of their teams gets, and failing that, nothing on an allow
list and everything on a deny list. Roles still set a ceiling: someone whose
role cannot edit documents never gets past viewing one, and someone whose role
cannot post in chat never gets past reading, whatever a list says. A lock only
ever narrows what a role allows. Owners and admins are never kept out, so a lock
can always be undone.

The rules live in the database as SQL functions, so listings, search, links in
chat and notifications only return what the reader may see, and a link to a
locked document does not give its title away. Changing a lock, a team or
someone's role takes effect straight away: open channel subscriptions, editing
sessions and calls are checked again rather than trusting the access that was
granted when they opened.

## Managing uploads

Owners, admins and anyone whose role lets them manage uploads get an **Uploads**
section in Access listing the workspace's
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

Files shared in chat are not listed here. They belong to their message, and are
removed with it, or with their channel or workspace.

One limitation worth knowing: a file is judged unattached purely by whether a
document owns it. Removing the *element* that used a file, without deleting its
document, leaves the file counted as attached.

## Real-time collaboration

Documents are edited collaboratively over Yjs. The browser opens a websocket to
`/collab` on the same origin, so the session cookie authenticates it; the server
then checks workspace membership and access per document and marks read-only
connections as such. Spreadsheets share the same socket: the collaboration
server tells one from a document by a `sheet:` prefix on the name, and loads and
saves it from the `spreadsheets` table instead.

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

Any number of OpenID Connect providers — Google, Microsoft Entra, Keycloak,
Authentik, Okta and so on — can sit alongside email and password. Add them on
the server admin page under **Single sign-on**; each gets a button on the
sign-in screen. One provider can also be given with the `OIDC_*` settings, and
the admin page shows it read-only. That one is on only with `OIDC_ENABLED=true`:
before single sign-on worked, the `OIDC_*` settings could be filled in ahead of
time, and an upgrade should not turn on a new way in by itself. Should you have
copied the old example `OIDC_REDIRECT_URI=http://localhost:4000/api/auth/oidc/callback`,
remove it; the server warns at startup while it is set.

1. Set `PUBLIC_URL` to the address people reach ParaDOCs at.
2. At the provider, register a client with the redirect URI the admin page shows:
   `$PUBLIC_URL/api/auth/oidc/<short name>/callback`.
3. Enter the issuer URL, client ID and secret. The issuer's discovery document is
   fetched when you save, so a typo shows up then.

Step-by-step setup for Google, Entra ID, Keycloak, Authentik, Authelia, Okta,
Auth0, GitLab and Zitadel is in
[docs/single-sign-on-providers.md](docs/single-sign-on-providers.md).

Queues can also take in work from web forms and other systems through an intake
webhook. It is off until turned on under Server settings; see
[docs/intake-webhook.md](docs/intake-webhook.md).

Signing in uses the authorization code flow with PKCE, state and nonce. The
account it signs in to is, in order: the one already linked to that provider
subject; an existing account with the same email, **only** when the provider
marks the email verified; or a new account. Each provider decides who may get a
new account — follow the registration setting, always (for your own identity
provider, even with registration closed), or never — and can be limited to
certain email domains.

Microsoft Entra ID sends no `email_verified`, so by default it can sign in only
accounts already linked to it. Two ways round that:

- Add the optional `xms_edov` claim to the app registration's ID token. ParaDOCs
  takes `xms_edov: true` as a verified email, from any provider.
- Turn on **Trust this provider's email addresses** for it. That needs allowed
  domains, and should be used only with a single-tenant issuer
  (`https://login.microsoftonline.com/<tenant id>/v2.0`) whose accounts in those
  domains your organisation controls: Entra lets an email claim carry addresses
  the tenant does not own, as with guest accounts.

To sign in with single sign-on only, turn off **Allow signing in with email and
password** under Server settings on the admin page. The app then refuses
password sign-in and registration and shows only the provider buttons. To stop
it locking everyone out:

- It cannot be turned off unless a provider is on and its discovery document can
  be reached at that moment.
- While it is off, the last provider that is on cannot be turned off or removed.
- If no provider is on anyway (say the `OIDC_*` settings were removed), password
  sign-in comes back by itself, and a warning is logged.
- The admin page always signs in with a password, so an administrator can turn
  it back on.

Accounts not yet linked to a provider are linked on their first single sign-on,
when the provider confirms the same email; the admin page says how many there are.

Client secrets are stored encrypted with a key derived from `SESSION_SECRET`;
changing that secret means entering them again.

The desktop and mobile apps sign in through the system browser. It ends on a
page naming the account and server, whose **Open ParaDOCs** link hands the
sign-in back on a `paradocs://auth` address. The app redeems the one-time code
there with a verifier it never sent anywhere, so another app that catches the
address cannot use it. The link is never followed by itself: another app
registered for `paradocs://` could start a sign-in of its own, which a provider
you are already signed in to would finish without asking, so the person has to
confirm it was them.

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

Spreadsheets have their own table. Each row holds the grid's Y.Doc, plus the
cells' text in `search_text`, which is indexed with the title. Computed values
are never stored; they are derived from the formulas whenever the grid is
drawn, including on the server when a document shows a spreadsheet's cell or
chart.

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

**Pop-out windows.** A channel or direct conversation can be popped out into a
window of its own. The window leaves out the sidebars and search and keeps
what makes the conversation live: its own chat socket, so messages and typing
arrive there directly. A call can go with it. Audio and video belong to the
window playing them, so the call moves rather than copies: the main window
leaves as the pop-out joins, and handing the conversation back reverses that.

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

- Node.js 20.19+ or 22.12+
- PostgreSQL 14+ (uses `pgcrypto` and `pg_trgm`, both in contrib)

## Running it

### Docker (recommended for self-hosting)

For a step-by-step walkthrough, including HTTPS, voice, backups, upgrades and
troubleshooting, see [docs/deploying-with-docker.md](docs/deploying-with-docker.md).
The short version:

```bash
mkdir paradocs && cd paradocs
curl -fsSLO https://raw.githubusercontent.com/ParadoxRelativity/ParaDOCs/main/docker-compose.yml

# Both secrets are required; compose refuses to start without them.
cat > .env <<EOF
POSTGRES_PASSWORD=$(openssl rand -hex 24)
SESSION_SECRET=$(openssl rand -hex 32)
EOF

docker compose up -d
```

Open <http://localhost:4000> and register. That is the whole deployment:
`docker-compose.yml` and `.env` are the only files on the server, and there is
no need to clone the repository. The compose file runs the prebuilt
[`paradoxrelativity/paradocs`](https://hub.docker.com/r/paradoxrelativity/paradocs)
image from Docker Hub alongside Postgres, and LiveKit for voice and video. The
image serves the web client, the API and the collaboration websocket, so there
is no reverse proxy to configure for the basic case. For calls, open UDP 7882
and TCP 7881 as well (see [Voice and video](#voice-and-video)).

**Serving it on a domain with HTTPS.** The `https` profile adds Caddy, which
obtains and renews certificates automatically:

```bash
# in .env
COMPOSE_PROFILES=https
DOMAIN=docs.example.com
BIND_ADDR=127.0.0.1     # keep the app off the public interface
SECURE_COOKIES=true     # required once traffic is HTTPS
```

Then run `docker compose up -d`. Point the domain at the host first, or the
certificate order fails.

**Upgrading** is `docker compose pull` then `docker compose up -d`. Migrations
are idempotent and run on boot, so there is no separate step. If you ever run
more than one app replica, run migrations once out of band instead, so two
containers do not apply them at the same time.

**What the image contains.** A multi-stage build: the web client is compiled in
a build stage, and the runtime stage installs only production dependencies. The
API runs from TypeScript source through `tsx`, which is therefore a runtime
dependency rather than a dev tool. The server-side Yjs to markdown conversion
pulls BlockNote and ProseMirror in, so the runtime dependency tree is around
250 MB — most of the image.

To run a change before it is released, build the image under the same name from
a checkout with `docker build -t paradoxrelativity/paradocs:latest .`, then run
`docker compose up -d`. The next `docker compose pull` puts the published
release back.

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

The server admin page — server-wide settings and account management — is at
<http://localhost:5173/admin.html> in development, proxied to the admin port. In
production it is served only on its own port (`ADMIN_PORT`, 4001 by default),
listening on loopback. The first account to sign in there, or to be created
there, becomes the server's administrator.

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
| `ALLOW_REGISTRATION` | `true`                  | Whether signups start open, until changed on the server admin page; the first account is always allowed |
| `ADMIN_ENABLED`      | `true`                  | Set `false` to not serve the server admin page               |
| `ADMIN_PORT`         | `4001`                  | Port for the server admin page: server-wide settings and accounts |
| `ADMIN_HOST`         | `127.0.0.1`             | Interface the admin page listens on; keep it internal        |
| `ADMIN_SECURE_COOKIES` | `false`               | Set `true` only if the admin page itself is served over HTTPS |
| `MAX_UPLOAD_MB`      | `25`                    | Largest file, in megabytes, for chat, documents and canvases; not adjustable per workspace |
| `VOICE_ENABLED`      | `true`                  | Set `false` to turn off voice channels and calls             |
| `LIVEKIT_URL`        | —                       | Outside Docker: a LiveKit server browsers can reach          |
| `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | generated in Docker | Fixed LiveKit keys; set both or neither          |
| `LIVEKIT_NODE_IP`    | —                       | Docker: the public address for call media, where STUN gets it wrong |
| `PUBLIC_URL`         | —                       | The address people reach ParaDOCs at; needed for single sign-on redirect URIs |
| `OIDC_*`             | —                       | One single sign-on provider from the environment, on with `OIDC_ENABLED=true` (see above and `.env.example`) |

`docker-compose.yml` also reads `POSTGRES_PASSWORD`, `COMPOSE_PROFILES`, `PORT`,
`BIND_ADDR` and `DOMAIN`; `.env.example` describes each one.

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
| `/`            | Block commands in the editor, including spreadsheet cells and charts |
| `@` / `#`      | Tag a person / link a channel, in the editor |
| `⌘`/`Ctrl`-click | Open a document or workspace in a new tab |
| Middle-click   | Close a tab            |

## Layout

```
apps/api        Fastify + node-postgres. Raw SQL, numbered migrations.
apps/web        React SPA. Vite, TanStack Query, BlockNote, Tailwind.
apps/desktop    Electron shell for macOS and Windows. Bundles apps/web and,
                for local workspaces, apps/api on PGlite.
packages/shared TypeScript types, zod schemas, and the spreadsheet formula
                engine, used by both sides.
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

**The server image** is built by the same tag for both `linux/amd64` and
`linux/arm64`, and pushed with the same tags to Docker Hub and the GitHub
Container Registry:

```
paradoxrelativity/paradocs:0.1.1           # Docker Hub: the exact release
paradoxrelativity/paradocs:0.1             # latest patch of a minor version
paradoxrelativity/paradocs:latest
ghcr.io/paradoxrelativity/paradocs:0.1.1   # GitHub Container Registry: the same tags
```

`docker-compose.yml` runs `paradoxrelativity/paradocs:latest`, so servers pick
up a release with `docker compose pull` and `docker compose up -d`.

Pushing to Docker Hub needs two repository secrets, under *Settings → Secrets
and variables → Actions*:

- `DOCKERHUB_USERNAME`: the Docker Hub account that pushes.
- `DOCKERHUB_TOKEN`: a personal access token for that account with *Read &
  Write* access, created on Docker Hub under *Account settings → Personal access
  tokens*. Use a token, not the account password.

Without them the job still pushes to ghcr.io, and the run shows a warning that
Docker Hub was skipped. Create the `paradoxrelativity/paradocs` repository on
Docker Hub before the first release and make it **public**: the compose file
pulls it without logging in. If `paradoxrelativity` is an
organisation, the account behind the token needs write access to the repository.

Running the workflow by hand from the Actions tab pushes only
`sha-<commit>`, which is useful for trying a build on a test server without
moving `latest`. Unlike the desktop installers, a pushed image is visible as
soon as the job finishes — there is no draft step — so `latest` moves when the
tag is pushed, not when the release is published.

On ghcr.io, the first push creates the package as **private**, even for a
public repository. To let a server pull it without logging in, open the package under
your GitHub profile's *Packages*, then *Package settings* → *Change
visibility* → *Public*. This only has to be done once.

To cut a release without CI, build locally and attach the files from
`apps/desktop/release/` — including `latest-mac.yml` and `latest.yml`, without
which nothing can update:

```bash
npm run desktop:dist:mac
npm run desktop:dist:win
```

## License

AGPL-3.0-or-later. The full text is in [LICENSE](LICENSE).
