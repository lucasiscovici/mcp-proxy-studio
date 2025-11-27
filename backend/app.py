import asyncio
import json
import os
import time
import uuid
import logging
import shlex
import socket
import secrets
import re
from urllib.parse import urlparse, urlunparse
import urllib.request
import urllib.error
import signal
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from .settings_store import Settings, SettingsStore
from .schemas import InspectorStart


BASE_DIR = Path(__file__).resolve().parent.parent
DATA_PATH = Path(os.environ.get("MCP_DASH_DATA", BASE_DIR / "data" / "flows.json"))
RUNTIME_DIR = DATA_PATH.parent / "runtime"
SETTINGS_PATH = DATA_PATH.parent / "settings.json"
FRONTEND_DIR = BASE_DIR / "frontend"
PROXY_BINARY = os.environ.get("MCP_PROXY_BIN", "mcp-proxy")
INSPECTOR_PORT = int(os.environ.get("MCP_INSPECTOR_PORT", "6275"))
INSPECTOR_SERVER_PORT = int(os.environ.get("MCP_INSPECTOR_SERVER_PORT", "6285"))
DEFAULT_INSPECTOR_SERVER_PORT = 6277
INSPECTOR_BIN = os.environ.get("MCP_INSPECTOR_BIN", "npx -y @modelcontextprotocol/inspector")
INSPECTOR_HOST = os.environ.get("MCP_INSPECTOR_HOST", "0.0.0.0")
INSPECTOR_PUBLIC_HOST = os.environ.get("MCP_INSPECTOR_PUBLIC_HOST", "localhost")
OPENAPI_BIN = os.environ.get("MCP_OPENAPI_BIN", "uvx mcpo")
BOOT_ID = str(uuid.uuid4())

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("mcp-dashboard")


class FlowMode(str, Enum):
    STDIO_TO_SSE = "stdio_to_sse"
    SSE_TO_STDIO = "sse_to_stdio"


class Transport(str, Enum):
    SSE = "sse"
    STREAMABLE_HTTP = "streamablehttp"


class EndpointType(str, Enum):
    STDIO = "stdio"
    SSE = "sse"
    STREAMABLE_HTTP = "streamable_http"
    OPENAPI = "openapi"


class Header(BaseModel):
    key: str
    value: str


class PreviousConfig(BaseModel):
    sse_url: Optional[str] = None
    transport: Optional[Transport] = None
    command: Optional[str] = None
    server_transport: Optional[Transport] = None


class FlowBase(BaseModel):
    name: str
    route: Optional[str] = None
    description: Optional[str] = None
    source_type: EndpointType = EndpointType.SSE
    target_type: EndpointType = EndpointType.SSE
    sse_url: Optional[str] = None
    openapi_base_url: Optional[str] = None
    openapi_spec_url: Optional[str] = None
    transport: Transport = Transport.SSE
    server_transport: Transport = Transport.SSE
    stateless: bool = False
    auto_start: bool = True
    command: Optional[str] = None
    args: List[str] = Field(default_factory=list)
    env: Dict[str, str] = Field(default_factory=dict)
    headers: List[Header] = Field(default_factory=list)
    allow_origins: List[str] = Field(default_factory=list)


class Flow(FlowBase):
    id: str
    created_at: float
    updated_at: float
    previous: PreviousConfig = PreviousConfig()


class FlowResponse(Flow):
    state: Dict[str, Any]
    logs: List[str] = Field(default_factory=list)
    last_event: Optional[float] = None


class FlowCreate(FlowBase):
    id: Optional[str] = None


class FlowUpdate(FlowBase):
    previous: Optional[PreviousConfig] = None


