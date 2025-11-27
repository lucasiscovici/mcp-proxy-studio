import os, sys, shutil, subprocess
from pathlib import Path

def main():
    node = shutil.which("node")
    if not node:
        print("Erreur: 'node' est requis (installe Node.js).", file=sys.stderr)
        raise SystemExit(127)

    # repo layout: src/mcp_proxy_studio/bridge.py -> ../../bin/mcps.mjs
    mjs = Path(__file__).resolve().parents[2] / "bin" / "mcps.mjs"
    if not mjs.exists():
        print(f"Erreur: introuvable: {mjs}", file=sys.stderr)
        raise SystemExit(1)

    # on relaie args + env (REF, etc.)
    p = subprocess.run([node, str(mjs), *sys.argv[1:]], env=os.environ)
    raise SystemExit(p.returncode)
