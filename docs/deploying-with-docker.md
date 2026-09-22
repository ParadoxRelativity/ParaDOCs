# Deploying ParaDOCs with Docker

This guide takes a ParaDOCs server from an empty machine to running, then covers
HTTPS, voice and video, backups, upgrades and troubleshooting.

A deployment is two files, `docker-compose.yml` and `.env`. There is no
repository to clone and nothing to build: the app runs as a prebuilt image from
Docker Hub, and the compose file carries the configuration for everything else.

It runs up to four containers:

- **app** runs the API, the web client, collaborative editing and chat, all on
  one port.
- **db** is Postgres. It is never published outside Docker.
- **caddy** (optional) serves HTTPS and renews certificates automatically.
- **livekit** carries voice, video and screen sharing.

Placeholders used below: `docs.example.com` for your domain and `203.0.113.10`
for your server's public IP address.

## 1. Before you start

You need:

- A Linux server, amd64 or arm64, with Docker Engine and the Compose plugin,
  version 2.23.1 or newer. Check with `docker compose version`. The older
  `docker-compose` command is not supported.
- `curl` and `openssl`, which most servers already have.
- For HTTPS: a domain whose DNS A (and AAAA, if you use IPv6) record points at
  the server.

Ports, depending on which parts you run:

| Port | Protocol | Used for | Open to the internet? |
| ---- | -------- | -------- | --------------------- |
| 4000 | TCP | The app, in the plain HTTP setup | Only without HTTPS |
| 80, 443 | TCP | Caddy, in the HTTPS setup | Yes |
| 7881 | TCP | Voice media, fallback when UDP is blocked | Yes, unless voice is off |
| 7882 | UDP | Voice media | Yes, unless voice is off |
| 4001 | TCP | Server admin page, published on `127.0.0.1` only | No. Reach it over SSH (section 5). |

## 2. Get the compose file

```bash
mkdir paradocs && cd paradocs
curl -fsSLO https://raw.githubusercontent.com/ParadoxRelativity/ParaDOCs/main/docker-compose.yml
```

Run every `docker compose` command in this guide from this directory.