class FlowStore:
    def __init__(self, path: Path):
        self.path = path
        self.lock = asyncio.Lock()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
        if not self.path.exists():
            self.path.write_text("[]", encoding="utf-8")

    def _read(self) -> List[Flow]:
        if not self.path.exists():
            return []
        data = json.loads(self.path.read_text(encoding="utf-8") or "[]")
        return [Flow(**item) for item in data]

    def _write(self, flows: List[Flow]) -> None:
        self.path.write_text(json.dumps([f.model_dump() for f in flows], indent=2), encoding="utf-8")

    async def list(self) -> List[Flow]:
        async with self.lock:
            return self._read()

    async def get(self, flow_id: str) -> Flow:
        flows = await self.list()
        for flow in flows:
            if flow.id == flow_id:
                return flow
        raise HTTPException(status_code=404, detail="Flux introuvable")

    async def upsert(self, flow: Flow) -> None:
        async with self.lock:
            flows = self._read()
            updated = False
            for i, existing in enumerate(flows):
                if existing.id == flow.id:
                    flows[i] = flow
                    updated = True
                    break
            if not updated:
                flows.append(flow)
            self._write(flows)

    async def delete(self, flow_id: str) -> None:
        async with self.lock:
            flows = self._read()
            filtered = [f for f in flows if f.id != flow_id]
            if len(filtered) == len(flows):
                raise HTTPException(status_code=404, detail="Flux introuvable")
            self._write(filtered)

    async def find_by_route(self, route: str, target_type: Optional[EndpointType] = None) -> Optional[Flow]:
        flows = await self.list()
        for flow in flows:
            flow_route = flow.route or flow.name
            if flow_route == route and (target_type is None or flow.target_type == target_type):
                return flow
        return None


@dataclass
class ProcessInfo:
    label: str
    flow_ids: List[str]
    process: asyncio.subprocess.Process
    started_at: float
    command: List[str]
    port: Optional[int] = None
    mode: str = "unknown"
    logs: List[str] = field(default_factory=list)
    last_event: Optional[float] = None
    exit_code: Optional[int] = None


class EventBroadcaster:
    def __init__(self):
        self.listeners: List[asyncio.Queue] = []

    def register(self) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue(maxsize=100)
        self.listeners.append(queue)
        return queue

    def unregister(self, queue: asyncio.Queue) -> None:
        if queue in self.listeners:
            self.listeners.remove(queue)

    async def broadcast(self, payload: Dict[str, Any]) -> None:
        alive = []
        for queue in list(self.listeners):
            try:
                queue.put_nowait(payload)
                alive.append(queue)
            except asyncio.QueueFull:
                # Drop slow listeners
                continue
        self.listeners = alive


