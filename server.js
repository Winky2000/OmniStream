const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const SERVERS_FILE = path.join(__dirname, 'servers.json');
let servers = [];
try {
  if (fs.existsSync(SERVERS_FILE)) {
    servers = JSON.parse(fs.readFileSync(SERVERS_FILE));
  }
} catch (e) {
  console.error('Failed to read servers.json:', e.message);
}

const statuses = {}; // keyed by server.id

const defaultPathForType = (t) => {
  if (t === 'plex') return '/status/sessions';
  if (t === 'jellyfin') return '/System/Info';
  if (t === 'emby') return '/System/Info';
  return '/';
};

function summaryFromResponse(resp) {
  try {
    const d = resp.data;
    if (!d) return {};
    if (d.MediaContainer) return { type: 'plex', size: d.MediaContainer.size || null };
    if (typeof d === 'object') return { keys: Object.keys(d).slice(0, 6) };
    return { type: typeof d };
  } catch (e) {
    return {};
  }
}

async function pollServer(s) {
  const base = (s.baseUrl || '').replace(/\/$/, '');
  const pathSuffix = s.apiPath || defaultPathForType(s.type) || '/';
  let finalUrl = base + pathSuffix;
  const start = Date.now();
  const headers = {};

  if (s.token) {
    if (s.tokenLocation === 'header') {
      if (s.type === 'plex') headers['X-Plex-Token'] = s.token;
      else headers['X-Emby-Token'] = s.token;
    } else {
      const sep = finalUrl.includes('?') ? '&' : '?';
      if (s.type === 'plex') finalUrl += `${sep}X-Plex-Token=${encodeURIComponent(s.token)}`;
      else finalUrl += `${sep}X-Emby-Token=${encodeURIComponent(s.token)}`;
    }
  }

  try {
    const resp = await axios.get(finalUrl, { timeout: 10000, headers });
    const latency = Date.now() - start;
    statuses[s.id] = {
      id: s.id,
      name: s.name || s.baseUrl,
      type: s.type || 'generic',
      online: true,
      statusCode: resp.status,
      latency,
      summary: summaryFromResponse(resp),
      lastChecked: new Date().toISOString()
    };
  } catch (err) {
    const latency = Date.now() - start;
    statuses[s.id] = {
      id: s.id,
      name: s.name || s.baseUrl,
      type: s.type || 'generic',
      online: false,
      error: err.message,
      latency,
      lastChecked: new Date().toISOString()
    };
  }
}

async function pollAll() {
  if (!servers || servers.length === 0) return;
  await Promise.all(servers.map((s) => pollServer(s)));
}

pollAll();
setInterval(pollAll, 15 * 1000);

app.get('/api/status', (req, res) => {
  res.json({ servers, statuses });
});

app.get('/api/servers', (req, res) => res.json(servers));

app.post('/api/servers', (req, res) => {
  const s = req.body;
  if (!s || !s.baseUrl) return res.status(400).json({ error: 'baseUrl required' });
  s.id = s.id || Date.now().toString();
  servers.push(s);
  try {
    fs.writeFileSync(SERVERS_FILE, JSON.stringify(servers, null, 2));
  } catch (e) {
    console.error('Failed to write servers.json', e.message);
  }
  res.json(s);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`OmniStream listening on port ${PORT}`));
