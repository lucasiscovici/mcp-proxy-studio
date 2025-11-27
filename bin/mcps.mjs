#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const REPO = "lucasiscovici/MCP-Proxy-Studio";
const REF = process.env.REF || "main"; 
const PROJECT = "mcp_proxy_studio";

const TMP_BASE = path.join(os.tmpdir(), "mcp-proxy-studio");
const STATE = path.join(TMP_BASE, ".mcps-state.json");

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.error) {
    console.error(`[error] ${cmd}: ${r.error.message}`);
    process.exit(1);
  }
  if ((r.status ?? 0) !== 0) process.exit(r.status ?? 1);
}

function sha1(s) {
  return crypto.createHash("sha1").update(s).digest("hex").slice(0, 10);
}

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function downloadRepo(destDir, ref) {
  fs.mkdirSync(destDir, { recursive: true });
  const url = `https://codeload.github.com/${REPO}/tar.gz/${ref}`;
  run("bash", ["-lc", `curl -fsSL "${url}" | tar -xz -C "${destDir}" --strip-components=1`]);
}

const COMPOSE_NAMES = new Set([
  "compose.yaml", "compose.yml",
  "docker-compose.yaml", "docker-compose.yml"
]);

function findCompose(dir, maxDepth = 5) {
  const queue = [{ d: dir, depth: 0 }];
  const found = [];

  while (queue.length) {
    const { d, depth } = queue.shift();
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isFile() && COMPOSE_NAMES.has(e.name)) found.push(p);
      if (!e.isDirectory()) continue;
      if (depth >= maxDepth) continue;

      // ignore obvious heavy dirs
      if (e.name === "node_modules" || e.name === ".git" || e.name === "dist" || e.name === "build") continue;
      queue.push({ d: p, depth: depth + 1 });
    }
  }

  // scoring: prefer root-level compose, then shortest path
  found.sort((a, b) => {
    const ra = path.relative(dir, a).split(path.sep).length;
    const rb = path.relative(dir, b).split(path.sep).length;
    const aRoot = ra === 1 ? -100 : 0;
    const bRoot = rb === 1 ? -100 : 0;
    return (aRoot + ra) - (bRoot + rb);
  });

  return found[0] || null;
}

function usage() {
  console.log(`Usage:
  npx --yes github:${REPO} start
  npx --yes github:${REPO} status
  npx --yes github:${REPO} stop
  npx --yes github:${REPO} update

Env:
  REF=main|tag|sha   (optional)
Flags:
  --refresh          Re‑download the repo into `/tmp`
  --force            Stop/remove existing containers before start
`);
}

const cmd = process.argv[2];
const refresh = process.argv.includes("--refresh");
const force = process.argv.includes("--force");

if (!cmd || !["start", "status", "stop", "update"].includes(cmd)) {
  usage();
  process.exit(cmd ? 1 : 0);
}

const tmpDir = path.join(TMP_BASE, `${sha1(`${REPO}@${REF}`)}`);

if (refresh || !fs.existsSync(path.join(tmpDir, ".gitignore")) && !fs.existsSync(STATE)) {
  rmrf(tmpDir);
  downloadRepo(tmpDir, REF);
  fs.mkdirSync(path.join(tmpDir, "data"), { recursive: true });

  fs.writeFileSync(STATE, JSON.stringify({ repo: REPO, ref: REF, tmpDir }, null, 2), "utf8");
} else if (!fs.existsSync(tmpDir)) {
  downloadRepo(tmpDir, REF);
  fs.mkdirSync(path.join(tmpDir, "data"), { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify({ repo: REPO, ref: REF, tmpDir }, null, 2), "utf8");
}

const composePath = findCompose(tmpDir);
if (!composePath) {
  console.error(`Aucun fichier compose trouvé dans le repo cloné: ${tmpDir}`);
  console.error(`Cherchés: ${Array.from(COMPOSE_NAMES).join(", ")}`);
  process.exit(1);
}

const projectDir = path.dirname(composePath);
fs.mkdirSync(path.join(projectDir, "data"), { recursive: true });

const base = [
  "compose",
  "--project-directory", projectDir,
  "-f", composePath,
  "-p", PROJECT
];

const downArgs = force ? ["down", "-v", "--remove-orphans"] : ["down"];

if (cmd === "start") {
  if (force) run("docker", [...base, ...downArgs]);
  run("docker", [...base, "up", "-d", "--build"]);
}
if (cmd === "update") {
  rmrf(tmpDir);
  downloadRepo(tmpDir, REF);
  fs.mkdirSync(path.join(tmpDir, "data"), { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify({ repo: REPO, ref: REF, tmpDir }, null, 2), "utf8");
  if (force) run("docker", [...base, ...downArgs]);
  run("docker", [...base, "up", "-d", "--build"]);
}
if (cmd === "status") run("docker", [...base, "ps"]);
if (cmd === "stop") run("docker", [...base, ...downArgs]);