class ProcessManager:
    def __init__(self, broadcaster: EventBroadcaster):
        self.processes: Dict[int, ProcessInfo] = {}
        self.active_ports: Dict[int, set[str]] = {}
        self.broadcaster = broadcaster
        self.lock = asyncio.Lock()
        self.openapi_helpers: Dict[str, ProcessInfo] = {}

    async def start(self, flow: Flow) -> Dict[str, Any]:
        async with self.lock:
            await self._start_with_dependencies(flow, visited=set())
            return await self._state(flow.id)

    async def stop(self, flow_id: str) -> Dict[str, Any]:
        async with self.lock:
            # find port for this flow
            port = None
            for p, ids in self.active_ports.items():
                if flow_id in ids:
                    port = p
                    break
            if port is None:
                raise HTTPException(status_code=400, detail="Flux déjà arrêté")
            ids = self.active_ports.get(port, set())
            if flow_id in ids:
                ids.remove(flow_id)
            self.active_ports[port] = ids
            if not ids:
                await self._terminate_port(port)
            else:
                await self._restart_port(port)
            await self._stop_openapi_helper(flow_id)
            return await self._state(flow_id)

    async def test(self, flow: Flow) -> Dict[str, Any]:
        cmd, port = await self._build_command(flow, dry_run=True)
        logger.info("Test flow %s command preview: %s (port %s)", flow.id, " ".join(cmd), port)
        try:
            check = await asyncio.create_subprocess_exec(
                PROXY_BINARY, "--version", stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
            )
        except FileNotFoundError as exc:
            raise HTTPException(status_code=400, detail=f"binaire introuvable : {PROXY_BINARY}") from exc
        await check.communicate()
        return {"ok": True, "command": cmd, "port": port}

    async def logs(self, flow_id: str) -> List[str]:
        for info in self.processes.values():
            if flow_id in info.flow_ids:
                return info.logs[-200:]
        return []

    def _is_running(self, info: ProcessInfo) -> bool:
        return info.process and info.process.returncode is None

    def _port_open(self, port: int) -> bool:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                return True
        except OSError:
            return False

    async def _wait_port(self, port: int, timeout: float = 5.0) -> bool:
        start = time.time()
        while time.time() - start < timeout:
            if self._port_open(port):
                return True
            await asyncio.sleep(0.1)
        return False

    async def _pipe_logs(self, info: ProcessInfo) -> None:
        if not info.process.stdout:
            return
        try:
            while True:
                line = await info.process.stdout.readline()
                if not line:
                    break
                text = line.decode(errors="ignore").rstrip()
                info.logs.append(text)
                info.logs = info.logs[-200:]
                info.last_event = time.time()
                await self.broadcaster.broadcast(
                    {"type": "log", "flowId": info.label, "line": text, "ts": info.last_event}
                )
        finally:
            info.exit_code = info.process.returncode
            logger.info("Flow %s exited code=%s", info.label, info.exit_code)
            await self.broadcaster.broadcast(
                {
                    "type": "flow_exited",
                    "flowId": info.label,
                    "code": info.exit_code,
                    "ts": time.time(),
                }
            )
            try:
                flows = await store.list()
                for fid in info.flow_ids:
                    f = next((fl for fl in flows if fl.id == fid), None)
                    if f and f.source_type == EndpointType.OPENAPI:
                        await self._stop_openapi_helper(fid)
            except Exception as exc:  # pragma: no cover - best effort cleanup
                logger.warning("Failed to stop OpenAPI helper after exit: %s", exc)

    async def _build_command(self, flow: Flow, dry_run: bool = False) -> Tuple[List[str], Optional[int]]:
        """
        Build a Go mcp-proxy config v2 per flow and return the CLI invocation.
        """
        settings = await settings_store.get()
        chosen_port: Optional[int] = settings.stream_port if flow.target_type == EndpointType.STREAMABLE_HTTP else settings.sse_port
        base_url = f"http://{settings.host}:{chosen_port}"

        if flow.target_type == EndpointType.STDIO and not flow.command:
            raise HTTPException(status_code=400, detail="Commande requise pour une cible stdio")
        if flow.source_type == EndpointType.OPENAPI:
            if not flow.openapi_base_url or not flow.openapi_spec_url:
                raise HTTPException(status_code=400, detail="Base URL et spec OpenAPI requises")
        elif flow.source_type != EndpointType.STDIO and not flow.sse_url:
            raise HTTPException(status_code=400, detail="URL requise pour une source distante")
        if flow.source_type == EndpointType.STDIO and not flow.command:
            raise HTTPException(status_code=400, detail="Commande requise pour une source stdio")

        if flow.target_type == EndpointType.STDIO:
            proxy_type = "streamable-http" if flow.source_type == EndpointType.STREAMABLE_HTTP else "sse"
        else:
            proxy_type = "streamable-http" if flow.target_type == EndpointType.STREAMABLE_HTTP else "sse"

        server_key = flow.route or flow.name or "default"
        server_entry: Dict[str, Any]
        if flow.target_type == EndpointType.STDIO or flow.source_type == EndpointType.STDIO:
            server_entry = {
                "command": flow.command,
                "args": flow.args,
                "env": flow.env,
            }
        else:
            upstream_url = flow.sse_url
            if flow.source_type == EndpointType.OPENAPI:
                upstream_url = await self._ensure_openapi_helper(flow)
            server_entry = {
                "url": upstream_url,
                "headers": [{h.key: h.value} for h in flow.headers] if flow.headers else None,
                "transportType": "streamable-http"
                if flow.source_type == EndpointType.STREAMABLE_HTTP
                or flow.source_type == EndpointType.OPENAPI
                else "sse",
            }
        server_entry = {k: v for k, v in server_entry.items() if v not in (None, {}, [])}

        config = {
            "mcpProxy": {
                "baseURL": base_url,
                "addr": f":{chosen_port}",
                "name": flow.name,
                "version": "1.0.0",
                "type": proxy_type,
                "options": {"panicIfInvalid": False, "logEnabled": True},
            },
            "mcpServers": {
                server_key: server_entry,
            },
        }

        RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
        config_path = RUNTIME_DIR / f"{flow.id}.config.json"
        config_path.write_text(json.dumps(config, indent=2), encoding="utf-8")
        logger.info(
            "Built config for flows=%s proxy=%s port=%s config=%s",
            ",".join([server_key]),
            proxy_type,
            chosen_port,
            config_path,
        )
        cmd: List[str] = [PROXY_BINARY, "-config", str(config_path)]
        return cmd, chosen_port

    async def _state(self, flow_id: str) -> Dict[str, Any]:
        for port, info in self.processes.items():
            if flow_id in info.flow_ids and self._is_running(info):
                return {
                    "running": True,
                    "pid": info.process.pid if info.process else None,
                    "started_at": info.started_at,
                    "port": info.port,
                    "command": info.command,
                    "exit_code": info.exit_code,
                    "last_event": info.last_event,
                }
        return {"running": False}

    async def _port_for_flow(self, flow: Flow) -> int:
        settings = await settings_store.get()
        if flow.target_type == EndpointType.OPENAPI:
            return settings.openapi_port
        if flow.target_type == EndpointType.STREAMABLE_HTTP:
            return settings.stream_port
        return settings.sse_port

    async def _find_free_port(self) -> int:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.bind(("", 0))
            return s.getsockname()[1]

    async def _wait_upstream_ready(self, url: str, timeout: float = 12.0) -> bool:
        parsed = urlparse(url)
        if not parsed.scheme or not parsed.netloc:
            return False
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                req = urllib.request.Request(url, method="GET")
                with urllib.request.urlopen(req, timeout=2) as resp:
                    if resp.status != 404:
                        return True
            except urllib.error.HTTPError as exc:
                # If not 404, we consider the upstream reachable
                if exc.code != 404:
                    return True
            except Exception:
                pass
            await asyncio.sleep(0.5)
        return False

    async def _ensure_openapi_helper(self, flow: Flow) -> str:
        if not flow.openapi_base_url or not flow.openapi_spec_url:
            raise HTTPException(status_code=400, detail="Base URL et spec OpenAPI requises pour une source openapi")
        existing = self.openapi_helpers.get(flow.id)
        if existing and existing.process and existing.process.returncode is None:
            ready = await self._wait_port(existing.port)
            if ready:
                return f"http://127.0.0.1:{existing.port}/mcp"

        port = await self._find_free_port()
        cmd = [
            "npx",
            "-y",
            "@ivotoby/openapi-mcp-server",
            "--api-base-url",
            flow.openapi_base_url or "",
            "--openapi-spec",
            flow.openapi_spec_url or "",
            "--transport",
            "http",
            "--port",
            str(port),
        ]
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                preexec_fn=os.setsid,
            )
        except FileNotFoundError as exc:
            raise HTTPException(status_code=400, detail="binaire introuvable : npx") from exc
        info = ProcessInfo(
            label=f"openapi-{flow.id}",
            flow_ids=[flow.id],
            process=proc,
            started_at=time.time(),
            command=cmd,
            port=port,
            mode="openapi-helper",
        )
        self.openapi_helpers[flow.id] = info
        asyncio.create_task(self._pipe_logs(info))
        logger.info("Started OpenAPI helper for flow=%s on port=%s", flow.id, port)
        ready = await self._wait_port(port)
        if not ready:
            raise HTTPException(status_code=400, detail="Le serveur OpenAPI MCP n'a pas démarré à temps")
        # Give the helper time to finish initializing the MCP endpoint
        await asyncio.sleep(2.5)
        return f"http://127.0.0.1:{port}/mcp"

    async def _stop_openapi_helper(self, flow_id: str) -> None:
        info = self.openapi_helpers.get(flow_id)
        if not info:
            return
        if info.process and info.process.returncode is None:
            try:
                pgid = os.getpgid(info.process.pid)
                os.killpg(pgid, signal.SIGTERM)
                await asyncio.wait_for(info.process.wait(), timeout=5)
            except Exception:
                info.process.terminate()
                try:
                    await asyncio.wait_for(info.process.wait(), timeout=5)
                except asyncio.TimeoutError:
                    info.process.kill()
                    await info.process.wait()
        logger.info("Stopped OpenAPI helper for flow=%s (pid=%s)", flow_id, info.process.pid if info.process else None)
        self.openapi_helpers.pop(flow_id, None)

    async def _terminate_port(self, port: int) -> None:
        info = self.processes.get(port)
        if info and self._is_running(info):
            info.process.terminate()
            try:
                await asyncio.wait_for(info.process.wait(), timeout=5)
            except asyncio.TimeoutError:
                info.process.kill()
                await info.process.wait()
            info.exit_code = info.process.returncode
            logger.info("Port %s terminated code=%s", port, info.exit_code)
            # Best-effort cleanup of OpenAPI helpers linked to flows on this port
            for fid in getattr(info, "flow_ids", []):
                await self._stop_openapi_helper(fid)
        if port in self.processes:
            del self.processes[port]

    async def _restart_port(self, port: int) -> None:
        # Stop existing process if running
        await self._terminate_port(port)

        # Build combined config for all flows attached to this port
        ids = self.active_ports.get(port, set())
        flows = {f.id: f for f in await store.list() if f.id in ids}
        if not flows:
            logger.info("No flows for port %s, skipping restart", port)
            return

        settings = await settings_store.get()
        is_openapi = port == settings.openapi_port
        proxy_type = "openapi" if is_openapi else None
        if is_openapi:
            servers: Dict[str, Any] = {}
            # Allow upstream targets a brief moment to finish booting before mcpo starts
            await asyncio.sleep(0.5)
            for flow in flows.values():
                base_key = flow.route or flow.name or "default"
                server_key = base_key
                i = 1
                while server_key in servers:
                    server_key = f"{base_key}-{i}"
                    i += 1
                if flow.source_type == EndpointType.STDIO:
                    servers[server_key] = {
                        "command": flow.command,
                        "args": flow.args,
                        "env": flow.env,
                    }
                else:
                    upstream_url = flow.sse_url or ""
                    parsed = urlparse(upstream_url)
                    upstream_host = parsed.hostname or ""
                    if upstream_host in {"0.0.0.0", "localhost"}:
                        override_host = settings.inspector_public_host or "host.docker.internal"
                        netloc = f"{override_host}:{parsed.port}" if parsed.port else override_host
                        parsed = parsed._replace(netloc=netloc)
                        upstream_url = urlunparse(parsed)
                    if parsed.port:
                        ok = await self._wait_port(parsed.port, timeout=10)
                        if not ok:
                            logger.warning("Upstream port %s not ready for OpenAPI flow %s", parsed.port, flow.id)
                        else:
                            await asyncio.sleep(1.0)
                    # Extra readiness check: ensure upstream HTTP endpoint is reachable (non-404)
                    ready = await self._wait_upstream_ready(upstream_url, timeout=12)
                    if not ready:
                        logger.warning("Upstream endpoint %s not ready for OpenAPI flow %s", upstream_url, flow.id)
                        # Skip adding this server to avoid broken mcpo
                        continue
                servers[server_key] = {
                    "type": "streamable-http" if flow.source_type == EndpointType.STREAMABLE_HTTP else "sse",
                    "url": upstream_url,
                    "headers": {h.key: h.value for h in flow.headers} if flow.headers else None,
                }
                servers[server_key] = {k: v for k, v in servers[server_key].items() if v not in (None, {}, [])}
            config = {"mcpServers": servers}
            RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
            config_path = RUNTIME_DIR / f"port-{port}-openapi.config.json"
            config_path.write_text(json.dumps(config, indent=2), encoding="utf-8")
            cmd = shlex.split(OPENAPI_BIN) + ["--port", str(port), "--config", str(config_path), "--hot-reload"]
            logger.info(
                "Restarting OpenAPI port %s with flows=%s cmd=%s config=%s",
                port,
                ",".join(list(ids)),
                " ".join(cmd),
                config_path,
            )
        else:
            proxy_type = "streamable-http" if port == settings.stream_port else "sse"
            base_url = f"http://{settings.host}:{port}"

            servers: Dict[str, Any] = {}
            for flow in flows.values():
                base_key = flow.route or flow.name or "default"
                server_key = base_key
                i = 1
                while server_key in servers:
                    server_key = f"{base_key}-{i}"
                    i += 1
                if flow.source_type == EndpointType.STDIO or flow.target_type == EndpointType.STDIO:
                    servers[server_key] = {
                        "command": flow.command,
                        "args": flow.args,
                        "env": flow.env,
                    }
                else:
                    upstream_url = flow.sse_url
                    if flow.source_type == EndpointType.OPENAPI:
                        upstream_url = await self._ensure_openapi_helper(flow)
                    servers[server_key] = {
                        "url": upstream_url,
                        "headers": [{h.key: h.value} for h in flow.headers] if flow.headers else None,
                        "transportType": "streamable-http"
                        if flow.source_type == EndpointType.STREAMABLE_HTTP
                        or flow.source_type == EndpointType.OPENAPI
                        else "sse",
                    }
                servers[server_key] = {k: v for k, v in servers[server_key].items() if v not in (None, {}, [])}

            config = {
                "mcpProxy": {
                    "baseURL": base_url,
                    "addr": f":{port}",
                    "name": f"mcp-proxy-{proxy_type}",
                    "version": "1.0.0",
                    "type": proxy_type,
                    "options": {"panicIfInvalid": False, "logEnabled": True},
                },
                "mcpServers": servers,
            }

            RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
            config_path = RUNTIME_DIR / f"port-{port}.config.json"
            config_path.write_text(json.dumps(config, indent=2), encoding="utf-8")
            cmd = [PROXY_BINARY, "-config", str(config_path)]

            logger.info("Restarting port %s with flows=%s command=%s", port, ",".join(list(ids)), " ".join(cmd))
        try:
            process = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                env=os.environ.copy(),
            )
        except FileNotFoundError as exc:
            raise HTTPException(status_code=400, detail=f"binaire introuvable : {cmd[0]}") from exc

        info = ProcessInfo(
            label=f"port-{port}",
            flow_ids=list(ids),
            process=process,
            started_at=time.time(),
            command=cmd,
            port=port,
            mode=proxy_type,
        )
        self.processes[port] = info
        asyncio.create_task(self._pipe_logs(info))
        await self.broadcaster.broadcast(
            {"type": "flow_started", "flowId": info.label, "pid": process.pid, "port": port, "command": cmd}
        )

    async def _start_with_dependencies(self, flow: Flow, visited: set[str]) -> None:
        if flow.id in visited:
            return
        visited.add(flow.id)
        dependency = await self._resolve_dependency(flow)
        if dependency:
            await self._start_with_dependencies(dependency, visited)
        await self._activate_flow(flow)

    async def _activate_flow(self, flow: Flow) -> None:
        port = await self._port_for_flow(flow)
        active = self.active_ports.get(port, set())
        if flow.id not in active:
            active.add(flow.id)
            self.active_ports[port] = active
            await self._restart_port(port)

    async def _resolve_dependency(self, flow: Flow) -> Optional[Flow]:
        """
        If the source URL points to a local MCP endpoint produced by another flow,
        return that upstream flow so we can start it first.
        """
        if flow.source_type == EndpointType.STDIO:
            return None
        if not flow.sse_url:
            return None
        settings = await settings_store.get()
        parsed = urlparse(flow.sse_url)
        host = parsed.hostname or ""
        local_hosts = {
            "127.0.0.1",
            "localhost",
            "0.0.0.0",
            settings.host,
            settings.inspector_public_host or "",
        }
        if host not in local_hosts:
            return None
        port = parsed.port
        path_parts = [p for p in parsed.path.split("/") if p]
        if not port or len(path_parts) < 2:
            return None
        if port == settings.openapi_port:
            return None
        endpoint = path_parts[1]
        route = path_parts[0]
        target_type = EndpointType.STREAMABLE_HTTP if endpoint == "mcp" else EndpointType.SSE
        upstream = await store.find_by_route(route, target_type)
        return upstream


