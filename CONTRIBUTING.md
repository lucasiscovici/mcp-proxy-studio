# Contributing to MCP Proxy Studio (MCP Proxy Studio)

Thanks for your interest in contributing! This project is a web dashboard to create, run, and observe MCP proxy “flows” (stdio, SSE, streamable HTTP, OpenAPI) with live logs and Inspector integration.

## ✨ Ways to contribute
- Report bugs (with logs + steps to reproduce)
- Propose UX improvements / new flow features
- Improve documentation (README, examples, troubleshooting)
- Add tests, CI improvements, refactors
- Add new transports / better OpenAPI handling

---

## 🧰 Development setup

### Prerequisites
- Docker + Docker Compose (recommended)
- Or: Python 3.11+, Node/npm, Go (if running tools locally outside Docker)

### Run in dev mode (recommended)
This uses the dev compose (build local + hot reload + mounted code).

```bash
make dev
````

Stop:

```bash
make dev-down
```

Logs:

```bash
make dev-logs
```

### Run in prod mode (image-based)

```bash
make prod
```

---

## 📦 Repository structure (typical)

> Names may slightly vary depending on your current layout.

* `backend/` — FastAPI orchestrator, manages processes, persists flows
* `frontend/` — UI assets (vanilla JS)
* `data/` — local runtime data (flows.json, runtime configs)
* `docs/` — screenshots, examples, changelog, extra docs
* `docker-compose.yml` — production (image reference)
* `docker-compose.dev.yml` — development (build + hot reload)
* `Dockerfile` / `Dockerfile.dev` — prod/dev images
* `VERSION` — single source of truth for releases

---

## 🔁 Workflow / flow model notes

* A **flow** has a *source* (stdio / sse / streamable_http / openapi) and a *target* (sse / streamable_http / openapi).
* OpenAPI sources spawn an `@ivotoby/openapi-mcp-server` helper and then proxy against it.
* The UI displays live state and events via SSE.

If you’re changing the flow schema, please also update:

* any persisted flow format (`data/flows.json`)
* migration notes (in `CHANGELOG.md`)
* UI form validation

---

## ✅ Coding guidelines

### Backend (FastAPI)

* Keep endpoints small and explicit
* Validate config with Pydantic models
* Prefer safe process management:

  * handle startup failures
  * handle “already running” gracefully
  * ensure cleanup on shutdown
* Don’t block the event loop (use async-friendly IO when possible)

### Frontend (Vanilla JS)

* Keep UI deterministic: disable buttons while booting/restarting flows
* Prefer small modules over large scripts if refactoring
* Keep toasts/events user-friendly and non-spammy
* Avoid introducing heavy frameworks unless there’s a strong reason

### Data persistence

* Treat `/data/flows.json` as potentially user-owned:

  * don’t corrupt it on partial writes
  * be careful with schema changes

---

## 🧪 Testing (recommended)

If you add tests, target these basics:

* Flow create/update/delete correctness
* Process lifecycle (start/stop/status)
* OpenAPI helper spawn + readiness behavior
* SSE events streaming (basic smoke)

Even a small “smoke test” is valuable.

---

## 🧾 Commit conventions

Suggested (not mandatory), but keeps history clean:

* `feat: ...`
* `fix: ...`
* `docs: ...`
* `refactor: ...`
* `chore: ...`
* `chore(release): vX.Y.Z`

---

## 📌 Pull request checklist

Before opening a PR, please ensure:

* [ ] You tested locally (`make dev`)
* [ ] No sensitive data committed (tokens, credentials)
* [ ] Docs updated if behavior changed
* [ ] UI screenshots updated if UX changed (optional but appreciated)
* [ ] PR description includes: what, why, how to test

---

## 🐛 Bug reports

Please include:

* OS + Docker version
* Steps to reproduce
* Expected vs actual behavior
* Logs: `docker compose logs -f --tail=200`

---

## 🔐 Security issues

If you believe you found a security issue, please **do not** open a public issue.
Instead, contact the maintainer privately (add your preferred contact method here).

---

## 📜 License

By contributing, you agree that your contributions will be licensed under the MIT License.
