# Importing .ppt and Keynote files in Slides

Slides imports `.pptx` and `.odp` files, and PDFs, with nothing to set up: the
browser reads them itself. Older PowerPoint files (`.ppt`, `.pps`, `.pot`) and
Keynote files (`.key`) need LibreOffice to read them, and LibreOffice is large,
so it is not in the main ParaDOCs image. It is an optional **converter**
container, off until you switch it on.

| File | Needs the converter? |
| ---- | -------------------- |
| `.pptx`, `.pptm`, `.ppsx`, `.potx`, `.odp`, `.otp` | No |
| PDF | No. Each page becomes one picture slide. |
| `.ppt`, `.pps`, `.pot` | Yes |
| Keynote `.key` | Yes, with caveats (below) |

With the converter off, choosing a `.ppt` or `.key` file in Slides says so and
offers to import a PDF of it instead. Nothing breaks.

## Turning it on

In the folder with your `docker-compose.yml` and `.env`, add to `.env`:

```bash
COMPOSE_PROFILES=converter
CONVERTER_URL=http://converter:3000
```

With HTTPS as well, list both profiles: `COMPOSE_PROFILES=https,converter`.
Then:

```bash
docker compose up -d
```

The first start downloads the converter image, `paradoxrelativity/paradocs-converter`,
which is over a gigabyte. (If it has not been published for your release, build
it from the `converter` folder of the repository: `docker build -t
paradoxrelativity/paradocs-converter converter`.) `docker compose ps` should show `converter` as `healthy`. Import a
`.ppt` file in Slides to check it works. To turn it off again, remove both lines
and run `docker compose up -d --remove-orphans`.

Outside Docker, run `node converter/server.mjs` on a machine with LibreOffice
(`soffice`) installed and set `CONVERTER_URL` to its address. Keep it off any
network people can reach: it has no sign-in of its own, because only the app is
meant to talk to it.

### Settings

| Variable | Default | Meaning |
| -------- | ------- | ------- |
| `CONVERTER_URL` | unset (converter off) | Where the app reaches the converter |
| `CONVERTER_MAX_MB` | `50` | Largest file it will convert, in megabytes |
| `CONVERTER_TIMEOUT_SECONDS` | `60` | How long one conversion may take before it is stopped |
| `CONVERTER_CONCURRENCY` | `2` | Conversions the app lets run at once; others are told to try again |
| `CONVERTER_MEMORY` | `2g` | Memory limit of the converter container |
| `CONVERTER_CPUS` | `2` | CPU limit of the converter container |

## What it needs

LibreOffice is the heaviest thing in a ParaDOCs deployment while it works, and
costs nothing while it does not (the container idles at well under 100 MB).

- **Memory:** plan on 1 GB per conversion at a time, and 2 GB for the container
  as set up. A large deck with many pictures can use more; the limit stops it
  taking the server down, and that file fails with a clear message.
- **CPU:** one core is enough; a typical deck converts in 5 to 20 seconds.
- **Disk:** about 1.5 GB for the image. Files are not kept, so nothing grows.

## How it is kept safe

LibreOffice is parsing files that came from anywhere, so the converter is built
on the assumption that a file could be hostile.

- **A separate container**, running as an unprivileged user with all Linux
  capabilities dropped and `no-new-privileges`. Its filesystem is read-only
  except a small scratch directory.
- **No network.** It sits on an internal Docker network shared only with the
  app, so it cannot reach the internet, the database or anything else, and
  nothing outside can reach it.
- **Limits.** Files over `CONVERTER_MAX_MB` are refused, a conversion past
  `CONVERTER_TIMEOUT_SECONDS` is killed together with everything it started,
  the container is capped on memory, CPU and processes, and only a few
  conversions run at once. A malformed or oversized file is rejected and the
  rest of ParaDOCs carries on unaffected.
- **Nothing persisted.** The app holds a file in memory only while it is being
  converted. The converter writes it to a scratch directory of its own, deleted
  when the request ends, however it ends. Nothing is logged about a file's
  contents.
- **Needs permission.** Only people who may create presentations in the
  workspace can send files to it.
- **Off by default.**

## Keynote

LibreOffice's support for Keynote files is partial: text and pictures usually
come across, but newer Keynote files (which Keynote writes in a format
LibreOffice only reads in part) can lose layouts, shapes and animations, or fail
to convert at all.

**Exporting to `.pptx` from Keynote gives much better results**, and needs no
converter: in Keynote, choose File > Export To > PowerPoint, then import the
`.pptx` into Slides. Slides says this when someone chooses a `.key` file.

## When a converted deck looks wrong

Every import ends with a report of what was approximated or left out. For a deck
that converts poorly, export it to PDF from the original application and import
that: each page becomes one picture slide that looks exactly like the original,
at the cost of not being editable.

## Desktop app

The desktop app's local workspaces have no converter, so `.ppt` and Keynote
files cannot be imported there; Slides says so and offers PDF import, which
works everywhere. Connect the desktop app to a server with the converter on
(see [Deploying with Docker](deploying-with-docker.md), section 7) and the
formats are available in that server's workspaces.
