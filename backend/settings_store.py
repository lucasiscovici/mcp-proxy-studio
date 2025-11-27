import asyncio
import json
from pathlib import Path
from typing import Optional

from pydantic import BaseModel


class Settings(BaseModel):
    host: str = "0.0.0.0"
    sse_port: int = 8002
    stream_port: int = 8001
    openapi_port: int = 8003
    inspector_public_host: str = "0.0.0.0"


class SettingsStore:
    def __init__(self, path: Path):
        self.path = path
        self.lock = asyncio.Lock()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if not self.path.exists():
            self.path.write_text(Settings().model_dump_json(indent=2), encoding="utf-8")

    async def get(self) -> Settings:
        # Ports/host are fixed; ignore file content if any
        return Settings()

    async def set(self, settings: Settings) -> Settings:
        # Settings are immutable; always return defaults
        return Settings()
