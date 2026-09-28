# AI connections (MCP)

AI assistants such as Claude, ChatGPT and Cursor can work in ParaDOCs through its
MCP server, one address for the whole server:

```
$PUBLIC_URL/api/mcp
```

An assistant can search and read documents, spreadsheets and chat. With write
access it can also write documents, create, move, reassign and comment on work
items, and post messages. It acts as the person who connected it and can do no
more than they can: roles, locks and apps that are turned off all apply as usual.

## Turning it on

AI connections are off by default. While they are off, `/api/mcp` and the sign-in
endpoints answer 404, and existing connections do nothing.

1. Set `PUBLIC_URL` to the address people reach ParaDOCs at. Assistants that sign
   in are sent to addresses built from it.
2. On the admin page, under **Server settings**, turn on **AI connections**.

After that, each person connects their own assistants under **Settings → AI
connections**.

## Connecting an assistant

There are two ways to connect. Each connection covers either every workspace
the person is in or just one, and can be read-only or read-and-change. It is
listed under Settings → AI connections, where it can be revoked.

### By signing in (no key)

Clients that support MCP sign-in, such as claude.ai and the Claude apps (on any
plan, including Pro and Max subscriptions, with no API key), ChatGPT, and
Claude Code, need only the address. The client sends the person to ParaDOCs,
where they sign in if needed and choose what the assistant may reach.

- **Claude**: Settings → Connectors → Add custom connector, and paste
  `$PUBLIC_URL/api/mcp`.
- **Claude Code**: `claude mcp add --transport http paradocs $PUBLIC_URL/api/mcp`,
  then run `/mcp` in a session to sign in.
- **ChatGPT**: add a custom connector (developer mode) with the same address.

### With a key (bring your own key)

For clients that take a header rather than signing in, or for scripts, make a
key under Settings → AI connections. It is shown once, and only its hash is
stored.

```sh
claude mcp add --transport http paradocs https://paradocs.example.com/api/mcp \
  --header "Authorization: Bearer pdk_…"
```

Clients that read a JSON config, such as Cursor or VS Code:

```json
{
  "mcpServers": {
    "paradocs": {
      "type": "http",
      "url": "https://paradocs.example.com/api/mcp",
      "headers": { "Authorization": "Bearer pdk_…" }
    }
  }
}
```

## From a board into Claude Code

The server also provides two prompts, which Claude Code shows as slash commands:

- `/mcp__paradocs__work_on_item ENG-12` loads the item, with its description and
  comments, into the session. The instructions ask Claude to assign it to you,
  move it to in progress, do the work, then comment with what changed and move it
  to review or done.
- `/mcp__paradocs__next_up ENG` looks over a project's open work and suggests
  what to pick up next.

So you can plan future updates on a ParaDOCs board and pull them one at a time
into a coding session. The board stays current as the work is done.

## Tools

| Tool                   | Does                                                             |
| ---------------------- | ---------------------------------------------------------------- |
| `list_workspaces`      | The workspaces the connection can reach                          |
| `search`               | Full-text search over documents, spreadsheets and work items     |
| `list_documents`       | Documents in a workspace, newest first                           |
| `read_document`        | A document as markdown, by id or title                           |
| `create_document`\*    | A new document from markdown                                     |
| `update_document`\*    | Retitle, or replace or append to the body with markdown          |
| `read_spreadsheet`     | A spreadsheet's cells as text                                    |
| `list_projects`        | Boards and queues, with their keys                               |
| `get_project`          | Statuses, types, roles and sprints                               |
| `list_work_items`      | A board's current work, by status, with filters                  |
| `find_work_items`      | Your work, or a query, across every project                      |
| `get_work_item`        | An item in full, with comments                                   |
| `create_work_item`\*   | New work, with type, status, priority, assignee and dates        |
| `update_work_item`\*   | Move, retitle, rewrite, reprioritise or reassign                  |
| `comment_on_work_item`\* | Add a comment                                                  |
| `list_channels`        | Chat channels                                                    |
| `read_channel`         | A channel's latest messages                                      |
| `post_message`\*       | Post to a channel                                                |

\* Only offered to connections that can change things.

Tools take names as a person would say them: workspaces by name, projects by key,
work items by key (`ENG-12`), and statuses and types by name.

Keys are unique within a workspace, not across them. If you are in two
workspaces that both have an `ENG` project, a tool given `ENG-12` asks which
workspace you mean rather than guessing. Every tool and both prompts take an
optional `workspace` for this, e.g. `/mcp__paradocs__work_on_item ENG-12 Acme`.
A connection limited to one workspace never has to ask. A project key takes
precedence over another project's name, so `ENG` finds the project keyed ENG
even if another project is named "Eng".

If someone has a document open while an assistant writes to it, the change
appears in their editor straight away and is saved like any other edit.

## Limits and safety

- A connection's key or token works only at `/api/mcp`. Anywhere else in the API
  it is refused, so an assistant cannot change a password, make more keys, or do
  anything the tools do not offer. A read-only connection changes nothing.
- Keys do not expire. Revoke them when they are no longer needed. Signed-in
  clients use access tokens that last an hour and refresh tokens that are
  replaced each time they are used. A client unused for 90 days has to sign in
  again.
- When a server administrator disables an account, resets its password or signs
  it out, its AI connections are revoked as well. Changing your own password does
  not revoke them.
- Clients register themselves, as the MCP specification expects, but can do
  nothing until a person approves them. Redirect addresses must be https,
  localhost, or an app's own scheme, and must match exactly what the client
  registered. PKCE (S256) is required.
- Each connection can make 240 requests a minute. Registering clients and
  exchanging tokens are limited to 60 a minute from one address.

## Protocol details

The server speaks MCP's Streamable HTTP transport statelessly. Each POST carries
JSON-RPC and gets a JSON reply, and GET answers 405. It supports protocol
versions 2024-11-05 through 2025-11-25. An unauthenticated request gets 401 with
a `WWW-Authenticate` header pointing at
`/.well-known/oauth-protected-resource/api/mcp` (RFC 9728). The authorization
server metadata is at `/.well-known/oauth-authorization-server` (RFC 8414), with
dynamic client registration at `/api/oauth/register` (RFC 7591) and revocation
at `/api/oauth/revoke` (RFC 7009).

In development, set `PUBLIC_URL=http://localhost:5173` so sign-in goes through
the Vite server, which proxies `/api` and `/.well-known` to the API.
