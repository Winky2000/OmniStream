// ...existing code...
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
// ...existing code...

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const SERVERS_FILE = path.join(__dirname, 'servers.json');
let servers = [];
try {
  if (fs.existsSync(SERVERS_FILE)) {
    const stat = fs.statSync(SERVERS_FILE);
    if (stat.isDirectory()) {
      console.error('[OmniStream] servers.json path is a directory, cannot use as config:', SERVERS_FILE);
    } else {
      const raw = fs.readFileSync(SERVERS_FILE, 'utf8');
      servers = raw ? JSON.parse(raw) : [];
    }
  } else {
    // Auto-create an empty servers.json file if it doesn't exist
    fs.writeFileSync(SERVERS_FILE, '[]', { encoding: 'utf8' });
    servers = [];
  }
} catch (e) {
  console.error('Failed to initialize servers.json:', e.message);
}

console.log('[OmniStream] Using servers file at', SERVERS_FILE);

// Edit/update server info (must be after app is defined)
app.put('/api/servers/:id', (req, res) => {
  const idx = servers.findIndex(s => s.id == req.params.id);
  if (idx === -1) return res.status(404).json({error:'Not found'});
  // Merge new data into existing server object
  servers[idx] = { ...servers[idx], ...req.body, id: servers[idx].id };
  try {
    fs.writeFileSync(SERVERS_FILE, JSON.stringify(servers, null, 2));
  } catch (e) {
    console.error('Failed to write servers.json after edit:', e.message);
    return res.status(500).json({
      error: 'Failed to save servers.json',
      detail: e.message,
      code: e.code || null
    });
  }
  res.json(servers[idx]);
});

const statuses = {}; // keyed by server.id
const MAX_HISTORY = 500;

// SQLite-backed history
const HISTORY_DB_FILE = path.join(__dirname, 'history.db');
let historyDb;
try {
  historyDb = new sqlite3.Database(HISTORY_DB_FILE);
  historyDb.serialize(() => {
    historyDb.run(
      'CREATE TABLE IF NOT EXISTS history (\n' +
      '  id INTEGER PRIMARY KEY AUTOINCREMENT,\n' +
      '  time TEXT NOT NULL,\n' +
      '  serverId TEXT,\n' +
      '  serverName TEXT,\n' +
      '  type TEXT,\n' +
      '  user TEXT,\n' +
      '  title TEXT,\n' +
      '  stream TEXT,\n' +
      '  transcoding INTEGER,\n' +
      '  location TEXT,\n' +
      '  bandwidth REAL\n' +
      ')'
    );
    historyDb.run('CREATE INDEX IF NOT EXISTS idx_history_time ON history(time)');
  });
  console.log('[OmniStream] Using history database at', HISTORY_DB_FILE);
} catch (e) {
  console.error('Failed to initialize history database:', e.message);
  historyDb = null;
}

const defaultPathForType = (t) => {
  if (t === 'plex') return '/status/sessions';
  if (t === 'jellyfin') return '/Sessions';
  if (t === 'emby') return '/Sessions';
  return '/';
};

