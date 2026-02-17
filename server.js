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
        // Bandwidth as number (parse from Plex bandwidth field, e.g. '20280')
        let bandwidth = 0;
        if (typeof m.bandwidth === 'number') bandwidth = m.bandwidth;
        else if (typeof m.bandwidth === 'string') {
          const match = m.bandwidth.match(/([\d.]+)/);
          if (match) bandwidth = parseFloat(match[1]);
        }
        // If bandwidth is > 1000, treat as kbps and convert to Mbps
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
      // Jellyfin/Emby sessions: only include active playback (NowPlayingItem exists and PlayState.Playing is true)
      const sessions = d.filter(s => s.NowPlayingItem && s.PlayState && s.PlayState.Playing === true).map(s => {
        let posterUrl;
        // Live TV poster extraction for Jellyfin/Emby
        if (s.NowPlayingItem?.Type === 'LiveTv' && s.NowPlayingItem?.ImageTags?.Primary && resp.config && resp.config.serverConfig) {
          posterUrl = `${resp.config.serverConfig.baseUrl}/Items/${s.NowPlayingItem.Id}/Images/Primary?api_key=${encodeURIComponent(resp.config.serverConfig.token)}`;
        } else if (s.NowPlayingItem?.ImageTags?.Primary && resp.config && resp.config.serverConfig) {
          posterUrl = `${resp.config.serverConfig.baseUrl}/Items/${s.NowPlayingItem.Id}/Images/Primary?api_key=${encodeURIComponent(resp.config.serverConfig.token)}`;
        }
        // Detect stream type for Jellyfin/Emby
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
        // Bandwidth as number (if available)
        let bandwidth = 0;
        if (typeof s.bandwidth === 'number') bandwidth = s.bandwidth;
        else if (typeof s.bandwidth === 'string') bandwidth = parseFloat(s.bandwidth) || 0;
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
          stream: streamType,
          bandwidth,
        };
      });
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
