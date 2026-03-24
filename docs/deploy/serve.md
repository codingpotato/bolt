# Deploying bolt serve

`bolt serve` starts bolt as a persistent background service accessible from any browser or phone. The agent stays alive between conversations; clients connect via WebSocket and disconnect freely without stopping the process.

## How it works

```
phone / browser
      │  WebSocket (ws:// or wss://)
      ▼
bolt serve  ──►  WebChannel  ──►  AgentCore (persistent loop)
      │                                    │
      │  GET /media/:path (images/video)   │  .bolt/  (session, memory, tasks)
      └────────────────────────────────────┘
```

- The first client to connect is **active** — it can send messages.
- Additional clients are **read-only observers** — they receive all agent output but cannot send.
- When the active client disconnects the oldest observer is promoted.
- Session history (L1/L2) is preserved for the lifetime of the process; clients that reconnect pick up where the conversation left off.

---

## Prerequisites

- Node.js ≥ 20
- An Anthropic API key (or local inference server)
- A machine reachable from your phone (same LAN, or exposed via a reverse proxy)

---

## Quick start

```bash
# Build (required for production; dev mode hot-reloads but is slower)
npm run build

# Set credentials
export ANTHROPIC_API_KEY=sk-ant-...
export BOLT_WEB_TOKEN=your-secret-token     # required for remote access

# Start the server
node dist/cli/index.js serve
```

You should see:

```
bolt serve: listening on http://localhost:3000 (model: claude-opus-4-6)
```

Open `http://<machine-ip>:3000?token=your-secret-token` in your phone browser. If `BOLT_WEB_TOKEN` is not set, the server accepts any connection (development only).

### Development mode

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export BOLT_WEB_TOKEN=dev-token
npx ts-node src/cli/index.ts serve --port 3000
```

---

## Configuration

### CLI flags

| Flag | Description | Default |
|------|-------------|---------|
| `--port <n>` | HTTP/WebSocket port | `config.channels.web.port` (3000) |
| `--token <s>` | Auth token | `BOLT_WEB_TOKEN` or config |

CLI flags override config file values, which override defaults.

### Environment variables

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `BOLT_WEB_TOKEN` | Authentication token for browser clients |
| `BOLT_MODEL` | Model override (default: `claude-opus-4-6`) |
| `BOLT_LOG_LEVEL` | Log verbosity: `debug` \| `info` \| `warn` \| `error` |
| `BOLT_DATA_DIR` | Runtime data directory (default: `.bolt`) |

### `.bolt/config.json` (optional)

```jsonc
{
  "channels": {
    "web": {
      "port": 3000,
      "mode": "websocket"   // "websocket" | "http"
    }
  },
  "model": "claude-opus-4-6"
}
```

`BOLT_WEB_TOKEN` must be set via environment variable — do not write tokens to `config.json` in production.

---

## Running as a system service

### macOS — launchd

Create `~/Library/LaunchAgents/com.bolt.serve.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>             <string>com.bolt.serve</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/path/to/bolt/dist/cli/index.js</string>
    <string>serve</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ANTHROPIC_API_KEY</key> <string>sk-ant-...</string>
    <key>BOLT_WEB_TOKEN</key>    <string>your-secret-token</string>
    <key>BOLT_LOG_LEVEL</key>    <string>info</string>
  </dict>
  <key>WorkingDirectory</key>  <string>/path/to/your/workspace</string>
  <key>RunAtLoad</key>         <true/>
  <key>KeepAlive</key>         <true/>
  <key>StandardOutPath</key>   <string>/tmp/bolt-serve.out</string>
  <key>StandardErrorPath</key> <string>/tmp/bolt-serve.err</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.bolt.serve.plist
launchctl start com.bolt.serve

# To stop:
launchctl stop com.bolt.serve

# To unload:
launchctl unload ~/Library/LaunchAgents/com.bolt.serve.plist
```

### Linux — systemd

Create `/etc/systemd/system/bolt-serve.service`:

```ini
[Unit]
Description=bolt serve daemon
After=network.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/path/to/your/workspace
ExecStart=/usr/bin/node /path/to/bolt/dist/cli/index.js serve
Restart=on-failure
RestartSec=5

Environment=ANTHROPIC_API_KEY=sk-ant-...
Environment=BOLT_WEB_TOKEN=your-secret-token
Environment=BOLT_LOG_LEVEL=info

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable bolt-serve
sudo systemctl start bolt-serve

# Status / logs:
sudo systemctl status bolt-serve
journalctl -u bolt-serve -f
```

---

## Network and security

### LAN access (phone on the same Wi-Fi)

No extra configuration needed. Use `http://<machine-local-ip>:3000?token=<token>`. Find your local IP with `ifconfig | grep "inet "` (macOS) or `ip addr` (Linux).

### Remote access via reverse proxy (HTTPS + WSS)

For access over the internet, put bolt behind a reverse proxy that handles TLS. Example with **nginx**:

```nginx
server {
    listen 443 ssl;
    server_name bolt.yourdomain.com;

    ssl_certificate     /etc/letsencrypt/live/bolt.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/bolt.yourdomain.com/privkey.pem;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host $host;
        proxy_read_timeout 3600s;   # keep WebSocket alive
    }
}
```

Clients then connect to `https://bolt.yourdomain.com?token=<token>` (WebSocket upgrades to `wss://` automatically).

### Token authentication

Every HTTP request and WebSocket upgrade is validated against `BOLT_WEB_TOKEN`. Pass it as:

- Query param: `?token=<token>`
- HTTP header: `Authorization: Bearer <token>`

Connections without a valid token receive HTTP 401 and are dropped.

---

## Graceful shutdown

Send `SIGTERM` or press `Ctrl+C`:

```bash
# If running in foreground:
Ctrl+C

# If running as a background process:
kill -TERM <pid>

# Via systemd:
sudo systemctl stop bolt-serve
```

bolt will print `bolt serve: shutting down gracefully...`, close all WebSocket connections, reject any pending review requests, and exit with code 0. The session history in `.bolt/sessions/` is preserved for next startup.

---

## Monitoring

### Structured log

```bash
tail -f .bolt/bolt.log | jq .
```

Key log entries:

| `msg` | When |
|-------|------|
| `bolt serve started` | Server is listening; includes `port`, `model`, `auth` |
| `tool call` | Any tool executed by the agent |
| `context compacted` | L1 compaction triggered |
| `memory written` | Long-term memory entry persisted |

### Audit log

```bash
tail -f .bolt/tool-audit.jsonl | jq .
```

Every tool call is appended with `ts`, `tool`, `input`, and `result` fields.

---

## Upgrading

```bash
# Pull latest code
git pull

# Rebuild
npm run build

# Restart (systemd)
sudo systemctl restart bolt-serve
```

Session data in `.bolt/` is forward-compatible; no migration is needed between patch releases.