class InspectorManager:
    def __init__(self):
        self.process: Optional[asyncio.subprocess.Process] = None
        self.cmd: Optional[List[str]] = None
        self.url: Optional[str] = None
        self.ready: bool = False
        self.lock = asyncio.Lock()

    async def start(self, url: Optional[str] = None) -> Dict[str, Any]:
        async with self.lock:
            if self.process and self.process.returncode is None:
                await self._stop_process()
            token = secrets.token_hex(32)
            env = os.environ.copy()
            env["MCP_PROXY_AUTH_TOKEN"] = token
            env["MCP_AUTO_OPEN_ENABLED"] = "false"
            env["CLIENT_PORT"] = str(INSPECTOR_PORT)
            env["SERVER_PORT"] = str(INSPECTOR_SERVER_PORT)
            env["HOST"] = INSPECTOR_HOST
            settings = await settings_store.get()
            public_host = settings.inspector_public_host or INSPECTOR_PUBLIC_HOST
            cmd = shlex.split(INSPECTOR_BIN)
            self.url = f"http://{public_host}:{INSPECTOR_PORT}/?MCP_PROXY_AUTH_TOKEN={token}"
            if INSPECTOR_SERVER_PORT != DEFAULT_INSPECTOR_SERVER_PORT:
                self.url += "&MCP_PROXY_PORT=" + str(INSPECTOR_SERVER_PORT)
            self.ready = False
            logger.info("Starting MCP Inspector url=%s cmd=%s", self.url, " ".join(cmd))
            try:
                proc = await asyncio.create_subprocess_exec(
                    *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT, env=env
                )
            except FileNotFoundError as exc:
                raise HTTPException(status_code=400, detail=f"binaire introuvable : {cmd[0]}") from exc
            self.process = proc
            self.cmd = cmd
            asyncio.create_task(self._pipe_logs(proc))
            return self.state()

    async def stop(self) -> Dict[str, Any]:
        async with self.lock:
            await self._stop_process()
            return self.state()

    async def _stop_process(self) -> None:
        if self.process and self.process.returncode is None:
            self.process.terminate()
            try:
                await asyncio.wait_for(self.process.wait(), timeout=5)
            except asyncio.TimeoutError:
                self.process.kill()
                await self.process.wait()
        self.process = None
        self.cmd = None
        self.url = None

    async def _pipe_logs(self, proc: asyncio.subprocess.Process) -> None:
        if not proc.stdout:
            return
        while True:
            line = await proc.stdout.readline()
            if not line:
                break
            text = line.decode(errors="ignore").rstrip()
            logger.info("[inspector] %s", text)
            lower = text.lower()
            if "proxy server listening" in lower or "inspector is up" in lower:
                self.ready = True
        logger.info("Inspector process exited code=%s", proc.returncode)

    def state(self) -> Dict[str, Any]:
        url = self.url if self.ready else None
        return {
            "running": self.process is not None and self.process.returncode is None,
            "cmd": self.cmd,
            "url": url,
            "port": INSPECTOR_PORT,
            "pid": self.process.pid if self.process else None,
        }


