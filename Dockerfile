FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8000 \
    MCP_DASH_DATA=/data/flows.json \
    PATH="/usr/local/go/bin:/root/go/bin:${PATH}" \
    # upstreams des 3 APIs à observer (par défaut: mêmes ports en local)
    UPSTREAM_1="127.0.0.1:18001" \
    UPSTREAM_2="127.0.0.1:18002" \
    UPSTREAM_3="127.0.0.1:18003"

WORKDIR /app

RUN apt-get update && \
    apt-get install -y --no-install-recommends htop golang git ca-certificates nodejs npm supervisor python3-pip && \
    rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt ./backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt && \
    pip install --no-cache-dir uv 
    # && \
    # pip install --no-cache-dir mitmproxy

# Install Go mcp-proxy CLI
RUN GO111MODULE=on GOBIN=/usr/local/bin go install github.com/TBXark/mcp-proxy@latest

COPY backend ./backend
COPY frontend ./frontend

RUN mkdir -p /data

# # supervisor config
# COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf

# # app + proxies + UIs
# EXPOSE 8000 8001 8002 8003 9101 9102 9103

CMD ["uvicorn", "backend.app:app", "--host", "0.0.0.0", "--port", "8000"]

# CMD ["supervisord", "-n", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
