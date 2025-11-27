const state = {
  flows: [],
  feed: [],
  onlyRunning: false,
  search: "",
  modeFilter: "all",
  settings: { host: "0.0.0.0", sse_port: 8001, stream_port: 8001, openapi_port: 8003, inspector_public_host: "0.0.0.0" },
  autoStart: false,
  formVisible: false,
  autoStartedSession: false,
  autoStartingFlows: false,
  bootId: null,
  eventsMinimized: true,
  autoStartInspector: false,
  inspectorAutoStarted: false,
  autoStartStartedLogged: false,
  autoStartLogged: false,
  autoStartInspectorStartedLogged: false,
  autoStartInspectorLogged: false,
  persistEvents: false,
  settingsVisible: false,
  inspectorHost: "localhost",
  inspectorRunning: false,
  firstLoadLogged: false,
  toastTimer: null,
  autoStartingInspector: false,
  stoppingAllFlows: false,
  flowBusy: {},
};

const el = {
  flowList: document.getElementById("flow-list"),
  form: document.getElementById("flow-form"),
  formTitle: document.getElementById("form-title"),
  resetForm: document.getElementById("reset-form"),
  startAll: document.getElementById("start-all"),
  autoStartToggle: document.getElementById("auto-start"),
  formModal: document.getElementById("form-modal"),
  toggleForm: document.getElementById("toggle-form"),
  closeForm: document.getElementById("close-form"),
  eventsPanel: document.getElementById("events-panel"),
  toggleEvents: document.getElementById("toggle-events"),
  settingsModal: document.getElementById("settings-modal"),
  openSettings: document.getElementById("open-settings-panel"),
  closeSettings: document.getElementById("close-settings"),
  persistEventsToggle: document.getElementById("persist-events"),
  autoStartInspectorToggle: document.getElementById("auto-start-inspector"),
  inspectorHost: document.getElementById("inspector-host"),
  showOnlyRunning: document.getElementById("show-only-running"),
  search: document.getElementById("search"),
  modeFilter: document.getElementById("mode-filter"),
  liveFeed: document.getElementById("live-feed"),
  clearFeed: document.getElementById("clear-feed"),
  toggleInspector: document.getElementById("toggle-inspector"),
  openInspector: document.getElementById("open-inspector"),
  toast: document.getElementById("toast"),
  stats: {
    running: document.getElementById("stat-running"),
    total: document.getElementById("stat-total"),
    // last: document.getElementById("stat-last"),
  },
};

const field = (id) => document.getElementById(id);

const formatter = new Intl.DateTimeFormat("fr-FR", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

async function fetchJSON(url, options = {}) {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const message = await res.text();
    throw new Error(message || "An error occurred");
  }
  return res.json();
}

function serializeForm() {
  return {
    id: field("flow-id").value || null,
    name: field("name").value.trim(),
    route: field("route").value.trim() || field("name").value.trim(),
    description: field("description").value.trim(),
    source_type: field("source_type").value,
    target_type: field("target_type").value,
    sse_url: field("sse_url").value.trim() || null,
    openapi_base_url: field("openapi_base_url").value.trim() || null,
    openapi_spec_url: field("openapi_spec_url").value.trim() || null,
    command: field("command").value.trim() || null,
    args: splitWords(field("args").value),
    env: parseEnv(field("env").value),
    headers: parseHeaders(field("headers").value),
    allow_origins: parseList(field("allow_origins").value),
  };
}

function parseHeaders(text) {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [key, ...rest] = line.split(":");
      return { key: key.trim(), value: rest.join(":").trim() };
    })
    .filter((h) => h.key && h.value);
}

function parseEnv(text) {
  const env = {};
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .forEach((line) => {
      const [key, ...rest] = line.split("=");
      if (key && rest.length) {
        env[key.trim()] = rest.join("=").trim();
      }
    });
  return env;
}