The file runs the app image,
[`paradoxrelativity/paradocs`](https://hub.docker.com/r/paradoxrelativity/paradocs),
and includes the Caddy and LiveKit configuration. Your own settings go in
`.env`, so the compose file itself never needs editing.

## 3. Create `.env`

Compose reads settings from a file named `.env` beside `docker-compose.yml`.
Create it with the two required secrets:

```bash
cat > .env <<EOF
POSTGRES_PASSWORD=$(openssl rand -hex 24)
SESSION_SECRET=$(openssl rand -hex 32)
EOF
chmod 600 .env
```

- **Keep the password to letters and digits** (the command above uses hex). It is
  placed inside a database connection URL, where characters such as `@`, `/` and
  `:` break it.
- **The database password is fixed on first start.** Postgres sets it when it
  creates its data volume. Changing `POSTGRES_PASSWORD` later does not change the
  database's password; see Troubleshooting if you need to.
- **Each setting goes in once.** When a later step changes a setting that is
  already in `.env`, edit that line rather than adding a second one.

Settings Compose reads from `.env`:

| Variable | Default | Purpose |
| -------- | ------- | ------- |
| `POSTGRES_PASSWORD` | — | Database password. Required. |
| `SESSION_SECRET` | — | At least 32 characters. Required. |
| `COMPOSE_PROFILES` | — | `https` to run Caddy (section 4) |
| `PORT` | `4000` | Host port the app is published on |
| `BIND_ADDR` | `0.0.0.0` | Interface the app is published on. Use `127.0.0.1` behind HTTPS. |
| `SECURE_COOKIES` | `false` | `true` in the HTTPS setup. Must stay `false` over plain HTTP. |
| `TRUST_PROXY` | `false` | `true` in the HTTPS setup, so rate limits see client addresses. Leave `false` when the app is published directly. |
| `ALLOW_REGISTRATION` | `true` | Whether sign-ups start open, until changed on the admin page (section 5) |
| `ADMIN_ENABLED` | `true` | Set `false` to not serve the server admin page |
| `ADMIN_PORT` | `4001` | Host port the server admin page is published on |
| `ADMIN_BIND_ADDR` | `127.0.0.1` | Interface the admin page is published on. Keep it `127.0.0.1`. |
| `MAX_UPLOAD_MB` | `25` | Largest file people can upload, in megabytes, to chat, documents and canvases |
| `UPDATE_CHECK` | `true` | Whether the server checks GitHub for new releases (section 9). Set `false` to never contact GitHub. |
| `LOG_LEVEL` | `info` | App log detail: `error`, `warn`, `info` or `debug` |
| `DOMAIN` | — | HTTPS setup: the hostname Caddy gets a certificate for |
| `VOICE_ENABLED` | `true` | Set `false` to turn voice and video off (section 6) |
| `LIVEKIT_NODE_IP` | found automatically | Voice: the public address browsers send media to (section 6) |
| `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | generated | Voice: fixed keys instead of generated ones. Set both or neither. |

## 4. Start the server

Pick one setup.

### Option A: plain HTTP

For a trusted local network, or to try ParaDOCs out.

```bash
docker compose up -d
```

The first start downloads the images. When `docker compose ps` shows the app as
`healthy`, open `http://203.0.113.10:4000`.

Limits of plain HTTP:

- Everything, passwords included, crosses the network unencrypted.
- Browsers only allow the microphone and camera on HTTPS pages, so voice and
  video will not work in a browser. They do work in the desktop app, which is
  not affected by this.

### Option B: HTTPS with Caddy (recommended)

For anything reachable from the internet.

1. Point your domain's DNS at the server and wait until it resolves. Caddy's
   certificate request fails if it does not.
2. Make sure ports 80 and 443 are open.
3. Add to `.env`:

   ```bash
   # Runs Caddy with every docker compose command.
   COMPOSE_PROFILES=https
   DOMAIN=docs.example.com
   # Keeps the app's own port off the public interface; only Caddy reaches it.
   BIND_ADDR=127.0.0.1
   # Session cookies must be marked Secure once traffic is HTTPS.
   SECURE_COOKIES=true
   # Only Caddy reaches the app, so its X-Forwarded-For can be believed, and
   # sign-in rate limits count each person's address rather than Caddy's.
   TRUST_PROXY=true
   ```

4. Start everything:

   ```bash
   docker compose up -d
   ```

Open `https://docs.example.com`. Caddy obtains the certificate on first start
and renews it automatically.

## 5. Create your account

Open the site and register. The first account can always be created, and
starts with a workspace called Personal.

### The server admin page

Settings for the whole server, and every account on it, are managed from a
separate admin page. It has its own port, 4001, which Compose publishes on
`127.0.0.1` only, so it is never reachable from the internet. From your own
computer, open an SSH tunnel to the server:

```bash
ssh -L 4001:127.0.0.1:4001 you@203.0.113.10
```

and, while it is open, visit `http://localhost:4001`.

Nobody administers a new server until someone claims it. On that first visit,
either sign in with the account you just registered, which makes it the
administrator, or create a new administrator account on the spot. After that
only administrators can sign in there, and they can make other accounts
administrators. Signing in to the admin page is separate from signing in to
the app.

From the admin page you can:

- **Open or close registration.** Closed, nobody can sign up on their own;
  create accounts for people from **Accounts** instead. `ALLOW_REGISTRATION`
  in `.env` only sets where registration starts, until it is changed here.
- **Set a message retention maximum.** Messages in text channels older than the
  limit, and files shared in them, are permanently deleted, checked hourly.
  Direct messages are kept.
- **Manage accounts:** create them, rename them, set their passwords, sign them
  out everywhere, disable or delete them, and grant or remove administrator
  access.

Closing registration also stops invited people from creating an account: they
need one before they can accept an invitation. Create their accounts from the
admin page, or reopen registration while they sign up.

Until someone claims it, anyone who can reach port 4001 can become the
administrator. Claim it as soon as the server is up, and leave
`ADMIN_BIND_ADDR` at `127.0.0.1`.

## 6. Voice and video

Voice channels, video and screen sharing work out of the box. The **livekit**
container starts with everything else, and new workspaces come with a voice
channel called **lounge** beside `#general`. There are no keys to create: the
app generates them on first start and shares them with LiveKit. There is no
extra address or port for browsers either, because the app relays LiveKit's
connection setup on its own address, and over HTTPS in the HTTPS setup.

What voice does need is a way in for the call audio and video themselves, which
go straight to LiveKit rather than through the app or Caddy:

1. **Open the firewall** for UDP 7882 and TCP 7881. TCP is the fallback for
   networks that block UDP. On a home or office network behind a router,
   forward both ports to the server.
2. **Check that it works.** Open the Chat tab and join **lounge** from two
   devices, ideally on different networks. If joining fails,
   `docker compose logs livekit` is the first place to look.

Browsers only allow the microphone and camera on HTTPS pages, so in the plain
HTTP setup, calls work in the desktop app but not in a browser (section 4).

### The address browsers send media to

LiveKit has to tell each browser where to send media, so as it starts it asks a
public STUN server what this host's address looks like from the internet. That
is the right answer for a server with a public IP address, and for one behind a
router with the ports forwarded. Set the address yourself in `.env` when it is
not, then run `docker compose up -d`:

```bash
LIVEKIT_NODE_IP=192.168.1.20
```

- **A server used only inside a private network**, where people reach it at
  its local address.
- **A server that cannot reach the internet.** The STUN request fails, and
  LiveKit does not start until the address is set.

### Turning voice off

Set this in `.env`, then run `docker compose up -d`:

```bash
VOICE_ENABLED=false
```

Voice channels disappear from the sidebar and new workspaces no longer get a
lounge. The livekit container keeps running but receives nothing;
`docker compose stop livekit` stops it until the next `docker compose up`.

### Existing workspaces and earlier setups

Only workspaces created while voice is on get a lounge. In older ones, an owner
or admin adds a voice channel from the Chat sidebar.

Earlier versions needed voice set up by hand. If your `.env` came from one,
remove `LIVEKIT_URL`, `LIVEKIT_BIND` and `LIVEKIT_PORT`: a `LIVEKIT_URL` with
port 7880 in it points at a port that is no longer published, and joining a
call fails with "Could not reach the voice service at …". While it is set,
`docker compose logs app` shows a warning about it at startup. `voice` in
`COMPOSE_PROFILES` no longer does anything and can go too. `LIVEKIT_API_KEY`
and `LIVEKIT_API_SECRET` can stay: when set, they are used instead of generated
keys. Then replace `docker-compose.yml` as described in section 9.

LiveKit tells the app when people join and leave a voice channel, through a
webhook set up in `docker-compose.yml`. With a `docker-compose.yml` from before
that was added, the Chat sidebar only updates who is in a voice channel when the
page loads or reconnects, or when you join or leave one yourself. Replace it as
described in section 9.

All call media uses the single UDP port 7882, however many people are in calls.
The port numbers are what browsers are told, so they are best left as they are.

People on networks that allow only web traffic, such as some corporate and
guest Wi-Fi, cannot reach ports 7881 or 7882. That needs TURN over TLS, which is
not set up yet; [voice-turn.md](voice-turn.md) is the plan.

## 7. Connecting the desktop app

In the desktop app, open the workspace menu at the top of the sidebar and choose
**Connect to a server…**.

- For the HTTPS setup, enter the domain: `docs.example.com`. An address without
  `http://` or `https://` is treated as HTTPS.
- For the plain HTTP setup, enter the full address, including the port:
  `http://203.0.113.10:4000`.

The app checks the address before saving it. It refuses self-signed
certificates, so a server reached over HTTPS needs a real certificate, which
Caddy provides.

## 8. Backups

Your data lives in two Docker volumes, which should be backed up together:

- `paradocs_db-data`: the Postgres database.
- `paradocs_uploads`: attached files and profile pictures.

In the HTTPS setup, Caddy also keeps certificates in `paradocs_caddy-data`.
Losing that volume only means Caddy requests new certificates.

### Taking a backup

```bash
mkdir -p backups
docker compose exec -T db pg_dump -U paradocs paradocs | gzip > "backups/paradocs-$(date +%F).sql.gz"
docker run --rm -v paradocs_uploads:/data:ro -v "$PWD/backups":/backup alpine \
  tar czf "/backup/uploads-$(date +%F).tar.gz" -C /data .
```

- Run both back to back. For a guaranteed-matching pair, run
  `docker compose stop app` first and `docker compose start app` afterwards.
- Keep a copy of `.env` with your backups.
- Copy `backups/` off the server. Tools such as restic or rclone can send it to
  Backblaze B2, S3 or a NAS on a schedule.

### Restoring

This replaces the current database and files with the backup. Replace
`2026-09-11` with the date of the backup you are restoring.

```bash
docker compose stop app

docker compose exec -T db psql -U paradocs -d postgres \
  -c 'DROP DATABASE paradocs' -c 'CREATE DATABASE paradocs'
gunzip -c backups/paradocs-2026-09-11.sql.gz | docker compose exec -T db psql -U paradocs -d paradocs

docker run --rm -v paradocs_uploads:/data -v "$PWD/backups":/backup alpine \
  sh -c 'rm -rf /data/* && tar xzf /backup/uploads-2026-09-11.tar.gz -C /data'

docker compose start app
```

The app applies any database migrations the backup is missing when it starts,
so a backup from an older version restores into a newer one. Try a restore on a
spare machine now and then, so you know your backups work before you need them.

## 9. Upgrading

The server checks GitHub for a new release shortly after it starts and every six
hours after that. When one is out, server administrators see it in their
notifications in the app and at the top of **Server settings** on the admin page,
with a link to the release notes. Nobody else is told. Set `UPDATE_CHECK=false`
in `.env` to turn the check off. Browsers that had the app open while you
upgraded offer a reload, so nobody keeps running the old page.

**Back up first** (section 8). Then:

```bash
docker compose pull
docker compose up -d
```

`pull` downloads the newest release of the app, along with updates to the
Postgres and Caddy images, and `up -d` restarts whichever containers changed.
Run `pull` first: `up -d` on its own keeps the images already on the server.

Database migrations run automatically when the app starts; there is no separate
step. Afterwards, check that `docker compose ps` shows the app as `healthy`.

Each release publishes the image for amd64 and arm64. Besides `latest`, it is
tagged with its full version (`0.4.0`) and minor version (`0.4`), and the same
image is on the GitHub Container Registry as
`ghcr.io/paradoxrelativity/paradocs`.

### When a release changes `docker-compose.yml`

Most releases only change the image. When a release's notes say the compose file
changed too, download it again over the old one. Your settings are in `.env`,
so nothing is lost:

```bash
curl -fsSLO https://raw.githubusercontent.com/ParadoxRelativity/ParaDOCs/main/docker-compose.yml
docker compose pull
docker compose up -d --force-recreate
```

`--force-recreate` matters here. Caddy's and LiveKit's configuration live inside
the compose file, and Compose does not restart a container when only that
configuration changes.

### Going back to an earlier release

Change `latest` in the app's `image:` line to the version you want, such as
`paradoxrelativity/paradocs:0.4.0`, and run the upgrade commands. A database
that a newer version has already migrated may not work with an older one, so
also restore the backup you took before upgrading. Change the line back to
`latest` to resume normal upgrades.

## 10. Everyday commands

| Task | Command |
| ---- | ------- |
| Status and health | `docker compose ps` |
| Follow the app's logs | `docker compose logs -f app` (also `db`, `caddy`, `livekit`) |
| Restart the app | `docker compose restart app` |
| Apply `.env` changes | `docker compose up -d` |
| Upgrade | `docker compose pull && docker compose up -d` |
| Stop everything, keeping data | `docker compose down` |
| Check the app from the server | `curl -s http://127.0.0.1:4000/api/health` |
| Open a database shell | `docker compose exec db psql -U paradocs paradocs` |

`docker compose down -v` also **deletes the volumes, and with them every document
and file**. Only use it to wipe a server on purpose.

## 11. Security checklist

- Use the HTTPS setup for anything reachable from the internet, with
  `BIND_ADDR=127.0.0.1` so the app is only reachable through Caddy.
- Keep `.env` private (`chmod 600`) and backed up somewhere safe.
- Claim the server admin page (section 5) as soon as the server is up, and keep
  it published on `127.0.0.1` only.
- Close registration once everyone who needs an account has one.
- Open only the ports your setup uses (section 1). Postgres is never published.
- Uploaded files, including files shared in chat, and profile pictures are
  served at long, unguessable addresses without a login check. Anyone who is
  given a file's link can open it.
- Upgrade regularly (section 9).

## 12. Troubleshooting

**`set POSTGRES_PASSWORD in .env` or `set SESSION_SECRET in .env`.** Compose did
not find the value. Check that `.env` is in the same directory as
`docker-compose.yml`, and that you run commands from there.

**An error about `content` under `configs`.** Compose is older than 2.23.1 and
does not understand the configuration embedded in the file. Update Docker.

**`pull access denied`, `manifest unknown` or `toomanyrequests` for
`paradoxrelativity/paradocs`.** Check that the server can reach Docker Hub. If
Docker Hub reports a pull rate limit, run `docker login` with any free Docker
account and try again. If you changed the image tag, check it exists on
[Docker Hub](https://hub.docker.com/r/paradoxrelativity/paradocs/tags).

**The app keeps restarting.** Run `docker compose logs app`. A message that
`SESSION_SECRET must be at least 32 characters` means the secret is too short.

**`password authentication failed for user "paradocs"`.** `POSTGRES_PASSWORD` was
changed after the database was first created. Put the original back, or set the
database to use the new one:

```bash
docker compose exec db psql -U paradocs -d paradocs \
  -c "ALTER USER paradocs PASSWORD 'the-new-password'"
docker compose up -d
```

**No certificate, or the site will not load over HTTPS.** Check that
`COMPOSE_PROFILES` includes `https` and `DOMAIN` is set in `.env`, that the
domain resolves to this server, and that ports 80 and 443 are open. Then look at
`docker compose logs caddy`.

**Signing in works but you are signed out straight away.** The session cookie is
marked for HTTPS only while the site is served over plain HTTP. Only the HTTPS
setup should have `SECURE_COOKIES=true`; remove it from `.env` in the plain HTTP
setup.

**`port is already allocated`.** Something else uses that port. For the app,
set `PORT` to a free one, such as `PORT=8080`.

**No Voice group in the sidebar.** Check that `VOICE_ENABLED` is not `false` in
`.env`. Then look in `docker compose logs app` for a line starting
`Voice is off`, which means the app could not write its key file to the
`paradocs_voice-keys` volume.

**LiveKit keeps restarting.** Run `docker compose logs livekit`.
`could not resolve external IP` means the STUN request failed: set
`LIVEKIT_NODE_IP` (section 6).

**Voice connects but nobody hears or sees anything, or joining never finishes.**
Media is not reaching LiveKit. Check that:

- UDP 7882 and TCP 7881 are open, and forwarded if the server is behind a router.
- LiveKit advertises an address browsers can reach. `docker compose logs livekit`
  shows the address it uses as it starts; if that is wrong, set
  `LIVEKIT_NODE_IP` (section 6).
- In a browser, the page is served over HTTPS. Otherwise the microphone and
  camera are blocked (section 4).
