# MCP Proxy Dashboard

A web UI to create, run, and observe MCP proxies. It wraps the Go `mcp-proxy` CLI, the `mcpo` OpenAPI bridge, and MCP Inspector so you can mix stdio, SSE, streamable HTTP, and OpenAPI targets with live logs and auto-start.

## Highlights
- Visual dashboard: create, edit, start/stop, delete flows
- Transports: `stdio`, `sse`, `streamable_http`, `openapi` (via `mcpo`)
- Per-flow Inspector launch; global Inspector start/stop
- Auto-start for flows and Inspector with toasts + disabled controls during boot
- Live event feed (SSE) with optional persistence across reloads
- OpenAPI bridge: auto-spawns `@ivotoby/openapi-mcp-server` helpers for OpenAPI sources

## Ports
- Dashboard UI: `8002`
- Streamable HTTP exposure: `8000`
- SSE exposure: `8001`
- OpenAPI exposure (mcpo): `8003` at `/openapi/<route>`
- MCP Inspector UI: `6274` (server side `6277`)

## Quick start (Docker)
```bash
cd web-ui-mcp-proxy
docker-compose up --build
```
Open `http://localhost:8002`. Data persists in `./data`.

## Flow model
- Sources: `stdio` (command/args/env), `sse` (url/headers), `streamable_http` (url/headers), `openapi` (base/spec; spawns helper).
- Targets: `sse`, `streamable_http`, or `openapi` (no stdio target). OpenAPI source is forced to `streamable_http`.
- Endpoints:
  - SSE target → `http://<host>:8001/<route>/sse`
  - Streamable target → `http://<host>:8000/<route>/mcp`
  - OpenAPI target → `http://<host>:8003/openapi/<route>`

## Using the UI
1. **Create** a flow (command for stdio, URL for SSE/streamable HTTP, base/spec for OpenAPI).  
2. **Start/Stop** per flow, or **Start all / Stop all** (auto-start freeze disables buttons briefly).  
3. **Inspector**: top buttons start/stop; per-flow Inspector opens with the right params (`/docs` for OpenAPI).  
4. **Events**: live feed; enable **Persist events** in Settings to keep history on reload.  
5. **Settings**: toggles for auto-start flows/Inspector, Inspector host override (`host.docker.internal` default), event persistence.

## OpenAPI specifics
- For an OpenAPI source, the dashboard runs `npx -y @ivotoby/openapi-mcp-server` on a free port, waits for readiness, then points the proxy to it.
- OpenAPI targets are served by `mcpo` on port `8003` at `/openapi/<route>`; Inspector opens `/docs` for those flows.

## Environment knobs
- `MCP_PROXY_BIN` (default `mcp-proxy`)
- `MCP_OPENAPI_BIN` (default `uvx mcpo`)
- `MCP_INSPECTOR_BIN` (default `npx -y @modelcontextprotocol/inspector`)
- `MCP_INSPECTOR_PORT` / `MCP_INSPECTOR_SERVER_PORT`, `MCP_INSPECTOR_HOST`, `MCP_INSPECTOR_PUBLIC_HOST`
- `MCP_DASH_DATA` to relocate `data/flows.json`

## Dev notes
- Backend: FastAPI orchestrates processes/configs; persists flows in `data/flows.json`, runtime configs in `data/runtime/`.
- Frontend: vanilla JS with modals, toasts, and SSE updates.
- Auto-start is keyed by container boot ID to avoid re-running on simple reloads.

## Troubleshooting
- OpenAPI 404: ensure upstream MCP is reachable; the helper waits but the target must exist.
- Stdio commands: ensure `npx`, `uvx`, or `docker` are available in PATH inside the container.
- Inspector unreachable: check ports `6274/6277` and `inspector_public_host`.

## License
MIT