function parseList(text) {
  return text
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function splitWords(text) {
  return text
    .split(" ")
    .map((v) => v.trim())
    .filter(Boolean);
}

function updateTargetOptions() {
  const source = field("source_type").value;
  const select = field("target_type");
  if (!select) return;
  let mustChange = false;
  Array.from(select.options).forEach((opt) => {
    const disableSame = opt.value === source;
    const disableStdio = opt.value === "stdio";
    const disabled = disableSame || disableStdio;
    opt.disabled = disabled;
    opt.hidden = disabled;
    if (disabled && select.value === opt.value) {
      mustChange = true;
    }
  });
  if (mustChange || select.value === "stdio") {
    const fallback =
      source === "streamable_http" ? "sse" : source === "sse" ? "streamable_http" : "streamable_http";
    select.value = fallback;
  }
  if (source === "openapi") {
    select.value = "streamable_http";
  }
}

async function loadFlows(log = true, forceLog = false) {
  try {
    const data = await fetchJSON("/api/flows");
    const autoKey = localStorage.getItem("mcp_auto_start") === "1";
    const bootKey = localStorage.getItem("mcp_auto_start_boot");
    const bootId = state.bootId;
    const shouldAuto = autoKey && bootId && !state.autoStartedSession && bootKey !== bootId;
    if (shouldAuto) {
      state.autoStartingFlows = true;
    }
    state.flows = data;
    renderFlows();
    renderStats();
    if (log && (forceLog || !state.firstLoadLogged)) {
      pushFeed("info", `Loaded ${data.length} flows`);
      state.firstLoadLogged = true;
    }
    if (shouldAuto) {
      if (!state.autoStartStartedLogged) {
        pushFeed("info", "Auto-start flows in progress...");
        showToast("Auto-starting flows...", "info", 2500);
        state.autoStartStartedLogged = true;
      }
      state.autoStartingFlows = true;
      renderStats();
      await startAllFlows(true, true);
      state.autoStartedSession = true;
      sessionStorage.setItem("mcp_auto_started_session", "1");
      sessionStorage.setItem("mcp_auto_started_boot", bootId);
      localStorage.setItem("mcp_auto_start_boot", bootId);
      if (!state.autoStartLogged) {
        pushFeed("info", "Auto-start done");
        showToast("Flows auto-started", "success", 2500);
        state.autoStartLogged = true;
      }
      state.autoStartingFlows = false;
      renderStats();
    }
  } catch (err) {
    pushFeed("error", `Load error: ${err.message}`);
  }
}

async function loadSettings() {
  try {
    const settings = await fetchJSON("/api/settings");
    state.settings = settings;
    if (el.inspectorHost) {
      el.inspectorHost.value = settings.inspector_public_host || "localhost";
    }
  } catch (err) {
    pushFeed("error", `Settings error: ${err.message}`);
  }
}

async function loadStatus() {
  try {
    const status = await fetchJSON("/api/status");
    state.bootId = status.bootId;
  } catch (err) {
    pushFeed("error", `Status error: ${err.message}`);
  }
}

async function saveSettings() {
  // Settings are fixed; no-op
  pushFeed("info", "Ports and host are fixed (SSE:8002, Stream:8001)");
}

function renderStats() {
  const running = state.flows.filter((f) => f.state.running).length;
  const total = state.flows.length;
  const lastEvent = state.feed[0]?.ts ? formatter.format(new Date(state.feed[0].ts * 1000)) : "—";
  el.stats.running.textContent = running;
  el.stats.total.textContent = total;
  // el.stats.last.textContent = lastEvent;
  if (el.startAll) {
    const allRunning = total > 0 && running === total;
    if (state.autoStartingFlows) {
      el.startAll.textContent = "Starting...";
      el.startAll.disabled = true;
      el.startAll.dataset.mode = "start";
    } else if (state.stoppingAllFlows) {
      el.startAll.textContent = "Stopping...";
      el.startAll.disabled = true;
      el.startAll.dataset.mode = "stop";
    } else {
      el.startAll.textContent = allRunning ? "Stop all" : "Start all";
      el.startAll.disabled = false;
      el.startAll.dataset.mode = allRunning ? "stop" : "start";
    }
  }
  if (el.toggleInspector) {
    el.toggleInspector.disabled = state.autoStartingInspector || state.autoStartingFlows;
  }
  if (el.openInspector) {
    el.openInspector.disabled = state.autoStartingInspector || state.autoStartingFlows || !state.inspectorRunning;
  }
  if (el.autoStartToggle) {
    el.autoStartToggle.checked = state.autoStart;
  }
  if (el.persistEventsToggle) {
    el.persistEventsToggle.checked = state.persistEvents;
  }
  if (el.autoStartInspectorToggle) {
    el.autoStartInspectorToggle.checked = state.autoStartInspector;
  }
  if (el.inspectorHost) {
    el.inspectorHost.value = state.inspectorHost || "localhost";
  }
  if (el.formModal) {
    el.formModal.classList.toggle("hidden", !state.formVisible);
  }
  if (el.settingsModal) {
    el.settingsModal.classList.toggle("hidden", !state.settingsVisible);
  }
  if (el.eventsPanel) {
    el.eventsPanel.classList.toggle("minimized", state.eventsMinimized);
    if (el.toggleEvents) {
      el.toggleEvents.textContent = state.eventsMinimized ? "Show" : "Minimize";
    }
  }
}

async function refreshInspectorButton() {
  try {
    const st = await fetchJSON("/api/inspector/state");
    el.toggleInspector.textContent = st.running ? "Stop Inspector" : "Start Inspector";
    state.inspectorUrl = st.url || null;
    state.inspectorRunning = Boolean(st.running && st.url);
    el.openInspector.disabled = !state.inspectorRunning;
    renderFlows();
  } catch {
    el.toggleInspector.textContent = "Start Inspector";
    state.inspectorUrl = null;
    state.inspectorRunning = false;
    el.openInspector.disabled = true;
    renderFlows();
  }
}

function renderFlows() {
  el.flowList.innerHTML = "";
  let flows = [...state.flows];
  if (state.onlyRunning) {
    flows = flows.filter((f) => f.state.running);
  }
  if (state.modeFilter === "running") {
    flows = flows.filter((f) => f.state.running);
  } else if (state.modeFilter && state.modeFilter.startsWith("source_")) {
    const src = state.modeFilter.replace("source_", "");
    flows = flows.filter((f) => (f.source_type || "").toLowerCase() === src);
  }
  if (state.search) {
    const term = state.search.toLowerCase();
    flows = flows.filter(
      (f) =>
        f.name.toLowerCase().includes(term) ||
        (f.description || "").toLowerCase().includes(term) ||
        (f.sse_url || "").toLowerCase().includes(term) ||
        (f.command || "").toLowerCase().includes(term)
    );
  }
  flows.sort((a, b) => Number(b.state.running) - Number(a.state.running));
  if (!flows.length) {
    el.flowList.innerHTML = `<div class="empty">No flow configured yet.</div>`;
    renderStats();
    return;
  }
  flows.forEach((flow) => {
    const card = document.createElement("article");
    card.className = "flow-card";
    const previous = flow.previous || {};
    const hasPrevTarget = previous.sse_url || previous.command;
    const busy = state.flowBusy ? state.flowBusy[flow.id] : null;
    const host =
      flow.target_type === "openapi"
        ? state.settings.inspector_public_host || state.settings.host
        : state.settings.host;
    const port =
      flow.target_type === "streamable_http"
        ? state.settings.stream_port
        : flow.target_type === "openapi"
        ? state.settings.openapi_port
        : state.settings.sse_port;
    const route = flow.route || flow.name;
    const exposedPath =
      flow.target_type === "openapi"
        ? `/${route}`
        : `/${route}/${flow.server_transport === "streamablehttp" ? "mcp" : "sse"}`;
    let downstreamLabel;
    if (flow.source_type === "stdio") {
      downstreamLabel = `Stdio server: ${flow.command || "—"}`;
    } else if (flow.source_type === "openapi") {
      downstreamLabel = `OpenAPI source: ${flow.openapi_base_url || "—"}`;
    } else {
      downstreamLabel = `Remote server (${flow.source_type}): ${flow.sse_url || "—"}`;
    }
    const exposedLabel = `Exposed (${flow.target_type || flow.server_transport || "sse"}): http://${host}:${port}${exposedPath}`;
    const prevLabel = "";
    card.innerHTML = `
      <div class="flow-card__header">
        <div>
          <p class="eyebrow">${(flow.source_type || "sse")} → ${(flow.target_type || flow.server_transport || "sse")}</p>
          <h3>${flow.name}</h3>
          <p class="route">Route: /${flow.route || flow.name}</p>
        </div>
        <span class="status ${flow.state.running ? "status--on" : "status--off"}">
          ${flow.state.running ? "Running" : "Stopped"}
        </span>
      </div>
      <p class="flow-card__description">${flow.description || "No description"}</p>
      <div class="flow-card__meta flow-card__meta--stack">
        <span>${downstreamLabel}</span>
        <span>${exposedLabel}</span>
        ${hasPrevTarget ? `<span class="meta-prev">${prevLabel}</span>` : ""}
        <span>Source: ${flow.source_type || "sse"}</span>
        <span>Target: ${flow.target_type || flow.server_transport || "sse"}</span>
        <label class="toggle inline-toggle">
          <input type="checkbox" data-action="auto-start" data-id="${flow.id}" ${flow.auto_start !== false ? "checked" : ""} ${state.autoStartingFlows ? "disabled" : ""}>
          <span>Auto-start</span>
        </label>
      </div>
      <div class="flow-card__actions">
        ${
          flow.state.running
            ? `<button data-action="stop" class="button button--ghost" data-id="${flow.id}" ${state.autoStartingFlows || state.stoppingAllFlows || busy === "stop" ? "disabled" : ""}>${busy === "stop" ? "Stopping..." : "Stop"}</button>`
            : `<button data-action="start" class="button button--primary" data-id="${flow.id}" ${state.autoStartingFlows || state.stoppingAllFlows || busy === "start" ? "disabled" : ""}>${busy === "start" ? "Starting..." : "Start"}</button>`
        }
        <button data-action="edit" class="button button--ghost" data-id="${flow.id}" ${state.autoStartingFlows ? "disabled" : ""}>Edit</button>
        <button data-action="inspect" class="button button--ghost" data-id="${flow.id}" ${flow.target_type === "openapi" ? "" : state.inspectorRunning ? "" : "disabled"} ${state.autoStartingFlows ? "disabled" : ""}>Inspector</button>
        <button data-action="delete" class="button button--danger" data-id="${flow.id}" ${state.autoStartingFlows ? "disabled" : ""}>Delete</button>
      </div>
    `;
    card.addEventListener("click", (ev) => handleCardAction(ev, flow));
    el.flowList.appendChild(card);
  });
  renderStats();
}

async function handleCardAction(ev, flow) {
  const button = ev.target.closest("button");
  const autoToggle = ev.target.matches('input[data-action="auto-start"]');
  if (!button && !autoToggle) return;
  if (state.autoStartingFlows || state.stoppingAllFlows) {
    pushFeed("info", "Bulk action in progress, please wait...");
    return;
  }
  if (autoToggle) {
    await updateAutoStart(flow, ev.target.checked);
    return;
  }
  const action = button.dataset.action;
  try {
    if (action === "start") {
      state.flowBusy = state.flowBusy || {};
      state.flowBusy[flow.id] = "start";
      renderFlows();
      await fetchJSON(`/api/flows/${flow.id}/start`, { method: "POST" });
      pushFeed(
        "success",
        `Flow ${flow.name} started -> target ${flow.target_type === "streamable_http" ? "streamable-http" : "sse"}`
      );
    }
    if (action === "stop") {
      state.flowBusy = state.flowBusy || {};
      state.flowBusy[flow.id] = "stop";
      renderFlows();
      await fetchJSON(`/api/flows/${flow.id}/stop`, { method: "POST" });
      pushFeed("info", `Flow ${flow.name} stopped: process terminated, endpoint down`);
    }
    if (action === "delete") {
      if (confirm(`Delete ${flow.name} ?`)) {
        await fetchJSON(`/api/flows/${flow.id}`, { method: "DELETE" });
        state.flows = state.flows.filter((f) => f.id !== flow.id);
        pushFeed("warn", `Flow ${flow.name} deleted`);
        renderFlows();
      }
    }
    if (action === "edit") {
      fillForm(flow);
    }
    if (action === "inspect") {
      if (flow.target_type === "openapi") {
        const url = buildOpenApiDocsUrl(flow);
        if (url) {
          window.open(url, "_blank");
          pushFeed("success", `Docs OpenAPI pour ${flow.name}`);
        } else {
          pushFeed("error", "URL OpenAPI indisponible");
        }
      } else {
        await ensureInspectorRunning();
        const url = buildInspectorUrl(flow);
        if (url) {
          window.open(url, "_blank");
          pushFeed("success", `Inspector pour ${flow.name}`);
        } else {
          pushFeed("error", "URL Inspector indisponible");
        }
      }
    }
  } catch (err) {
    pushFeed("error", err.message);
  } finally {
    if (state.flowBusy) {
      delete state.flowBusy[flow.id];
    }
    renderFlows();
    await loadFlows();
  }
}

function fillForm(flow) {
  el.formTitle.textContent = `Edit ${flow.name}`;
  field("flow-id").value = flow.id;
  field("name").value = flow.name;
  field("route").value = flow.route || flow.name;
  field("description").value = flow.description || "";
  field("source_type").value = flow.source_type || "sse";
  field("target_type").value =
    flow.target_type || (flow.server_transport === "streamablehttp" ? "streamable_http" : "sse");
  field("sse_url").value = flow.sse_url || "";
  field("openapi_base_url").value = flow.openapi_base_url || "";
  field("openapi_spec_url").value = flow.openapi_spec_url || "";
  field("command").value = flow.command || "";
  field("args").value = (flow.args || []).join(" ");
  field("env").value = Object.entries(flow.env || {})
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  field("allow_origins").value = (flow.allow_origins || []).join(", ");
  field("headers").value = (flow.headers || [])
    .map((h) => `${h.key}: ${h.value}`)
    .join("\n");
  updateTargetOptions();
  syncTransportFields();
  state.formVisible = true;
  renderStats();
}

function resetForm() {
  el.formTitle.textContent = "Create a flow";
  el.form.reset();
  field("source_type").value = "sse";
  field("target_type").value = "sse";
  field("route").value = "";
  updateTargetOptions();
  syncTransportFields();
}

function syncTransportFields() {
  const sourceType = field("source_type").value;
  const targetType = field("target_type").value;
  const showSourceUrl = sourceType !== "stdio";
  toggleField("sse_url", showSourceUrl);
  toggleField("headers", showSourceUrl);
  const showCommand = sourceType === "stdio" || targetType === "stdio";
  toggleField("command", showCommand);
  toggleField("args", showCommand);
  toggleField("env", showCommand);
  toggleField("allow_origins", showCommand);
  const targetSelect = field("target_type");
  const showOpenApi = sourceType === "openapi";
  toggleField("openapi_base_url", showOpenApi);
  toggleField("openapi_spec_url", showOpenApi);
  // When OpenAPI is selected, force target to streamable_http and lock other options
  if (targetSelect) {
    Array.from(targetSelect.options).forEach((opt) => {
      opt.disabled = showOpenApi && opt.value !== "streamable_http";
    });
    if (showOpenApi) {
      targetSelect.value = "streamable_http";
    }
  }
  if (showOpenApi) {
    toggleField("sse_url", false);
    toggleField("headers", false);
    toggleField("command", false);
    toggleField("args", false);
    toggleField("env", false);
    toggleField("allow_origins", false);
  }
  updateTargetOptions();
}

function toggleField(id, visible) {
  const wrapper = field(id).closest("label") || field(id).closest(".grid-2");
  if (!wrapper) return;
  wrapper.style.display = visible ? "" : "none";
}

function pushFeed(type, message, ts = Date.now() / 1000) {
  state.feed.unshift({ type, message, ts });
  if (!state.persistEvents) {
    state.feed = state.feed.slice(0, 80);
    localStorage.removeItem("mcp_feed");
  } else {
    try {
      const key = state.bootId ? `mcp_feed_${state.bootId}` : "mcp_feed";
      localStorage.setItem(key, JSON.stringify(state.feed.slice(0, 200)));
    } catch (_) {
      // ignore quota errors
    }
  }
  renderFeed();
  renderStats();
}

function showToast(message, type = "info", duration = 3000) {
  if (!el.toast) return;
  el.toast.textContent = message;
  el.toast.className = `toast toast--${type}`;
  el.toast.classList.remove("hidden");
  if (state.toastTimer) {
    clearTimeout(state.toastTimer);
  }
  state.toastTimer = setTimeout(() => {
    el.toast.classList.add("hidden");
  }, duration);
}

async function updateAutoStart(flow, value) {
  try {
    const payload = {
      name: flow.name,
      route: flow.route,
      description: flow.description,
      source_type: flow.source_type,
      target_type: flow.target_type,
      sse_url: flow.sse_url,
      openapi_base_url: flow.openapi_base_url,
      openapi_spec_url: flow.openapi_spec_url,
      command: flow.command,
      args: flow.args,
      env: flow.env,
      headers: flow.headers,
      allow_origins: flow.allow_origins,
      auto_start: value,
    };
    await fetchJSON(`/api/flows/${flow.id}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    pushFeed("info", `Auto-start ${value ? "enabled" : "disabled"} for ${flow.name}`);
    await loadFlows(false, false);
  } catch (err) {
    pushFeed("error", `Failed to update auto-start: ${err.message}`);
  }
}

async function toggleInspector() {
  el.toggleInspector.disabled = true;
  el.openInspector.disabled = true;
  const originalLabel = el.toggleInspector.textContent;
  try {
    const st = await fetchJSON("/api/inspector/state");
    if (st.running) {
      el.toggleInspector.textContent = "Stopping...";
      await fetchJSON("/api/inspector/stop", { method: "POST" });
      pushFeed("info", "Inspector stopped");
    } else {
      el.toggleInspector.textContent = "Starting...";
      await fetchJSON("/api/inspector/start", { method: "POST", body: JSON.stringify({}) });
      pushFeed("success", "Inspector started, waiting for URL...");
      const url = await waitInspectorUrl();
      state.inspectorUrl = url;
      el.openInspector.disabled = !url;
      if (url) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        await new Promise((resolve) => setTimeout(resolve, 2000));
        window.open(url, "_blank");
        pushFeed("success", `Inspector prêt : ${url}`);
      } else {
        pushFeed("warn", "Inspector started but URL not detected");
      }
    }
  } catch (err) {
    pushFeed("error", err.message);
  } finally {
    await refreshInspectorButton();
    el.toggleInspector.textContent = originalLabel;
    el.toggleInspector.disabled = false;
  }
}

async function startAllFlows(silent = false, onlyAuto = false) {
  const toStart = state.flows.filter((f) => !f.state.running && (!onlyAuto || f.auto_start !== false));
  if (!toStart.length) {
    if (!silent) pushFeed("info", "No flow to start");
    return;
  }
  if (!silent) {
    el.startAll.textContent = onlyAuto ? "Starting auto..." : "Starting...";
    el.startAll.disabled = true;
  }
  for (const flow of toStart) {
    try {
      await fetchJSON(`/api/flows/${flow.id}/start`, { method: "POST" });
      if (!silent) pushFeed("info", `Flow ${flow.name} started`);
    } catch (err) {
      pushFeed("error", `Failed to start ${flow.name}: ${err.message}`);
    }
  }
  await loadFlows(!silent, false);
}

async function stopAllFlows() {
  state.stoppingAllFlows = true;
  renderStats();
  const toStop = state.flows.filter((f) => f.state.running);
  if (!toStop.length) {
    pushFeed("info", "No flow to stop");
    state.stoppingAllFlows = false;
    renderStats();
    return;
  }
  for (const flow of toStop) {
    try {
      await fetchJSON(`/api/flows/${flow.id}/stop`, { method: "POST" });
      pushFeed("info", `Flow ${flow.name} stopped`);
    } catch (err) {
      pushFeed("error", `Failed to stop ${flow.name}: ${err.message}`);
    }
  }
  await loadFlows(true, false);
  state.stoppingAllFlows = false;
  renderStats();
}

async function waitInspectorUrl(timeout = 10000, interval = 400) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const st = await fetchJSON("/api/inspector/state");
      if (st.running && st.url) {
        return st.url;
      }
    } catch (err) {
      pushFeed("error", err.message);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  // If failed, try to stop any running process to reset state
  try {
    await fetchJSON("/api/inspector/stop", { method: "POST" });
  } catch (_) {
    // ignore
  }
  return null;
}

async function autoStartInspectorIfNeeded() {
  const auto = state.autoStartInspector;
  const bootKey = localStorage.getItem("mcp_auto_start_inspector_boot");
  if (!auto || !state.bootId || state.inspectorAutoStarted || bootKey === state.bootId) return;
  try {
    state.autoStartingInspector = true;
    renderStats();
    if (!state.autoStartInspectorStartedLogged) {
      pushFeed("info", "Auto-start Inspector in progress...");
      showToast("Auto-starting Inspector...", "info", 2500);
      state.autoStartInspectorStartedLogged = true;
    }
    el.toggleInspector.disabled = true;
    el.openInspector.disabled = true;
    el.toggleInspector.textContent = "⛔";
    await fetchJSON("/api/inspector/start", { method: "POST", body: JSON.stringify({}) });
    const url = await waitInspectorUrl();
    state.inspectorUrl = url;
    el.openInspector.disabled = !url;
    state.inspectorAutoStarted = true;
    sessionStorage.setItem("mcp_auto_started_inspector_boot", state.bootId);
    localStorage.setItem("mcp_auto_start_inspector_boot", state.bootId);
    if (!state.autoStartInspectorLogged) {
      pushFeed("info", "Inspector auto-start done");
      state.autoStartInspectorLogged = true;
    }
  } catch (err) {
    pushFeed("error", `Auto-start inspector: ${err.message}`);
  } finally {
    state.autoStartingInspector = false;
    renderStats();
    el.toggleInspector.textContent = "Start/Stop";
    el.toggleInspector.disabled = false;
    await refreshInspectorButton();
  }
}

async function ensureInspectorRunning() {
  const stateInfo = await fetchJSON("/api/inspector/state");
  if (!stateInfo.running) {
    el.toggleInspector.disabled = true;
    el.toggleInspector.textContent = "Starting...";
    await fetchJSON("/api/inspector/start", { method: "POST", body: JSON.stringify({}) });
    const url = await waitInspectorUrl();
    el.toggleInspector.disabled = false;
    el.toggleInspector.textContent = "Start/Stop";
    state.inspectorUrl = url;
    el.openInspector.disabled = !url;
    return url;
  }
  const url = stateInfo.url || (await waitInspectorUrl());
  state.inspectorUrl = url;
  el.openInspector.disabled = !url;
  return url;
}

function buildInspectorUrl(flow) {
  if (!state.inspectorUrl) return null;
  const baseHost = state.inspectorHost || state.settings.inspector_public_host || "localhost";
  const url = new URL(state.inspectorUrl);
  url.host = `${baseHost}:${url.port || 6274}`;
  if (flow) {
    const isStream = flow.target_type === "streamable_http";
    const isOpenApi = flow.target_type === "openapi";
    const targetPort = isOpenApi ? state.settings.openapi_port : isStream ? state.settings.stream_port : state.settings.sse_port;
    const endpointPath = isOpenApi ? "openapi" : isStream ? "mcp" : "sse";
    const targetHost = isOpenApi
      ? state.settings.inspector_public_host || "host.docker.internal"
      : state.settings.host;
    const targetUrl = `http://${targetHost}:${targetPort}/${flow.route || flow.name}/${endpointPath}`;
    url.searchParams.set("transportType", isOpenApi ? "openapi" : isStream ? "streamable-http" : "sse");
    url.searchParams.set("serverUrl", targetUrl);
  }
  return url.toString();
}

function buildOpenApiDocsUrl(flow) {
  const host = state.settings.inspector_public_host || state.settings.host || "localhost";
  const port = state.settings.openapi_port;
  const route = flow.route || flow.name;
  return `http://${host}:${port}/${route}/docs`;
}

function renderFeed() {
  el.liveFeed.innerHTML = "";
  if (!state.feed.length) {
    el.liveFeed.innerHTML = `<div class="empty">Waiting for events...</div>`;
    return;
  }
  state.feed.forEach((item) => {
    const row = document.createElement("div");
    row.className = `feed__item feed__item--${item.type}`;
    row.innerHTML = `
      <div>
        <p class="feed__time">${formatter.format(new Date(item.ts * 1000))}</p>
        <p>${item.message}</p>
      </div>
    `;
    el.liveFeed.appendChild(row);
  });
}

function connectEvents() {
  const es = new EventSource("/api/events");
  es.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === "log") {
        pushFeed("log", `[${data.flowId}] ${data.line}`, data.ts || Date.now() / 1000);
      }
      if (data.type === "flow_started") {
        pushFeed("success", `Flow ${data.flowId} started (pid ${data.pid})`, Date.now() / 1000);
        refreshFlowState(data.flowId, { running: true, pid: data.pid, port: data.port });
      }
      if (data.type === "flow_stopped") {
        pushFeed("warn", `Flow ${data.flowId} stopped (code ${data.code ?? "?"})`, data.stoppedAt || Date.now() / 1000);
        refreshFlowState(data.flowId, { running: false, exit_code: data.code });
      }
      if (data.type === "flow_exited") {
        pushFeed("warn", `Flow ${data.flowId} exited (code ${data.code ?? "?"})`, data.ts || Date.now() / 1000);
        refreshFlowState(data.flowId, { running: false, exit_code: data.code });
      }
      renderFlows();
    } catch (err) {
      console.error(err);
    }
  };
  es.onerror = () => {
    pushFeed("error", "SSE connection lost, reconnecting...");
    setTimeout(connectEvents, 2000);
  };
}

