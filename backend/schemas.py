from pydantic import BaseModel
from typing import Optional


class InspectorStart(BaseModel):
    url: Optional[str] = None
