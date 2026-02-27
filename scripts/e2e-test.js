#!/usr/bin/env node

/*
  Cross-platform E2E smoke test for OmniStream.

  - Backs up existing ./config.json and ./servers.json (if present)
  - Writes a test config with auth.mode=nginx (no interactive login)
  - Writes a test servers.json pointing at the local mock server
  - Starts mock_server.js and server.js on dedicated ports
  - Polls /api/status until it returns expected mock servers
  - Shuts down processes and restores original files
*/

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const SERVERS_PATH = path.join(ROOT, 'servers.json');
const SERVERS_TEST_PATH = path.join(ROOT, 'servers.test.json');

const MOCK_PORT = Number(process.env.OMNISTREAM_E2E_MOCK_PORT || 4100);
const APP_PORT = Number(process.env.OMNISTREAM_E2E_APP_PORT || 3100);

const TIMEOUT_MS = Number(process.env.OMNISTREAM_E2E_TIMEOUT_MS || 25000);
const POLL_INTERVAL_MS = 400;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function readFileIfExists(p) {
  try {
    if (!fs.existsSync(p)) return null;
    const st = fs.statSync(p);
    if (!st.isFile()) return null;
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function writeUtf8NoBom(p, text) {
  fs.writeFileSync(p, String(text), { encoding: 'utf8' });
}

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        const statusCode = res.statusCode || 0;
        if (statusCode < 200 || statusCode >= 300) {
          return reject(Object.assign(new Error(`HTTP ${statusCode}`), { statusCode, body: data }));
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(Object.assign(new Error('Failed to parse JSON'), { cause: e, body: data }));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => {
      req.destroy(new Error('Request timeout'));
    });
  });
}