function refreshFlowState(flowId, newState) {
  const target = state.flows.find((f) => f.id === flowId);
  if (target) {
    target.state = { ...target.state, ...newState };
  }
}

async function handleSubmit(ev) {
  ev.preventDefault();
  const payload = serializeForm();
  try {
    if (payload.id) {
      await fetchJSON(`/api/flows/${payload.id}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      pushFeed("success", `Flow ${payload.name} updated`);
    } else {
      const created = await fetchJSON("/api/flows", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      pushFeed("success", `Flow ${created.name} created`);
    }
    resetForm();
    state.formVisible = false;
    renderStats();
    await loadFlows();
  } catch (err) {
    pushFeed("error", err.message);
  }
}

function bindEvents() {
  el.form.addEventListener("submit", handleSubmit);
  el.resetForm.addEventListener("click", resetForm);
  el.showOnlyRunning.addEventListener("change", (e) => {
    state.onlyRunning = e.target.checked;
    renderFlows();
  });
  el.search.addEventListener("input", (e) => {
    state.search = e.target.value;
    renderFlows();
  });
  el.modeFilter.addEventListener("change", (e) => {
    state.modeFilter = e.target.value;
    renderFlows();
  });
  field("source_type").addEventListener("change", syncTransportFields);
  field("target_type").addEventListener("change", syncTransportFields);
  el.clearFeed.addEventListener("click", () => {
    state.feed = [];
    renderFeed();
  });
  el.toggleInspector.addEventListener("click", toggleInspector);
  el.openInspector.addEventListener("click", () => {
    if (!state.inspectorUrl) {
      pushFeed("error", "URL Inspector inconnue");
      return;
    }
    window.open(state.inspectorUrl, "_blank");
  });
  if (el.startAll) {
    el.startAll.addEventListener("click", () => {
      if (state.autoStartingFlows || state.stoppingAllFlows) {
        pushFeed("info", "Bulk action in progress, please wait...");
        return;
      }
      const mode = el.startAll.dataset.mode;
      if (mode === "stop") {
        stopAllFlows();
      } else {
        startAllFlows();
      }
    });
  }
  if (el.autoStartToggle) {
    el.autoStartToggle.addEventListener("change", (e) => {
      state.autoStart = e.target.checked;
      localStorage.setItem("mcp_auto_start", state.autoStart ? "1" : "0");
    });
  }
  if (el.toggleForm) {
    el.toggleForm.addEventListener("click", () => {
      state.formVisible = true;
      resetForm();
      renderStats();
    });
  }
  if (el.closeForm) {
    el.closeForm.addEventListener("click", () => {
      state.formVisible = false;
      renderStats();
    });
  }
  if (el.toggleEvents) {
    el.toggleEvents.addEventListener("click", () => {
      state.eventsMinimized = !state.eventsMinimized;
      renderStats();
    });
  }
  if (el.openSettings) {
    el.openSettings.addEventListener("click", () => {
      state.settingsVisible = true;
      renderStats();
    });
  }
  if (el.closeSettings) {
    el.closeSettings.addEventListener("click", () => {
      state.settingsVisible = false;
      renderStats();
    });
  }
  // Click outside modals to close
  if (el.settingsModal) {
    el.settingsModal.addEventListener("click", (e) => {
      if (e.target === el.settingsModal) {
        state.settingsVisible = false;
        renderStats();
      }
    });
  }
  if (el.formModal) {
    el.formModal.addEventListener("click", (e) => {
      if (e.target === el.formModal) {
        state.formVisible = false;
        renderStats();
      }
    });
  }
  if (el.autoStartToggle) {
    el.autoStartToggle.addEventListener("change", (e) => {
      state.autoStart = e.target.checked;
      localStorage.setItem("mcp_auto_start", state.autoStart ? "1" : "0");
    });
  }
  if (el.persistEventsToggle) {
    el.persistEventsToggle.addEventListener("change", (e) => {
      state.persistEvents = e.target.checked;
      localStorage.setItem("mcp_persist_events", state.persistEvents ? "1" : "0");
      if (!state.persistEvents) {
        state.feed = [];
        renderFeed();
      }
    });
  }
  if (el.autoStartInspectorToggle) {
    el.autoStartInspectorToggle.addEventListener("change", (e) => {
      state.autoStartInspector = e.target.checked;
      localStorage.setItem("mcp_auto_start_inspector", state.autoStartInspector ? "1" : "0");
    });
  }
  if (el.inspectorHost) {
    el.inspectorHost.addEventListener("input", (e) => {
      state.inspectorHost = e.target.value || "localhost";
      localStorage.setItem("mcp_inspector_host", state.inspectorHost);
    });
  }
}

async function boot() {
  bindEvents();
  resetForm();
  state.autoStart = localStorage.getItem("mcp_auto_start") === "1";
  state.autoStartInspector = localStorage.getItem("mcp_auto_start_inspector") === "1";
  state.inspectorHost = localStorage.getItem("mcp_inspector_host") || "localhost";
  state.settingsVisible = false;
  state.formVisible = false;
  // ensure modals start hidden in DOM
  renderStats();
  await loadStatus();
  state.persistEvents = localStorage.getItem("mcp_persist_events") === "1";
  if (state.persistEvents) {
    const key = state.bootId ? `mcp_feed_${state.bootId}` : "mcp_feed";
    const savedFeed = localStorage.getItem(key);
    if (savedFeed) {
      try {
        state.feed = JSON.parse(savedFeed);
      } catch (_) {
        state.feed = [];
      }
      renderFeed();
    }
  }
  const sessionBoot = sessionStorage.getItem("mcp_auto_started_boot");
  const sessionInspectorBoot = sessionStorage.getItem("mcp_auto_started_inspector_boot");
  state.autoStartedSession =
    sessionStorage.getItem("mcp_auto_started_session") === "1" &&
    sessionBoot &&
    sessionBoot === state.bootId;
  state.inspectorAutoStarted =
    sessionInspectorBoot && state.bootId && sessionInspectorBoot === state.bootId;
  await loadSettings();
  await loadFlows(true, true);
  await autoStartInspectorIfNeeded();
  await refreshInspectorButton();
  connectEvents();
  renderFeed();
}

boot();
