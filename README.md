# desk-waifu-office

Cloud hub for [desk-waifu](../desk-waifu/) — multi-user × multi-agent virtual office. Each `(user, agent, instance)` is a desk; client hooks POST state changes and bubble lines; spectators open `/` and watch the room move in real time over SSE.

## Quick start (local sanity check)

```bash
npm install
node server.js --port 7878 --data ./data
# browser: http://localhost:7878/   → demo seats animate every 15–30s
```

Or via `npx` once published:

```bash
npx desk-waifu-office --port 7878 --data ./data
```

## API summary

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/register` | — | `{username}` → `{api_key}` (one-time plaintext) |
| PUT  | `/assets/:state` | Bearer | multipart `gif`, optional `X-Content-Sha256` → 304 on no-change |
| GET  | `/u/:user/gifs/:state.gif` | — | static GIF |
| POST | `/events` | Bearer | `{agent, instance, type, value, ts}`, `type=state\|bubble` |
| GET  | `/stream` | — | SSE; one JSON line per event |
| GET  | `/api/room` | — | snapshot for first paint |
| GET  | `/healthz` | — | liveness |

## VPS deployment

### systemd unit (`~/.config/systemd/user/desk-waifu-office.service`)

```ini
[Unit]
Description=desk-waifu office hub
After=network.target

[Service]
Type=simple
WorkingDirectory=%h/desk-waifu-office
ExecStart=/usr/bin/npx desk-waifu-office --port 7878 --data %h/desk-waifu-office/data
Restart=on-failure
RestartSec=3
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now desk-waifu-office
journalctl --user -u desk-waifu-office -f
```

### nginx reverse proxy with HTTPS

```nginx
server {
  listen 443 ssl http2;
  server_name office.example.com;
  ssl_certificate     /etc/letsencrypt/live/office.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/office.example.com/privkey.pem;

  # SSE-friendly: disable buffering, long timeouts
  location /stream {
    proxy_pass http://127.0.0.1:7878;
    proxy_http_version 1.1;
    proxy_set_header Connection '';
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 1h;
    chunked_transfer_encoding off;
  }

  location / {
    proxy_pass http://127.0.0.1:7878;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    client_max_body_size 6m;
  }
}
```

## Client configuration sketch

```bash
# one-time
curl -X POST https://office.example.com/register \
  -H 'content-type: application/json' \
  -d '{"username":"alice"}'
# → save api_key locally

# every state change from desk-waifu hook
curl -X POST https://office.example.com/events \
  -H "Authorization: Bearer $OFFICE_KEY" \
  -H 'X-Client-Id: '"$(uuidgen)" \
  -H 'content-type: application/json' \
  -d '{"agent":"claude-code","instance":"laptop","type":"state","value":"coding","ts":'"$(date +%s%3N)"'}'
```

## Design notes

- **SSE, not WebSocket** — strictly server→browser, plays nice with nginx, EventSource auto-reconnects.
- **Data dir is project-local (`./data/`)**, not `$HOME`, so the deployment is one directory you can rsync/backup atomically.
- **api_key is hashed (sha256) at rest** — DB leak is not a key leak. The plaintext is shown once at register time.
- **Demo simulator** runs only when no real users exist; gives empty deployments something to look at.
- **WAL + idempotency table** keeps the SSE writers from blocking each other under bursty hook traffic.