// Import watch history helpers (currently implemented for Jellyfin)
async function importJellyfinHistory(server, { limitPerUser = 100 } = {}) {
  if (!historyDb) return { serverId: server.id, type: server.type, imported: 0, error: 'history DB not available' };
  const base = (server.baseUrl || '').replace(/\/$/, '');
  if (!server.token) {
    return { serverId: server.id, type: server.type, imported: 0, error: 'no token configured' };
  }
  const headers = { 'X-MediaBrowser-Token': server.token };
  try {
    // Get all visible users
    const usersResp = await axios.get(base + '/Users', { headers, timeout: 15000 });
    const users = Array.isArray(usersResp.data) ? usersResp.data : [];
    let imported = 0;
    // For each user, pull recently played movies/episodes
    for (const u of users) {
      if (!u || !u.Id) continue;
      const itemsResp = await axios.get(base + `/Users/${encodeURIComponent(u.Id)}/Items`, {
        headers,
        timeout: 20000,
        params: {
          Filters: 'IsPlayed',
          IncludeItemTypes: 'Movie,Episode',
          SortBy: 'DatePlayed',
          SortOrder: 'Descending',
          Limit: limitPerUser
        }
      });
      const items = itemsResp.data && itemsResp.data.Items ? itemsResp.data.Items : [];
      if (!items.length) continue;
      await new Promise((resolve) => {
        historyDb.serialize(() => {
          const stmt = historyDb.prepare(
            'INSERT INTO history (time, serverId, serverName, type, user, title, stream, transcoding, location, bandwidth) VALUES (?,?,?,?,?,?,?,?,?,?)'
          );
          items.forEach(it => {
            const time = (it.UserData && it.UserData.LastPlayedDate) || it.DatePlayed || new Date().toISOString();
            const title = it.SeriesName ? `${it.SeriesName} - ${it.Name}` : it.Name || 'Unknown';
            const mediaType = it.Type || it.MediaType || '';
            stmt.run(
              time,
              server.id,
              server.name || server.baseUrl,
              server.type,
              u.Name || u.Username || 'Unknown',
              title,
              mediaType,
              null,
              '',
              0
            );
            imported++;
          });
          stmt.finalize(() => resolve());
        });
      });
    }
    // Trim DB after import
    await new Promise((resolve) => {
      historyDb.run(
        'DELETE FROM history WHERE id NOT IN (SELECT id FROM history ORDER BY id DESC LIMIT ?)',
        [MAX_HISTORY],
        (err) => {
          if (err) console.error('Failed to trim history database after import:', err.message);
          resolve();
        }
      );
    });
    return { serverId: server.id, type: server.type, imported };
  } catch (e) {
    console.error(`Failed to import Jellyfin history for ${server.name || server.baseUrl}:`, e.message);
    return { serverId: server.id, type: server.type, imported: 0, error: e.message };
  }
}

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
    if (!d) {
      // Always return a summary object, even if no data
      return {
        type: 'unknown',
        sessions: [],
        count: 0,
        summary: {
          directPlays: 0,
          transcodes: 0,
          totalBandwidth: 0,
          lanBandwidth: 0,
          wanBandwidth: 0
        }
      };
    }
    if (d.MediaContainer) {
      const sessions = (d.MediaContainer.Metadata || []).map(m => {
        let posterUrl;
        if (m.type === 'live' && m.thumb && resp.config && resp.config.serverConfig) {
          posterUrl = `${resp.config.serverConfig.baseUrl}${m.thumb}?X-Plex-Token=${encodeURIComponent(resp.config.serverConfig.token)}`;
        } else if (m.thumb && resp.config && resp.config.serverConfig) {
          posterUrl = `${resp.config.serverConfig.baseUrl}${m.thumb}?X-Plex-Token=${encodeURIComponent(resp.config.serverConfig.token)}`;
        }
        // Robust transcoding detection for Plex
        let transcoding = false;
        if (m.Media && Array.isArray(m.Media)) {
          for (const media of m.Media) {
            if (media.Part && Array.isArray(media.Part)) {
              for (const part of media.Part) {
                if (typeof part.decision === 'string' && part.decision.toLowerCase() === 'transcode') {
                  transcoding = true;
                  break;
                }
              }
            }
          }
        }
        // Bandwidth as number (prefer Session/TranscodeSession metrics, fallback to legacy m.bandwidth)
        let bandwidth = 0;
        // Plex Session.bandwidth is typically in kbps
        if (m.Session && typeof m.Session.bandwidth === 'number') {
          bandwidth = m.Session.bandwidth / 1000; // kbps -> Mbps
        } else if (m.TranscodeSession && m.TranscodeSession.bitrate) {
          // TranscodeSession.bitrate is often in kbps
          const raw = Number(m.TranscodeSession.bitrate);
          if (!Number.isNaN(raw)) bandwidth = raw / 1000;
        } else if (typeof m.bandwidth === 'number') {
          bandwidth = m.bandwidth;
        } else if (typeof m.bandwidth === 'string') {
          const match = m.bandwidth.match(/([\d.]+)/);
          if (match) bandwidth = parseFloat(match[1]);
        }
        // If bandwidth still looks like kbps (big number), convert to Mbps
        if (bandwidth > 1000) bandwidth = bandwidth / 1000;
        return {
          user: m.user || m.User?.title || 'Unknown',
          title: m.media_title || m.title || m.grandparentTitle || 'Unknown',
          episode: m.episode || (m.grandparentTitle ? m.title : undefined),
          year: m.year,
          platform: m.platform || m.Player?.platform || m.Player?.product || '',
          state: m.state || m.Player?.state || '',
          poster: m.poster || posterUrl,
          duration: m.duration ? Math.round(m.duration / 1000) : 0,
          viewOffset: m.viewOffset || 0,
          progress: m.progress || (m.duration ? Math.round((m.viewOffset || 0) / m.duration * 100) : 0),
          product: m.product || m.Player?.product || '',
          player: m.player || m.Player?.title || '',
          quality: m.quality || '',
          stream: m.stream || m.transcodeDecision || '',
          container: m.container || '',
          video: m.video || (m.Video && m.Video[0] ? `${m.Video[0].decision || ''} (${m.Video[0].codec || ''} ${m.Video[0].resolution || ''})` : ''),
          audio: m.audio || (m.Audio && m.Audio[0] ? `${m.Audio[0].decision || ''} (${m.Audio[0].language || ''} ${m.Audio[0].codec || ''} ${m.Audio[0].channels || ''})` : ''),
          subtitle: m.subtitle || (m.Subtitle && m.Subtitle[0] ? `${m.Subtitle[0].language || ''}` : 'None'),
          location: m.location || (m.Player?.local ? 'LAN' : 'WAN'),
          ip: m.Player?.address || '',
          bandwidth,
          channel: m.channelTitle || '',
          episodeTitle: m.episodeTitle || '',
          userName: m.user || m.User?.title || '',
          transcoding
        };
      });
      // Session summary
      let directPlays = 0, transcodes = 0, totalBandwidth = 0, lanBandwidth = 0, wanBandwidth = 0;
      sessions.forEach(sess => {
        if (sess.transcoding) transcodes++;
        else directPlays++;
        if (sess.bandwidth) totalBandwidth += Number(sess.bandwidth);
        if (sess.location && sess.location.toUpperCase().includes('LAN') && sess.bandwidth) lanBandwidth += Number(sess.bandwidth);
        if (sess.location && sess.location.toUpperCase().includes('WAN') && sess.bandwidth) wanBandwidth += Number(sess.bandwidth);
      });
      return {
        type: 'plex',
        sessions,
        count: sessions.length,
        summary: {
          directPlays,
          transcodes,
          totalBandwidth,
          lanBandwidth,
          wanBandwidth
        }
      };
    }
    if (Array.isArray(d) && d.length > 0) {
      // Support both Jellyfin/Emby API and flat session format
      const sessions = d.map(s => {
        // Flat format (custom API): must have state=playing
        if (s.state && s.state.toLowerCase() === 'playing' && s.media_title) {
          // Parse bandwidth as number (Mbps)
          let bandwidth = 0;
          if (typeof s.bandwidth === 'number') bandwidth = s.bandwidth;
          else if (typeof s.bandwidth === 'string') {
            const match = s.bandwidth.match(/([\d.]+)/);
            if (match) bandwidth = parseFloat(match[1]);
          }
          return {
            user: s.user || s.UserName || 'Unknown',
            title: s.media_title || s.title || 'Idle',
            episode: s.episode,
            year: s.year,
            platform: s.platform || s.Client || s.DeviceName || '',
            state: s.state,
            poster: s.poster,
            duration: s.duration || 0,
            viewOffset: s.viewOffset || 0,
            progress: typeof s.progress === 'number' ? Math.round(s.progress * 100) : 0,
            product: s.product,
            player: s.player,
            quality: s.quality,
            stream: s.stream,
            container: s.container,
            video: s.video,
            audio: s.audio,
            subtitle: s.subtitle,
            location: s.location,
            ip: s.location,
            bandwidth,
            transcoding: s.transcoding,
          };
        }
        // Standard Jellyfin/Emby API: treat any session with NowPlayingItem and PlayState as active
        if (s.NowPlayingItem && s.PlayState) {
          let posterUrl;
          if (s.NowPlayingItem?.Type === 'LiveTv' && s.NowPlayingItem?.ImageTags?.Primary && resp.config && resp.config.serverConfig) {
            posterUrl = `${resp.config.serverConfig.baseUrl}/Items/${s.NowPlayingItem.Id}/Images/Primary?api_key=${encodeURIComponent(resp.config.serverConfig.token)}`;
          } else if (s.NowPlayingItem?.ImageTags?.Primary && resp.config && resp.config.serverConfig) {
            posterUrl = `${resp.config.serverConfig.baseUrl}/Items/${s.NowPlayingItem.Id}/Images/Primary?api_key=${encodeURIComponent(resp.config.serverConfig.token)}`;
          }
          let streamType = '';
          if (s.PlayState?.PlayMethod) {
            streamType = s.PlayState.PlayMethod;
          } else if (s.TranscodingInfo && s.TranscodingInfo.IsVideoDirect === false) {
            streamType = 'Transcode';
          } else if (s.TranscodingInfo && s.TranscodingInfo.IsVideoDirect === true) {
            streamType = 'DirectPlay';
          } else if (s.state) {
            streamType = s.state;
          }
          // Try to derive more detailed media info
          const mediaStreams = s.NowPlayingItem?.MediaStreams || [];
          const videoStream = mediaStreams.find(ms => ms.Type === 'Video');
          const audioStream = mediaStreams.find(ms => ms.Type === 'Audio');
          const subtitleStream = mediaStreams.find(ms => ms.Type === 'Subtitle' || ms.Type === 'Subtitles');

          let container = s.NowPlayingItem?.Container || s.TranscodingInfo?.Container || '';
          let quality = '';
          if (videoStream && (videoStream.Width || videoStream.Height)) {
            const w = videoStream.Width || '';
            const h = videoStream.Height || '';
            if (w && h) quality = `${w}x${h}`;
          } else if (s.TranscodingInfo && s.TranscodingInfo.Height && s.TranscodingInfo.Width) {
            quality = `${s.TranscodingInfo.Width}x${s.TranscodingInfo.Height}`;
          }

          let video = '';
          if (videoStream) {
            const codec = videoStream.Codec || videoStream.codec || '';
            const w = videoStream.Width || videoStream.width || '';
            const h = videoStream.Height || videoStream.height || '';
            video = `${codec}${w && h ? ` ${w}x${h}` : ''}`.trim();
          }

          let audio = '';
          if (audioStream) {
            const acodec = audioStream.Codec || audioStream.codec || '';
            const lang = audioStream.Language || audioStream.language || '';
            const ch = audioStream.Channels || audioStream.channels || '';
            audio = `${acodec}${lang ? ` ${lang}` : ''}${ch ? ` ${ch}ch` : ''}`.trim();
          }

          let subtitle = 'None';
          if (subtitleStream) {
            const slang = subtitleStream.Language || subtitleStream.language || '';
            subtitle = slang || 'Subtitle';
          }

          // Location / WAN detection
          let location = '';
          if (typeof s.IsInLocalNetwork === 'boolean') {
            location = s.IsInLocalNetwork ? 'LAN' : 'WAN';
          }
          let ip = '';
          if (s.RemoteEndPoint) {
            ip = s.RemoteEndPoint;
            if (!location) location = 'WAN';
          }

          // Bandwidth in Mbps if possible
          let bandwidth = 0;
          if (typeof s.bandwidth === 'number') bandwidth = s.bandwidth;
          else if (typeof s.bandwidth === 'string') bandwidth = parseFloat(s.bandwidth) || 0;
          else if (s.TranscodingInfo && s.TranscodingInfo.Bitrate) {
            bandwidth = Number(s.TranscodingInfo.Bitrate) / 1000000; // bits/s -> Mbps
          } else if (videoStream && videoStream.Bitrate) {
            bandwidth = Number(videoStream.Bitrate) / 1000000;
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
              : 0,
            product: s.Client || s.DeviceName || '',
            player: s.DeviceName || s.Client || '',
            quality,
            stream: streamType,
            container,
            video,
            audio,
            subtitle,
            location,
            ip,
            bandwidth,
          };
        }
        return null;
      }).filter(Boolean);
      // Calculate summary for Jellyfin/Emby
      let directPlays = 0, transcodes = 0, totalBandwidth = 0, lanBandwidth = 0, wanBandwidth = 0;
      sessions.forEach(sess => {
        // Robust detection for Jellyfin/Emby
        const stream = (sess.stream || '').toLowerCase();
        if (stream.includes('direct')) directPlays++;
        else if (stream.includes('transcode')) transcodes++;
        if (sess.bandwidth) totalBandwidth += Number(sess.bandwidth);
        // LAN/WAN detection for Jellyfin/Emby is not always available, so skip for now
      });
      return {
        type: 'jellyfin/emby',
        sessions,
        count: sessions.length,
        summary: {
          directPlays,
          transcodes,
          totalBandwidth,
          lanBandwidth,
          wanBandwidth
        }
      };
    }
    if (typeof d === 'object') {
      return {
        type: typeof d,
        sessions: [],
        count: 0,
        summary: {
          directPlays: 0,
          transcodes: 0,
          totalBandwidth: 0,
          lanBandwidth: 0,
          wanBandwidth: 0
        }
      };
    }
    return {
      type: typeof d,
      sessions: [],
      count: 0,
      summary: {
        directPlays: 0,
        transcodes: 0,
        totalBandwidth: 0,
        lanBandwidth: 0,
        wanBandwidth: 0
      }
    };
  } catch (e) {
    console.error('Session extraction error:', e);
    return {};
  }
}

