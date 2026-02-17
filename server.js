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
  if (t === 'jellyfin') return '/Sessions';
  if (t === 'emby') return '/Sessions';
  return '/';
};

function summaryFromResponse(resp) {
  try {
    const d = resp.data;
    // Log session extraction for debugging
    if (d && d.MediaContainer && d.MediaContainer.Metadata) {
      d.MediaContainer.Metadata.forEach(m => {
        console.log('Session:', m.title, 'Type:', m.type, 'Thumb:', m.thumb);
      });
      // Debug: log poster URLs for all sessions
      d.MediaContainer.Metadata.forEach(m => {
        if (m.type === 'live') {
          console.log('Live TV session:', m.title, 'Poster:', m.thumb);
        }
      });
    }
    if (!d) return {};
    if (d.MediaContainer) {
      const sessions = (d.MediaContainer.Metadata || []).map(m => {
        // Live TV poster extraction
        let posterUrl;
        if (m.type === 'live' && m.thumb && resp.config && resp.config.serverConfig) {
          posterUrl = `${resp.config.serverConfig.baseUrl}${m.thumb}?X-Plex-Token=${encodeURIComponent(resp.config.serverConfig.token)}`;
        } else if (m.thumb && resp.config && resp.config.serverConfig) {
          posterUrl = `${resp.config.serverConfig.baseUrl}${m.thumb}?X-Plex-Token=${encodeURIComponent(resp.config.serverConfig.token)}`;
        }
        return {
          user: m.User?.title || 'Unknown',
          title: m.title || m.grandparentTitle || 'Unknown',
          episode: m.grandparentTitle ? m.title : undefined,
          year: m.year,
          platform: m.Player?.platform || m.Player?.product || '',
          state: m.Player?.state || '',
          poster: posterUrl,
          duration: m.duration ? Math.round(m.duration / 1000) : 0,
          viewOffset: m.viewOffset || 0,
          progress: m.duration ? Math.round((m.viewOffset || 0) / m.duration * 100) : 0
        };
      });
      return { type: 'plex', sessions, count: sessions.length };
    }
    if (Array.isArray(d) && d.length > 0 && d[0].NowPlayingItem) {
      // Jellyfin/Emby sessions
      const sessions = d.map(s => {
        let posterUrl;
        // Live TV poster extraction for Jellyfin/Emby
        if (s.NowPlayingItem?.Type === 'LiveTv' && s.NowPlayingItem?.ImageTags?.Primary && resp.config && resp.config.serverConfig) {
          posterUrl = `${resp.config.serverConfig.baseUrl}/Items/${s.NowPlayingItem.Id}/Images/Primary?api_key=${encodeURIComponent(resp.config.serverConfig.token)}`;
        } else if (s.NowPlayingItem?.ImageTags?.Primary && resp.config && resp.config.serverConfig) {
          posterUrl = `${resp.config.serverConfig.baseUrl}/Items/${s.NowPlayingItem.Id}/Images/Primary?api_key=${encodeURIComponent(resp.config.serverConfig.token)}`;
        }
        return {
          user: s.UserName || 'Unknown',
          title: s.NowPlayingItem?.Name || 'Idle',
          episode: s.NowPlayingItem?.EpisodeTitle,
          year: s.NowPlayingItem?.ProductionYear,
          platform: s.Client || s.DeviceName || '',
          state: s.PlayState?.PlayMethod || '',
          poster: posterUrl,
          duration: s.NowPlayingItem?.RunTimeTicks ? Math.round(s.NowPlayingItem.RunTimeTicks / 10000 / 1000) : 0,
          viewOffset: s.PlayState?.PositionTicks ? Math.round(s.PlayState.PositionTicks / 10000 / 1000) : 0,
          progress: (s.PlayState?.PositionTicks && s.NowPlayingItem?.RunTimeTicks) 
            ? Math.round(s.PlayState.PositionTicks / s.NowPlayingItem.RunTimeTicks * 100) 
            : 0
        };
      });
      return { type: 'jellyfin/emby', sessions, count: sessions.length };
    }
    if (typeof d === 'object') return { keys: Object.keys(d).slice(0, 6) };
    return { type: typeof d };
  } catch (e) {
    console.error('Session extraction error:', e);
    return {};
  }
}

async function pollServer(s) {
  const base = (s.baseUrl || '').replace(/\/$/, '');
  let pathSuffix = s.apiPath || defaultPathForType(s.type) || '/';
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
      // Attach server config for poster URL generation
      resp.config.serverConfig = {
        baseUrl: s.baseUrl,
        token: s.token || '',
        type: s.type || ''
      };
    const latency = Date.now() - start;
    const summary = summaryFromResponse(resp);
    
    statuses[s.id] = {
      id: s.id,
      name: s.name || s.baseUrl,
      type: s.type || 'generic',
      online: true,
      statusCode: resp.status,
      latency,
      sessions: summary.sessions || [],
      sessionCount: summary.count || 0,
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
      sessions: [],
      sessionCount: 0,
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
