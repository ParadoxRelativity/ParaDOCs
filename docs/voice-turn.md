# Plan: TURN over TLS for voice on locked-down networks

**Status: not implemented.** This is the plan for when it is needed. Nothing
here is wired up yet.

## The problem it solves

Call media normally goes straight between browsers and the LiveKit container,
over UDP 7882 or, where UDP is blocked, TCP 7881. Some corporate and guest
networks allow nothing but web traffic on ports 80 and 443, so both are
blocked and people on those networks cannot join calls.

TURN over TLS gets around that. LiveKit's built-in TURN server relays the media
inside a TLS connection on port 443, which such networks see as ordinary
HTTPS. Browsers only use it when UDP and TCP both fail, so it costs relay
bandwidth only for the people who need it.

**Signs you need it:** people can sign in and open voice channels from those
networks but never connect to a call, while the same people connect fine from
home.

## Why it is not a one-line change

Caddy already owns port 443 on this host. TURN has to share that port without
disturbing the website, and LiveKit needs to know each caller's real address
even though Caddy sits in front of it.

## Chosen design: a TURN hostname routed by Caddy on port 443

- A second hostname, for example `turn.docs.example.com`, points at the same
  host as the app.
- Caddy is built with the [caddy-l4](https://github.com/mholt/caddy-l4) plugin.
  A `layer4` listener wrapper on `:443` looks at the hostname a connection asks
  for (TLS SNI):
  - If it is the TURN hostname, Caddy terminates TLS with its own certificate
    and passes the plain connection to LiveKit's TURN port. It adds a PROXY
    protocol header carrying the caller's real address.
  - Anything else is not matched, and falls through to the normal HTTPS site.
- LiveKit's TURN server runs with `external_tls` (Caddy handles TLS) and
  `proxy_protocol` (it trusts Caddy's header for the caller's address).

No change to the app's code is expected. LiveKit includes TURN servers in the
connection details it sends when someone joins, and its client falls back to
them on its own.

## Steps

### 1. DNS

Add an A/AAAA record for the TURN hostname pointing at this host. Nothing new
needs opening in the firewall: ports 80 and 443 are already open for Caddy.

### 2. A Caddy image with caddy-l4

The `caddy` service in `docker-compose.yml` uses the stock `caddy:2-alpine`
image, which does not include the plugin. Build one that does, using the usual
Caddy pattern:

```dockerfile
# caddy/Dockerfile
FROM caddy:2-builder AS builder
RUN xcaddy build --with github.com/mholt/caddy-l4

FROM caddy:2-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
```

Push it to a registry, for example as `paradoxrelativity/paradocs-caddy`, and
use it in place of `image: caddy:2-alpine` in `docker-compose.yml`. Publishing
the image, rather than giving the service a `build:` section, keeps a deployment
down to the compose file and `.env`.

### 3. Caddy configuration

The Caddyfile is the `caddyfile` entry under `configs:` in `docker-compose.yml`.
Compose substitutes variables in that text, so Caddy's own placeholders are
written with a doubled `$` there (`{$$TURN_DOMAIN}`). The snippets below are
plain Caddyfile.

Add a global options block at the top. This is a sketch following caddy-l4's
"combining apps" example, not tested config:

```caddyfile
{
	servers :443 {
		listener_wrappers {
			layer4 {
				@turn tls sni {$TURN_DOMAIN}
				route @turn {
					tls
					proxy {
						proxy_protocol v2
						upstream tcp/livekit:443
					}
				}
			}
			tls
		}
	}
}
```

The `tls` handler only terminates TLS; it does not obtain certificates. Caddy
gets the certificate for the TURN hostname from a site block of its own:

```caddyfile
{$TURN_DOMAIN} {
	respond "TURN relay" 404
}
```

Caddy normally proves it controls a hostname using either port 80 (HTTP-01) or
port 443 (TLS-ALPN). The layer4 route intercepts TLS connections for the TURN
hostname, so expect the port 443 method to fail and the port 80 method to be
the one that works. Confirm the certificate is issued before relying on it.

caddy-l4 warns against HTTP/3 only when layer4 also routes UDP on the same
port. This design routes TCP only, so HTTP/3 can stay on.

### 4. LiveKit

Add to the `livekit` entry under `configs:` in `docker-compose.yml`:

```yaml
turn:
  enabled: true
  # Must match the certificate's hostname.
  domain: turn.docs.example.com
  # With external_tls, LiveKit listens for plain TCP on this port but still
  # advertises it to browsers as the TURN/TLS port. Browsers reach Caddy on
  # 443, so this has to be 443 too, or they would be told the wrong port.
  tls_port: 443
  external_tls: true
  # Caddy terminates TLS, so without this LiveKit would see Caddy's address
  # instead of the caller's, and Firefox rejects that.
  proxy_protocol: true
  # Only these addresses may send a PROXY header. The default is loopback,
  # which does not cover Caddy in another container: use the compose
  # network's subnet (see below).
  proxy_protocol_trusted_cidrs:
    - 172.28.0.0/24
```

The TURN port is not published on the host. Only Caddy reaches it, over the
compose network.

Give the compose network a fixed subnet so the trusted range above stays
correct, in `docker-compose.yml`:

```yaml
networks:
  default:
    ipam:
      config:
        - subnet: 172.28.0.0/24
```

LiveKit's TURN server also listens on UDP (3478 by default). This design does
not publish it: callers who can use UDP already reach media directly on 7882.

### 5. Environment

Add `TURN_DOMAIN=turn.docs.example.com` to `.env`, pass it to Caddy under the
`caddy` service's `environment:` in `docker-compose.yml`, and document it in
`.env.example`.

## Before relying on it

- **Check the LiveKit version.** These options come from LiveKit's current
  sample config. `proxy_protocol` in particular is recent, and the pinned
  `livekit/livekit-server` image may predate it. Confirm the options exist in
  the version in use, and upgrade if they do not.
- **Test that the relay itself works.** A browser that can use UDP never
  touches TURN, so a normal call proves nothing. Either:
  - temporarily connect with a relay-only policy, passing
    `rtcConfig: { iceTransportPolicy: 'relay' }` to `room.connect` in
    `apps/web/src/lib/call.ts`, or
  - join from a machine whose firewall blocks outgoing UDP and TCP 7881.
- **Test in Firefox as well as Chromium.** Firefox is where a wrong caller
  address (the PROXY protocol setup) shows up.
- **Watch bandwidth.** Relayed calls pass through the server twice over.
  LiveKit caps relay allocations per participant
  (`per_user_relay_allocation_limit`, 12 by default).

## Alternatives considered

- **TURN on port 5349 with LiveKit handling TLS itself.** No custom Caddy
  build, but LiveKit needs certificate files (`cert_file`/`key_file`), in
  practice Caddy's, mounted in and picked up again after each renewal. Strict
  networks may block 5349 anyway.
- **A second IP address or a small separate host for TURN on its own 443.**
  The cleanest network setup and no Caddy changes, but more infrastructure to
  run.

## Sources

Checked on 2026-09-11 against:

- LiveKit's `config-sample.yaml` (the `turn:` and `rtc:` sections)
- caddy-l4's docs: `docs/examples/combining_apps.md`, `docs/handlers/proxy.md`
  and `docs/handlers/tls.md`
