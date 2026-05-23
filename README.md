# OpenReplay MCP Server

An MCP (Model Context Protocol) server for [OpenReplay](https://openreplay.com) session analytics. It logs into your OpenReplay dashboard with email/password, obtains a JWT, and exposes the dashboard's data API as MCP tools — sessions, events, replays, funnels, and breakdowns.

Works against **self-hosted** instances (e.g. `https://or.your-domain.com`) and OpenReplay **SaaS** (`https://app.openreplay.com`).

> Fork of [lekt9/openreplay-mcp](https://github.com/lekt9/openreplay-mcp), rewritten to use OpenReplay's authenticated dashboard API (JWT) instead of the limited Organization-API-key endpoints, upgraded to MCP SDK 1.x, and verified end-to-end against a live instance.

## Tools

| Tool | What it does |
|------|--------------|
| `login` | Authenticate (email/password → JWT). Usually automatic. |
| `auth_status` | Whether a valid JWT is held. |
| `list_projects` | Projects with their numeric `projectId` (siteId). |
| `search_sessions` | Recorded sessions over a window (count + summaries + replay deep links). |
| `get_session_events` | All events for a session (locations, clicks, inputs, errors, network, perf). |
| `get_session_replay` | Replay metadata + a deep link to watch it. |
| `get_sessions_over_time` | Session-count timeseries. |
| `get_top` | Top breakdown by dimension (`locations`, `userBrowser`, `userCountry`, `userOs`, `userDevice`, `referrer`). |
| `get_funnel` | Step-by-step conversion funnel. |

## Setup

```bash
npm install
npm run build
```

Configure via environment variables (see `.env.example`):

| Var | Required | Notes |
|-----|----------|-------|
| `OPENREPLAY_URL` | yes | Instance URL you open in the browser. Legacy `OPENREPLAY_BACKEND_URL` / `OPENREPLAY_API_URL` also accepted. |
| `OPENREPLAY_EMAIL` | yes | Dashboard account email. |
| `OPENREPLAY_PASSWORD` | yes | Dashboard account password. |
| `OPENREPLAY_PROJECT_ID` | no | Default numeric siteId; otherwise pass `siteId` per call or use `list_projects`. |

The JWT is cached at `~/.openreplay-mcp/config.json` and transparently re-minted on expiry.

## MCP client config

```json
{
  "mcpServers": {
    "openreplay": {
      "command": "node",
      "args": ["/absolute/path/to/openreplay-mcp/dist/index.js"],
      "env": {
        "OPENREPLAY_URL": "https://or.your-domain.com",
        "OPENREPLAY_EMAIL": "you@example.com",
        "OPENREPLAY_PASSWORD": "your_password",
        "OPENREPLAY_PROJECT_ID": "1"
      }
    }
  }
}
```

## Notes

- **Self-hosted vs SaaS paths.** The dashboard API lives at `{host}/api/...` on self-hosted and `api.openreplay.com/...` on SaaS; the server derives this from `OPENREPLAY_URL`.
- **Web vitals / performance** are intentionally not exposed: the `webVital` metric returns HTTP 500 on the self-hosted v1.x API tested, and performance timeseries are not supported there (`metricOf` is limited to `sessionCount`/`userCount`/`eventCount`).
- Credentials live only in env and the local JWT cache; nothing is sent anywhere except your OpenReplay instance.

## Development

```bash
npm run build      # compile to dist/
npm test           # run the vitest suite
npm run test:watch # watch mode
npm run dev        # run from source with tsx (watch)
```

Tests cover URL derivation, the metric-card payload builders, and the auth/request client (login, transparent re-auth on 401, project/session parsing) with mocked network and filesystem.

## Credits

Originally created by [lekt9](https://github.com/lekt9/openreplay-mcp). This fork rewrites it onto OpenReplay's authenticated dashboard API, upgrades to MCP SDK 1.x, and adds a test suite. The original commit history is preserved.

## License

[MIT](LICENSE) — © 2025 lekt9 and contributors.