async function pollServer(s) {
  const base = (s.baseUrl || '').replace(/\/$/, '');
  let pathSuffix = s.apiPath || defaultPathForType(s.type) || '/';
  // For Jellyfin/Emby, override legacy /System/Info path to use /Sessions so we actually get active sessions
  if ((s.type === 'jellyfin' || s.type === 'emby') && (!s.apiPath || s.apiPath === '/System/Info')) {
    pathSuffix = defaultPathForType(s.type);
  }
  let finalUrl = base + pathSuffix;
  const start = Date.now();
  const headers = {};

  if (s.token) {
    // Choose sensible defaults: Plex uses query by default, Jellyfin/Emby use headers by default
    const tokenLoc = s.tokenLocation || (s.type === 'plex' ? 'query' : 'header');
    if (tokenLoc === 'header') {
      if (s.type === 'plex') {
        headers['X-Plex-Token'] = s.token;
      } else if (s.type === 'jellyfin') {
        headers['X-MediaBrowser-Token'] = s.token;
      } else {
        headers['X-Emby-Token'] = s.token;
      }
    } else {
      const sep = finalUrl.includes('?') ? '&' : '?';
      if (s.type === 'plex') {
        finalUrl += `${sep}X-Plex-Token=${encodeURIComponent(s.token)}`;
      } else if (s.type === 'jellyfin') {
        // Jellyfin accepts api_key in query
        finalUrl += `${sep}api_key=${encodeURIComponent(s.token)}`;
      } else {
        finalUrl += `${sep}X-Emby-Token=${encodeURIComponent(s.token)}`;
      }
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
    // If summary is missing, but sessions exist, compute summary from sessions
    let sessions = summary.sessions || [];
    let count = sessions.length;
    let summaryObj = summary.summary;
    if (!summaryObj && Array.isArray(sessions)) {
      let directPlays = 0, transcodes = 0, totalBandwidth = 0, lanBandwidth = 0, wanBandwidth = 0;
      console.log(`\n[OmniStream] Calculating totals for server: ${s.name || s.baseUrl}`);
      sessions.forEach((sess, idx) => {
        // Robust transcoding detection
        let isTranscoding = false;
        if (typeof sess.transcoding === 'boolean') {
          isTranscoding = sess.transcoding;
        } else if (sess.stream && typeof sess.stream === 'string' && sess.stream.toLowerCase().includes('transcode')) {
          isTranscoding = true;
        } else if (sess.state && typeof sess.state === 'string' && sess.state.toLowerCase().includes('transcode')) {
          isTranscoding = true;
        }
        if (isTranscoding) transcodes++;
        else directPlays++;
        if (sess.bandwidth) totalBandwidth += Number(sess.bandwidth);
        if (sess.location && sess.location.toUpperCase().includes('LAN') && sess.bandwidth) lanBandwidth += Number(sess.bandwidth);
        if (sess.location && sess.location.toUpperCase().includes('WAN') && sess.bandwidth) wanBandwidth += Number(sess.bandwidth);
        // Log session classification and full session object for diagnosis
        console.log(`[Session ${idx+1}] user: ${sess.user || sess.userName}, transcoding: ${sess.transcoding}, stream: ${sess.stream}, state: ${sess.state}, classified as: ${isTranscoding ? 'Transcoding' : 'Direct Play'}`);
        if (!isTranscoding && idx === 0) {
          console.log('[Session 1] Full session object:', JSON.stringify(sess, null, 2));
        }
      });
      console.log(`[OmniStream] Totals for ${s.name || s.baseUrl}: directPlays=${directPlays}, transcodes=${transcodes}, totalStreams=${count}`);
      summaryObj = { directPlays, transcodes, totalStreams: count, totalBandwidth, lanBandwidth, wanBandwidth };
      // Ensure totalStreams is always set for frontend
      if (typeof summaryObj.totalStreams !== 'number') summaryObj.totalStreams = count;
    }
    statuses[s.id] = {
      id: s.id,
      name: s.name || s.baseUrl,
      type: s.type || 'generic',
      online: true,
      statusCode: resp.status,
      latency,
      sessions,
      sessionCount: count,
      summary: summaryObj,
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
  // After polling all servers, snapshot current sessions into history database
  if (historyDb) {
    const timestamp = new Date().toISOString();
    historyDb.serialize(() => {
      const stmt = historyDb.prepare(
        'INSERT INTO history (time, serverId, serverName, type, user, title, stream, transcoding, location, bandwidth) VALUES (?,?,?,?,?,?,?,?,?,?)'
      );
      Object.values(statuses).forEach(st => {
        if (!st.online || !Array.isArray(st.sessions)) return;
        st.sessions.forEach(sess => {
          const user = sess.user || sess.userName || 'Unknown';
          const title = sess.grandparentTitle || sess.title || sess.channel || 'Idle';
          const stream = sess.stream || '';
          const transcoding = typeof sess.transcoding === 'boolean' ? (sess.transcoding ? 1 : 0) : null;
          const location = sess.location || '';
          const bandwidth = typeof sess.bandwidth === 'number' ? sess.bandwidth : 0;
          stmt.run(
            timestamp,
            st.id,
            st.name,
            st.type,
            user,
            title,
            stream,
            transcoding,
            location,
            bandwidth
          );
        });
      });
      stmt.finalize();
      // Trim to MAX_HISTORY rows to keep DB small
      historyDb.run(
        'DELETE FROM history WHERE id NOT IN (SELECT id FROM history ORDER BY id DESC LIMIT ?)',
        [MAX_HISTORY],
        (err) => {
          if (err) console.error('Failed to trim history database:', err.message);
        }
      );
    });
  }
}

pollAll();
setInterval(pollAll, 15 * 1000);

app.get('/api/status', (req, res) => {
  // Only include enabled servers
  const enabledServers = servers.filter(s => !s.disabled);
  // Only include statuses for enabled servers
  const enabledStatuses = {};
  for (const s of enabledServers) {
    if (statuses[s.id]) enabledStatuses[s.id] = statuses[s.id];
  }
  res.json({
    servers: enabledServers,
    statuses: enabledStatuses,
    setup: enabledServers.length === 0
  });
});

// Simple history API - backed by SQLite
app.get('/api/history', (req, res) => {
  if (!historyDb) return res.json({ history: [] });
  historyDb.all(
    'SELECT time, serverId, serverName, type, user, title, stream, transcoding, location, bandwidth FROM history ORDER BY id ASC LIMIT ?',
    [MAX_HISTORY],
    (err, rows) => {
      if (err) {
        console.error('Failed to read history database:', err.message);
        return res.status(500).json({ history: [] });
      }
      const history = rows.map(r => ({
        time: r.time,
        serverId: r.serverId,
        serverName: r.serverName,
        type: r.type,
        user: r.user,
        title: r.title,
        stream: r.stream,
        transcoding: typeof r.transcoding === 'number' ? !!r.transcoding : undefined,
        location: r.location,
        bandwidth: typeof r.bandwidth === 'number' ? r.bandwidth : 0
      }));
      res.json({ history });
    }
  );
});

// Import watch history from supported backends (currently Jellyfin only)
app.post('/api/import-history', async (req, res) => {
  if (!historyDb) return res.status(500).json({ error: 'history DB not available' });
  const enabledServers = servers.filter(s => !s.disabled && s.type === 'jellyfin');
  const results = [];
  for (const s of enabledServers) {
    const r = await importJellyfinHistory(s, { limitPerUser: 100 });
    results.push(r);
  }
  res.json({ results });
});

// Derived notifications based on current statuses
app.get('/api/notifications', (req, res) => {
  const notifications = [];
  const now = new Date().toISOString();
  Object.values(statuses).forEach(st => {
    // Server offline
    if (!st.online) {
      notifications.push({
        id: `offline-${st.id}`,
        level: 'error',
        serverId: st.id,
        serverName: st.name,
        time: now,
        message: `${st.name || 'Server'} is offline`
      });
      return;
    }
    // Any WAN transcodes
    const wanTranscodes = (st.sessions || []).filter(sess => {
      const isWan = sess.location && sess.location.toUpperCase().includes('WAN');
      let isTranscode = false;
      if (typeof sess.transcoding === 'boolean') isTranscode = sess.transcoding;
      else if (sess.stream && typeof sess.stream === 'string' && sess.stream.toLowerCase().includes('transcode')) isTranscode = true;
      else if (sess.state && typeof sess.state === 'string' && sess.state.toLowerCase().includes('transcode')) isTranscode = true;
      return isWan && isTranscode;
    });
    if (wanTranscodes.length > 0) {
      notifications.push({
        id: `wan-transcode-${st.id}`,
        level: 'warn',
        serverId: st.id,
        serverName: st.name,
        time: now,
        message: `${wanTranscodes.length} WAN transcode${wanTranscodes.length > 1 ? 's' : ''} active on ${st.name || 'server'}`
      });
    }
    // High total bandwidth (simple threshold)
    const summary = st.summary || {};
    const totalBw = typeof summary.totalBandwidth === 'number' ? summary.totalBandwidth : 0;
    if (totalBw > 50) {
      notifications.push({
        id: `high-bandwidth-${st.id}`,
        level: 'warn',
        serverId: st.id,
        serverName: st.name,
        time: now,
        message: `High total bandwidth on ${st.name || 'server'}: ${totalBw.toFixed(1)} Mbps`
      });
    }
  });
  res.json({ notifications });
});


// List servers
app.get('/api/servers', (req, res) => res.json(servers));

// Enable/disable server
app.post('/api/servers/:id/toggle', (req, res) => {
  const idx = servers.findIndex(s => s.id == req.params.id);
  if (idx === -1) return res.status(404).json({error:'Not found'});
  servers[idx].disabled = !servers[idx].disabled;
  try {
    fs.writeFileSync(SERVERS_FILE, JSON.stringify(servers, null, 2));
  } catch(e) {
    console.error('Failed to write servers.json after toggle:', e.message);
    return res.status(500).json({
      error: 'Failed to save servers.json',
      detail: e.message,
      code: e.code || null
    });
  }
  res.json(servers[idx]);
});

// Remove server
app.delete('/api/servers/:id', (req, res) => {
  const idx = servers.findIndex(s => s.id == req.params.id);
  if (idx === -1) return res.status(404).json({error:'Not found'});
  const removed = servers.splice(idx, 1);
  try {
    fs.writeFileSync(SERVERS_FILE, JSON.stringify(servers, null, 2));
  } catch(e) {
    console.error('Failed to write servers.json after remove:', e.message);
    return res.status(500).json({
      error: 'Failed to save servers.json',
      detail: e.message,
      code: e.code || null
    });
  }
  res.json({removed: removed[0]});
});

app.post('/api/servers', (req, res) => {
  const s = req.body;
  if (!s || !s.baseUrl) return res.status(400).json({ error: 'baseUrl required' });
  s.id = s.id || Date.now().toString();
  servers.push(s);
  try {
    fs.writeFileSync(SERVERS_FILE, JSON.stringify(servers, null, 2));
  } catch (e) {
    console.error('Failed to write servers.json after add:', e.message);
    // Roll back in-memory change so state matches disk
    servers.pop();
    return res.status(500).json({
      error: 'Failed to save servers.json',
      detail: e.message,
      code: e.code || null
    });
  }
  res.json(s);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`OmniStream listening on port ${PORT}`));