store = FlowStore(DATA_PATH)
broadcaster = EventBroadcaster()
settings_store = SettingsStore(SETTINGS_PATH)
manager = ProcessManager(broadcaster)
inspector = InspectorManager()

app = FastAPI(title="MCP Proxy Dashboard", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

if FRONTEND_DIR.exists():
    app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")


@app.get("/api/flows", response_model=List[FlowResponse])
async def list_flows() -> List[FlowResponse]:
    flows = await store.list()
    # Refresh state to reflect running proxies even after reload
    result = []
    for flow in flows:
        state = await manager._state(flow.id)
        logs = await manager.logs(flow.id)
        result.append(FlowResponse(**flow.model_dump(), state=state, logs=logs, last_event=state.get("last_event")))
    return result


@app.post("/api/flows", response_model=FlowResponse)
async def create_flow(flow: FlowCreate) -> FlowResponse:
    flow_id = flow.id or str(uuid.uuid4())
    now = time.time()
    if flow.source_type == EndpointType.OPENAPI and flow.target_type != EndpointType.STREAMABLE_HTTP:
        raise HTTPException(status_code=400, detail="Une source openapi doit cibler le mode streamable_http")
    payload = flow.model_dump(exclude={"id"})
    payload["route"] = payload.get("route") or payload.get("name")
    payload["transport"] = (
        Transport.STREAMABLE_HTTP
        if flow.source_type in (EndpointType.STREAMABLE_HTTP, EndpointType.OPENAPI)
        else Transport.SSE
    )
    exposed = (
        Transport.STREAMABLE_HTTP
        if flow.target_type == EndpointType.STREAMABLE_HTTP
        or (flow.target_type == EndpointType.STDIO and flow.source_type == EndpointType.STREAMABLE_HTTP)
        else Transport.SSE
    )
    payload["server_transport"] = exposed
    new_flow = Flow(**payload, id=flow_id, created_at=now, updated_at=now)
    await store.upsert(new_flow)
    logger.info("Flow created %s (source=%s target=%s)", flow_id, flow.source_type, flow.target_type)
    state = await manager._state(flow_id)
    return FlowResponse(**new_flow.model_dump(), state=state, logs=[], last_event=state.get("last_event"))


@app.put("/api/flows/{flow_id}", response_model=FlowResponse)
async def update_flow(flow_id: str, payload: FlowUpdate) -> FlowResponse:
    existing = await store.get(flow_id)
    data = existing.model_dump()
    incoming = payload.model_dump()
    data.update({k: v for k, v in incoming.items() if v is not None})
    if data.get("source_type") == EndpointType.OPENAPI and data.get("target_type") != EndpointType.STREAMABLE_HTTP:
        raise HTTPException(status_code=400, detail="Une source openapi doit cibler le mode streamable_http")

    if not data.get("route"):
        data["route"] = data.get("name")

    # Capture previous config when fields change
    prev = PreviousConfig(**(existing.previous.model_dump() if hasattr(existing, "previous") else {}))
    if existing.sse_url != payload.sse_url or existing.transport != payload.transport:
        prev.sse_url = existing.sse_url
        prev.transport = existing.transport
    if existing.command != payload.command or existing.server_transport != payload.server_transport:
        prev.command = existing.command
        prev.server_transport = existing.server_transport
    data["previous"] = prev
    data["route"] = data.get("route") or data.get("name")
    data["transport"] = (
        Transport.STREAMABLE_HTTP
        if data.get("source_type") in (EndpointType.STREAMABLE_HTTP, EndpointType.OPENAPI)
        else Transport.SSE
    )
    data["server_transport"] = (
        Transport.STREAMABLE_HTTP
        if data.get("target_type") == EndpointType.STREAMABLE_HTTP
        or (data.get("target_type") == EndpointType.STDIO and data.get("source_type") == EndpointType.STREAMABLE_HTTP)
        else Transport.SSE
    )

    data["updated_at"] = time.time()
    updated_flow = Flow(**data)
    await store.upsert(updated_flow)
    logger.info("Flow updated %s (source=%s target=%s)", flow_id, updated_flow.source_type, updated_flow.target_type)
    state = await manager._state(flow_id)
    logs = await manager.logs(flow_id)
    return FlowResponse(**updated_flow.model_dump(), state=state, logs=logs, last_event=state.get("last_event"))


@app.delete("/api/flows/{flow_id}")
async def delete_flow(flow_id: str) -> Dict[str, str]:
    await store.delete(flow_id)
    # Remove from active sets and restart/terminate if needed
    async with manager.lock:
        target_port = None
        for p, ids in manager.active_ports.items():
            if flow_id in ids:
                target_port = p
                ids.remove(flow_id)
                manager.active_ports[p] = ids
                break
        if target_port is not None:
            if manager.active_ports[target_port]:
                await manager._restart_port(target_port)
            else:
                await manager._terminate_port(target_port)
        await manager._stop_openapi_helper(flow_id)
    config_path = RUNTIME_DIR / f"{flow_id}.config.json"
    if config_path.exists():
        config_path.unlink()
    logger.info("Flow deleted %s", flow_id)
    return {"status": "deleted"}


@app.get("/api/settings", response_model=Settings)
async def get_settings() -> Settings:
    return await settings_store.get()


class SettingsUpdate(BaseModel):
    host: str = "0.0.0.0"
    openapi_port: int = 8003
    sse_port: int = 8002
    stream_port: int = 8001
    inspector_public_host: str = "localhost"


@app.put("/api/settings", response_model=Settings)
async def update_settings(payload: SettingsUpdate) -> Settings:
    return Settings(
        host=payload.host,
        sse_port=payload.sse_port,
        stream_port=payload.stream_port,
        inspector_public_host=payload.inspector_public_host,
        openapi_port=getattr(payload, "openapi_port", Settings().openapi_port),
    )


@app.post("/api/flows/{flow_id}/start", response_model=Dict[str, Any])
async def start_flow(flow_id: str) -> Dict[str, Any]:
    flow = await store.get(flow_id)
    return await manager.start(flow)


@app.post("/api/flows/{flow_id}/stop", response_model=Dict[str, Any])
async def stop_flow(flow_id: str) -> Dict[str, Any]:
    return await manager.stop(flow_id)


@app.post("/api/flows/{flow_id}/test", response_model=Dict[str, Any])
async def test_flow(flow_id: str) -> Dict[str, Any]:
    flow = await store.get(flow_id)
    return await manager.test(flow)


@app.get("/api/flows/{flow_id}/logs", response_model=List[str])
async def get_logs(flow_id: str) -> List[str]:
    return await manager.logs(flow_id)


@app.post("/api/inspector/stop", response_model=Dict[str, Any])
async def stop_inspector() -> Dict[str, Any]:
    return await inspector.stop()


@app.post("/api/inspector/start", response_model=Dict[str, Any])
async def start_inspector_body(payload: InspectorStart) -> Dict[str, Any]:
    return await inspector.start(payload.url)


@app.get("/api/inspector/state", response_model=Dict[str, Any])
async def inspector_state() -> Dict[str, Any]:
    return inspector.state()


@app.get("/api/status", response_model=Dict[str, Any])
async def status() -> Dict[str, Any]:
    return {"bootId": BOOT_ID}


@app.get("/api/events")
async def events() -> StreamingResponse:
    queue = broadcaster.register()

    async def event_stream():
        try:
            while True:
                event = await queue.get()
                yield f"data: {json.dumps(event)}\n\n"
        except asyncio.CancelledError:
            raise
        finally:
            broadcaster.unregister(queue)

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@app.get("/")
async def root() -> FileResponse:
    index_path = FRONTEND_DIR / "index.html"
    if not index_path.exists():
        raise HTTPException(status_code=404, detail="Frontend manquant")
    return FileResponse(index_path)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8000")), reload=True)