function spawnNode(scriptFile, env, label) {
  const nodeExe = process.execPath;
  const child = spawn(nodeExe, [scriptFile], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const outPath = path.join(ROOT, `omnistream-${label}.out.log`);
  const errPath = path.join(ROOT, `omnistream-${label}.err.log`);
  const outStream = fs.createWriteStream(outPath, { flags: 'w' });
  const errStream = fs.createWriteStream(errPath, { flags: 'w' });
  child.stdout.pipe(outStream);
  child.stderr.pipe(errStream);

  child.on('exit', (code, signal) => {
    outStream.end();
    errStream.end();
  });

  return child;
}

async function killProcess(child, label) {
  if (!child) return;
  if (child.exitCode !== null) return;

  try {
    child.kill('SIGTERM');
  } catch {
    // ignore
  }

  // Give it a moment, then force.
  const start = Date.now();
  while (Date.now() - start < 1500) {
    if (child.exitCode !== null) return;
    await sleep(100);
  }

  try {
    child.kill('SIGKILL');
  } catch {
    // On Windows SIGKILL is not real; still ok.
    try { child.kill(); } catch {}
  }
}

function buildTestServers(mockPort) {
  const raw = readFileIfExists(SERVERS_TEST_PATH);
  if (!raw) {
    throw new Error('servers.test.json not found');
  }
  let parsed;
  try {
    parsed = JSON.parse(String(raw).replace(/^\uFEFF/, '').trim());
  } catch (e) {
    throw new Error(`Failed to parse servers.test.json: ${e.message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error('servers.test.json must be a JSON array');
  }
  return parsed.map(s => {
    const baseUrl = `http://localhost:${mockPort}`;
    return { ...s, baseUrl };
  });
}

async function main() {
  const backups = {
    config: { existed: fs.existsSync(CONFIG_PATH), text: readFileIfExists(CONFIG_PATH) },
    servers: { existed: fs.existsSync(SERVERS_PATH), text: readFileIfExists(SERVERS_PATH) }
  };

  let mockProc = null;
  let appProc = null;
  let mockExit = null;
  let appExit = null;

  const startTs = Date.now();

  try {
    // Prepare test files
    const testConfig = { auth: { mode: 'nginx' } };
    writeUtf8NoBom(CONFIG_PATH, JSON.stringify(testConfig, null, 2) + os.EOL);

    const testServers = buildTestServers(MOCK_PORT);
    writeUtf8NoBom(SERVERS_PATH, JSON.stringify(testServers, null, 2) + os.EOL);

    // Start processes
    console.log(`[E2E] Starting mock_server.js on port ${MOCK_PORT}...`);
    mockProc = spawnNode('mock_server.js', { PORT: String(MOCK_PORT) }, 'mock');
    mockProc.on('exit', (code, signal) => { mockExit = { code, signal }; });

    console.log(`[E2E] Starting server.js on port ${APP_PORT}...`);
    appProc = spawnNode('server.js', { PORT: String(APP_PORT) }, 'app');
    appProc.on('exit', (code, signal) => { appExit = { code, signal }; });

    // Poll /api/status
    const url = `http://localhost:${APP_PORT}/api/status`;
    console.log(`[E2E] Polling ${url} (timeout ${TIMEOUT_MS}ms)...`);

    let lastErr = null;
    while (Date.now() - startTs < TIMEOUT_MS) {
      if (mockExit && mockExit.code !== 0) {
        throw new Error(`[E2E] FAIL: mock_server.js exited early (code=${String(mockExit.code)}, signal=${String(mockExit.signal)}). Check omnistream-mock.err.log / omnistream-mock.out.log.`);
      }
      if (appExit && appExit.code !== 0) {
        throw new Error(`[E2E] FAIL: server.js exited early (code=${String(appExit.code)}, signal=${String(appExit.signal)}). Check omnistream-app.err.log / omnistream-app.out.log.`);
      }
      try {
        const status = await httpGetJson(url);
        const servers = Array.isArray(status && status.servers) ? status.servers : [];
        const ids = new Set(servers.map(s => String(s && s.id)));
        const statuses = status && typeof status.statuses === 'object' && status.statuses ? status.statuses : {};
        const plexOk = statuses['mock-plex'] && statuses['mock-plex'].online === true;
        const jellyOk = statuses['mock-jelly'] && statuses['mock-jelly'].online === true;

        if (ids.has('mock-plex') && ids.has('mock-jelly') && plexOk && jellyOk) {
          console.log('[E2E] PASS: /api/status returned expected mock servers and both are online');
          return;
        }

        if (!ids.has('mock-plex') || !ids.has('mock-jelly')) {
          lastErr = new Error(`Unexpected server ids: ${Array.from(ids).join(', ')}`);
        } else {
          lastErr = new Error(`Servers not online yet (mock-plex online=${String(plexOk)}, mock-jelly online=${String(jellyOk)})`);
        }
      } catch (e) {
        lastErr = e;
      }

      await sleep(POLL_INTERVAL_MS);
    }

    const msg = lastErr ? (lastErr.body ? `${lastErr.message}: ${lastErr.body}` : lastErr.message) : 'unknown error';
    throw new Error(`[E2E] FAIL: Timed out waiting for expected response (${msg}). Check omnistream-app.err.log / omnistream-app.out.log.`);

  } finally {
    await killProcess(appProc, 'app');
    await killProcess(mockProc, 'mock');

    // Restore config.json
    try {
      if (backups.config.existed && backups.config.text !== null) {
        writeUtf8NoBom(CONFIG_PATH, backups.config.text);
      } else {
        if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
      }
    } catch (e) {
      console.warn(`[E2E] Warning: failed to restore config.json: ${e.message}`);
    }

    // Restore servers.json
    try {
      if (backups.servers.existed && backups.servers.text !== null) {
        writeUtf8NoBom(SERVERS_PATH, backups.servers.text);
      } else {
        if (fs.existsSync(SERVERS_PATH)) fs.unlinkSync(SERVERS_PATH);
      }
    } catch (e) {
      console.warn(`[E2E] Warning: failed to restore servers.json: ${e.message}`);
    }
  }
}

main().catch((e) => {
  console.error(String(e && e.message ? e.message : e));
  process.exit(1);
});
