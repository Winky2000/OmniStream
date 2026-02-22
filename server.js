// ...existing code...
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const https = require('https');
let nodemailer = null;
let archiver = null;
try {
  // Optional dependency for email notifications; if not installed, email will be disabled gracefully
  nodemailer = require('nodemailer');
} catch (e) {
  console.log('[OmniStream] Email notifications disabled (nodemailer not installed).');
}
try {
  // Optional dependency for backup zip downloads
  archiver = require('archiver');
} catch (e) {
  console.log('[OmniStream] Backup zip disabled (archiver not installed).');
}
// ...existing code...

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const SERVERS_FILE = path.join(__dirname, 'servers.json');
const CONFIG_FILE = path.join(__dirname, 'config.json');
const PKG_FILE = path.join(__dirname, 'package.json');

let appVersion = null;
try {
  if (fs.existsSync(PKG_FILE)) {
    const rawPkg = fs.readFileSync(PKG_FILE, 'utf8');
    if (rawPkg) {
      const pkg = JSON.parse(rawPkg);
      appVersion = pkg.version || null;
    }
  }
} catch (e) {
  console.error('[OmniStream] Failed to read package.json version:', e.message);
  appVersion = null;
}

let appConfig = {};
try {
  if (fs.existsSync(CONFIG_FILE)) {
    const rawCfg = fs.readFileSync(CONFIG_FILE, 'utf8');
    appConfig = rawCfg ? JSON.parse(rawCfg) : {};
    console.log('[OmniStream] Loaded config from', CONFIG_FILE);
  }
} catch (e) {
  console.error('[OmniStream] Failed to load config.json:', e.message);
  appConfig = {};
}
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
const DEFAULT_MAX_HISTORY = 500;
let MAX_HISTORY = DEFAULT_MAX_HISTORY;
if (appConfig && typeof appConfig.maxHistory === 'number') {
  // maxHistory <= 0 means "no automatic trimming" (keep full history)
  MAX_HISTORY = appConfig.maxHistory;
}
// Ensure newsletter/email-related blocks exist
if (!appConfig.newsletterEmail) {
  appConfig.newsletterEmail = {};
}
if (!appConfig.newsletterTemplates) {
  appConfig.newsletterTemplates = [];
}

// Track last derived notifications so we only fire notifiers on changes
let lastNotificationIds = new Set();

// Track global polling health/metadata
let lastPollAt = null;           // ISO string of last completed pollAll
let lastPollDurationMs = null;   // Duration of last pollAll in milliseconds
let lastPollError = null;        // Last top-level pollAll error message, if any

// Track system-level insights for reliability/debugging
let lastImportRunAt = null;         // ISO string of last /api/import-history run
let lastImportResults = null;       // Array of results from last import
let lastNotifierError = null;       // Last notifier error message (any channel)
let lastNotifierErrorAt = null;     // ISO string when last notifier error occurred
let lastNotifierErrorChannel = null;// Channel name for last notifier error

function shouldSendNotificationToChannel(notification, channelCfg) {
  if (!channelCfg) return false;
  const triggers = channelCfg.triggers;
  const kind = notification.kind;
  if (!kind || !triggers) return true;
  if (kind === 'offline') return triggers.offline !== false;
  if (kind === 'wanTranscode') return triggers.wanTranscodes !== false;
  if (kind === 'highBandwidth') return triggers.highBandwidth !== false;
  return true;
}

function recordNotifierError(channel, message) {
  try {
    lastNotifierError = message || null;
    lastNotifierErrorChannel = channel || null;
    lastNotifierErrorAt = new Date().toISOString();
  } catch (e) {
    // Avoid throwing from error handler; just log.
    console.error('[OmniStream] Failed to record notifier error:', e.message);
  }
}

function triggerNotifiers() {
  try {
    const notifications = buildNotificationsSnapshot();
    const currentIds = new Set(notifications.map(n => n.id));
    // Only notify on newly-appearing notifications compared to previous poll
    const newlyActive = notifications.filter(n => !lastNotificationIds.has(n.id));
    if (!newlyActive.length) {
      lastNotificationIds = currentIds;
      return;
    }
    const notifierCfg = (appConfig && appConfig.notifiers) || {};
    newlyActive.forEach(n => {
      if (shouldSendNotificationToChannel(n, notifierCfg.discord)) {
        sendDiscordNotification(n);
      }
      if (shouldSendNotificationToChannel(n, notifierCfg.email)) {
        sendEmailNotification(n);
      }
      if (shouldSendNotificationToChannel(n, notifierCfg.webhook)) {
        sendGenericWebhookNotification(n);
      }
      if (shouldSendNotificationToChannel(n, notifierCfg.slack)) {
        sendSlackNotification(n);
      }
      if (shouldSendNotificationToChannel(n, notifierCfg.telegram)) {
        sendTelegramNotification(n);
      }
      if (shouldSendNotificationToChannel(n, notifierCfg.twilio)) {
        sendTwilioSmsNotification(n);
      }
      if (shouldSendNotificationToChannel(n, notifierCfg.pushover)) {
        sendPushoverNotification(n);
      }
      if (shouldSendNotificationToChannel(n, notifierCfg.gotify)) {
        sendGotifyNotification(n);
      }
    });
    lastNotificationIds = currentIds;
  } catch (e) {
    console.error('[OmniStream] triggerNotifiers failed:', e.message);
  }
}

function sendDiscordNotification(notification) {
  const discordCfg = appConfig?.notifiers?.discord;
  if (!discordCfg || !discordCfg.webhookUrl) return;
  try {
    const url = new URL(discordCfg.webhookUrl);
    const body = JSON.stringify({
      content: formatDiscordMessage(notification)
    });
    const options = {
      method: 'POST',
      hostname: url.hostname,
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, res => {
      // Drain response to avoid socket hangup
      res.on('data', () => {});
    });
    req.on('error', err => {
      console.error('[OmniStream] Discord notifier error:', err.message);
      recordNotifierError('discord', err.message);
    });
    req.write(body);
    req.end();
  } catch (e) {
    console.error('[OmniStream] Discord notifier failure:', e.message);
    recordNotifierError('discord', e.message);
  }
}

function formatDiscordMessage(n) {
  const level = (n.level || 'info').toLowerCase();
  const prefix = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : 'ℹ️';
  const server = n.serverName || 'Server';
  const when = n.time ? new Date(n.time).toLocaleString() : '';
  return `${prefix} [${server}] ${n.message}${when ? ` (${when})` : ''}`;
}

function sendEmailNotification(notification) {
  const emailCfg = appConfig?.notifiers?.email;
  if (!emailCfg || emailCfg.enabled === false || !nodemailer) return;
  try {
    const transport = nodemailer.createTransport(emailCfg.smtp || {});
    const level = (notification.level || 'info').toUpperCase();
    const subject = `[OmniStream] ${level}: ${notification.message}`;
    const textLines = [
      `Server: ${notification.serverName || 'Server'}`,
      `Time: ${notification.time || new Date().toISOString()}`,
      '',
      notification.message
    ];
    const mailOptions = {
      from: emailCfg.from,
      to: emailCfg.to,
      subject,
      text: textLines.join('\n')
    };
    transport.sendMail(mailOptions, (err) => {
      if (err) {
        console.error('[OmniStream] Email notifier error:', err.message);
        recordNotifierError('email', err.message);
      }
    });
  } catch (e) {
    console.error('[OmniStream] Email notifier failure:', e.message);
    recordNotifierError('email', e.message);
  }
}

function sendGenericWebhookNotification(notification) {
  const cfg = appConfig?.notifiers?.webhook;
  if (!cfg || !cfg.url) return;
  try {
    const url = new URL(cfg.url);
    const body = JSON.stringify({
      id: notification.id,
      level: notification.level,
      serverId: notification.serverId,
      serverName: notification.serverName,
      time: notification.time,
      message: notification.message
    });
    const options = {
      method: 'POST',
      hostname: url.hostname,
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, res => {
      res.on('data', () => {});
    });
    req.on('error', err => {
      console.error('[OmniStream] Webhook notifier error:', err.message);
      recordNotifierError('webhook', err.message);
    });
    req.write(body);
    req.end();
  } catch (e) {
    console.error('[OmniStream] Webhook notifier failure:', e.message);
    recordNotifierError('webhook', e.message);
  }
}

function sendSlackNotification(notification) {
  const cfg = appConfig?.notifiers?.slack;
  if (!cfg || !cfg.webhookUrl) return;
  try {
    const url = new URL(cfg.webhookUrl);
    const text = formatDiscordMessage(notification); // Reuse same human text
    const body = JSON.stringify({ text });
    const options = {
      method: 'POST',
      hostname: url.hostname,
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, res => {
      res.on('data', () => {});
    });
    req.on('error', err => {
      console.error('[OmniStream] Slack notifier error:', err.message);
      recordNotifierError('slack', err.message);
    });
    req.write(body);
    req.end();
  } catch (e) {
    console.error('[OmniStream] Slack notifier failure:', e.message);
    recordNotifierError('slack', e.message);
  }
}

function sendTelegramNotification(notification) {
  const cfg = appConfig?.notifiers?.telegram;
  if (!cfg || !cfg.botToken || !cfg.chatId) return;
  try {
    const text = formatDiscordMessage(notification);
    const path = `/bot${encodeURIComponent(cfg.botToken)}/sendMessage?chat_id=${encodeURIComponent(cfg.chatId)}&text=${encodeURIComponent(text)}`;
    const options = {
      method: 'GET',
      hostname: 'api.telegram.org',
      path
    };
    const req = https.request(options, res => {
      res.on('data', () => {});
    });
    req.on('error', err => {
      console.error('[OmniStream] Telegram notifier error:', err.message);
      recordNotifierError('telegram', err.message);
    });
    req.end();
  } catch (e) {
    console.error('[OmniStream] Telegram notifier failure:', e.message);
    recordNotifierError('telegram', e.message);
  }
}

function sendTwilioSmsNotification(notification) {
  const cfg = appConfig?.notifiers?.twilio;
  if (!cfg || !cfg.accountSid || !cfg.authToken || !cfg.from || !cfg.to) return;
  try {
    const payload = new URLSearchParams({
      From: cfg.from,
      To: cfg.to,
      Body: formatDiscordMessage(notification)
    }).toString();
    const path = `/2010-04-01/Accounts/${encodeURIComponent(cfg.accountSid)}/Messages.json`;
    const options = {
      method: 'POST',
      hostname: 'api.twilio.com',
      path,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(payload),
        'Authorization': 'Basic ' + Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString('base64')
      }
    };
    const req = https.request(options, res => {
      res.on('data', () => {});
    });
    req.on('error', err => {
      console.error('[OmniStream] Twilio notifier error:', err.message);
      recordNotifierError('twilio', err.message);
    });
    req.write(payload);
    req.end();
  } catch (e) {
    console.error('[OmniStream] Twilio notifier failure:', e.message);
    recordNotifierError('twilio', e.message);
  }
}

function sendPushoverNotification(notification) {
  const cfg = appConfig?.notifiers?.pushover;
  if (!cfg || !cfg.user || !cfg.token) return;
  try {
    const payload = new URLSearchParams({
      token: cfg.token,
      user: cfg.user,
      message: notification.message,
      title: notification.serverName || 'OmniStream',
      priority: String(cfg.priority ?? 0)
    }).toString();
    const options = {
      method: 'POST',
      hostname: 'api.pushover.net',
      path: '/1/messages.json',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(payload)
      }
    };
    const req = https.request(options, res => {
      res.on('data', () => {});
    });
    req.on('error', err => {
      console.error('[OmniStream] Pushover notifier error:', err.message);
      recordNotifierError('pushover', err.message);
    });
    req.write(payload);
    req.end();
  } catch (e) {
    console.error('[OmniStream] Pushover notifier failure:', e.message);
    recordNotifierError('pushover', e.message);
  }
}

function sendGotifyNotification(notification) {
  const cfg = appConfig?.notifiers?.gotify;
  if (!cfg || !cfg.serverUrl || !cfg.token) return;
  try {
    const baseUrl = new URL(cfg.serverUrl);
    const body = JSON.stringify({
      title: notification.serverName || 'OmniStream',
      message: notification.message,
      priority: cfg.priority ?? 5
    });
    const options = {
      method: 'POST',
      hostname: baseUrl.hostname,
      path: (baseUrl.pathname.replace(/\/$/, '') || '') + '/message',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-Gotify-Key': cfg.token
      }
    };
    const req = https.request(options, res => {
      res.on('data', () => {});
    });
    req.on('error', err => {
      console.error('[OmniStream] Gotify notifier error:', err.message);
      recordNotifierError('gotify', err.message);
    });
    req.write(body);
    req.end();
  } catch (e) {
    console.error('[OmniStream] Gotify notifier failure:', e.message);
    recordNotifierError('gotify', e.message);
  }
}

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

    // Table for newsletter / subscriber emails imported from external sources (e.g. Overseerr)
    historyDb.run(
      'CREATE TABLE IF NOT EXISTS newsletter_subscribers (\n' +
      '  id INTEGER PRIMARY KEY AUTOINCREMENT,\n' +
      "  source TEXT NOT NULL,\n" +
      "  externalId TEXT,\n" +
      "  name TEXT,\n" +
      "  email TEXT NOT NULL,\n" +
      "  createdAt TEXT NOT NULL,\n" +
      "  updatedAt TEXT NOT NULL,\n" +
      "  active INTEGER NOT NULL DEFAULT 1,\n" +
      '  UNIQUE(source, externalId)\n' +
      ')'
    );
    historyDb.run('CREATE INDEX IF NOT EXISTS idx_subscribers_email ON newsletter_subscribers(email)');
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

// Import watch history helpers
// Jellyfin/Emby: pull per-user played movies/episodes
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
          Recursive: true,
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
            const rawType = it.Type || it.MediaType || '';
            // Ignore Jellyfin library views / folders (CollectionFolder, UserView, etc.)
            if (rawType !== 'Movie' && rawType !== 'Episode') {
              return;
            }

            const time = (it.UserData && it.UserData.LastPlayedDate) || it.DatePlayed || new Date().toISOString();
            // Build a more human-friendly title for movies and episodes
            let title;
            const type = rawType;
            if (type === 'Episode' || it.SeriesName) {
              const series = it.SeriesName || '';
              const epName = it.Name || '';
              const seasonNum = typeof it.ParentIndexNumber === 'number' ? it.ParentIndexNumber : null;
              const epNum = typeof it.IndexNumber === 'number' ? it.IndexNumber : null;
              let epLabel = '';
              if (seasonNum !== null && epNum !== null) {
                epLabel = `S${String(seasonNum).padStart(2, '0')}E${String(epNum).padStart(2, '0')}`;
              } else if (epNum !== null) {
                epLabel = `E${String(epNum).padStart(2, '0')}`;
              }
              if (series && epLabel && epName) {
                title = `${series} - ${epLabel} - ${epName}`;
              } else if (series && epName) {
                title = `${series} - ${epName}`;
              } else {
                title = epName || series || it.Name || 'Unknown';
              }
            } else {
              title = it.Name || it.OriginalTitle || 'Unknown';
            }

            // Use a simple, stable stream label for reports
            const stream = type;
            stmt.run(
              time,
              server.id,
              server.name || server.baseUrl,
              server.type,
              u.Name || u.Username || 'Unknown',
              title,
              stream,
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
    // Trim DB after import if a retention limit is configured
    if (MAX_HISTORY > 0) {
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
    }
    return { serverId: server.id, type: server.type, imported };
  } catch (e) {
    console.error(`Failed to import Jellyfin/Emby history for ${server.name || server.baseUrl}:`, e.message);
    return { serverId: server.id, type: server.type, imported: 0, error: e.message };
  }
}

// Plex: pull global watch history (recent or up to a limit)
async function importPlexHistory(server, { limit = 2000 } = {}) {
  if (!historyDb) return { serverId: server.id, type: server.type, imported: 0, error: 'history DB not available' };
  const base = (server.baseUrl || '').replace(/\/$/, '');
  if (!server.token) {
    return { serverId: server.id, type: server.type, imported: 0, error: 'no token configured' };
  }
  const url = base + '/status/sessions/history/all';
  const headers = {};

  try {
    let imported = 0;
    const tokenLoc = server.tokenLocation || 'query';
    if (tokenLoc === 'header') {
      headers['X-Plex-Token'] = server.token;
    }

    await new Promise((resolve) => {
      historyDb.serialize(async () => {
        const stmt = historyDb.prepare(
          'INSERT INTO history (time, serverId, serverName, type, user, title, stream, transcoding, location, bandwidth) VALUES (?,?,?,?,?,?,?,?,?,?)'
        );

        let start = 0;
        const pageSize = 200;

        while (imported < limit) {
          const remaining = limit - imported;
          const size = remaining < pageSize ? remaining : pageSize;
          const params = {
            'X-Plex-Container-Start': start,
            'X-Plex-Container-Size': size
          };
          if (tokenLoc !== 'header') {
            params['X-Plex-Token'] = server.token;
          }

          let resp;
          try {
            resp = await axios.get(url, { headers, params, timeout: 20000 });
          } catch (err) {
            console.error(`Plex history page fetch failed for ${server.name || server.baseUrl}:`, err.message);
            break;
          }

          const mc = resp.data && resp.data.MediaContainer ? resp.data.MediaContainer : null;
          const items = mc && Array.isArray(mc.Metadata) ? mc.Metadata : [];
          if (!items.length) break;

          items.forEach(m => {
          const rawType = (m.type || '').toLowerCase();
          if (rawType !== 'movie' && rawType !== 'episode') return;

          // Plex history timestamps are often epoch seconds (viewedAt)
          let timeIso;
          if (typeof m.viewedAt === 'number') {
            timeIso = new Date(m.viewedAt * 1000).toISOString();
          } else if (typeof m.lastViewedAt === 'number') {
            timeIso = new Date(m.lastViewedAt * 1000).toISOString();
          } else {
            timeIso = new Date().toISOString();
          }

          // Title formatting similar to live sessions
          let title;
          if (rawType === 'episode' || m.grandparentTitle) {
            const series = m.grandparentTitle || '';
            const epName = m.title || '';
            const seasonNum = typeof m.parentIndex === 'number' ? m.parentIndex : null;
            const epNum = typeof m.index === 'number' ? m.index : null;
            let epLabel = '';
            if (seasonNum !== null && epNum !== null) {
              epLabel = `S${String(seasonNum).padStart(2, '0')}E${String(epNum).padStart(2, '0')}`;
            } else if (epNum !== null) {
              epLabel = `E${String(epNum).padStart(2, '0')}`;
            }
            if (series && epLabel && epName) {
              title = `${series} - ${epLabel} - ${epName}`;
            } else if (series && epName) {
              title = `${series} - ${epName}`;
            } else {
              title = epName || series || m.title || m.originalTitle || 'Unknown';
            }
          } else {
            title = m.title || m.originalTitle || 'Unknown';
          }

          // Try hard to extract the Plex account/user name in a few
          // different shapes this endpoint can return.
          let user = 'Unknown';
          if (m.user && typeof m.user === 'string') {
            user = m.user;
          } else if (m.user && typeof m.user.title === 'string') {
            user = m.user.title;
          } else if (typeof m.username === 'string') {
            user = m.username;
          } else if (m.User && typeof m.User.username === 'string') {
            user = m.User.username;
          } else if (Array.isArray(m.Account) && m.Account[0] && typeof m.Account[0].title === 'string') {
            user = m.Account[0].title;
          } else if (m.Account && typeof m.Account.title === 'string') {
            user = m.Account.title;
          } else if (Array.isArray(m.account) && m.account[0] && typeof m.account[0].title === 'string') {
            user = m.account[0].title;
          } else if (m.account && typeof m.account.title === 'string') {
            user = m.account.title;
          } else if (m.User && typeof m.User.title === 'string') {
            user = m.User.title;
          }
          if (user === 'Unknown') {
            console.log('[OmniStream] Plex history item has unknown user; available user fields:', {
              user: m.user,
              username: m.username,
              Account: m.Account,
              account: m.account,
              User: m.User
            });
          }
          const stream = rawType === 'movie' ? 'Movie' : (rawType === 'episode' ? 'Episode' : '');

          stmt.run(
            timeIso,
            server.id,
            server.name || server.baseUrl,
            server.type,
            user,
            title,
            stream,
            null,
            '',
            0
          );
          imported++;
        });

          if (items.length < size) break;
          start += items.length;
        }

        stmt.finalize(() => resolve());
      });
    });

    // Trim DB after import if a retention limit is configured
    if (MAX_HISTORY > 0) {
      await new Promise((resolve) => {
        historyDb.run(
          'DELETE FROM history WHERE id NOT IN (SELECT id FROM history ORDER BY id DESC LIMIT ?)',
          [MAX_HISTORY],
          (err) => {
            if (err) console.error('Failed to trim history database after Plex import:', err.message);
            resolve();
          }
        );
      });
    }

    return { serverId: server.id, type: server.type, imported };
  } catch (e) {
    console.error(`Failed to import Plex history for ${server.name || server.baseUrl}:`, e.message);
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
        // Prefer season/show poster for TV episodes so we avoid episode stills
        let rawThumb;
        if (m.type === 'episode' || m.grandparentTitle) {
          rawThumb = m.parentThumb || m.grandparentThumb || m.thumb || m.art || '';
        } else {
          rawThumb = m.thumb || m.grandparentThumb || m.parentThumb || m.art || '';
        }
        if (rawThumb && typeof rawThumb === 'string' && /^https?:\/\//i.test(rawThumb)) {
          // Absolute URL (e.g. Plex metadata-static or provider-static) –
          // use it directly so OTA/live TV artwork can load correctly.
          posterUrl = rawThumb;
        } else if (resp.config && resp.config.serverConfig && rawThumb) {
          const serverId = resp.config.serverConfig.id;
          // Relative library path – go through our poster proxy so the
          // browser doesn't need direct access to the Plex baseUrl/token.
          posterUrl = `/api/poster?serverId=${encodeURIComponent(serverId)}&path=${encodeURIComponent(rawThumb)}`;
        }
        // Fallback placeholder for live TV if no artwork is available
        const normalizedPoster = posterUrl || (m.type === 'live' ? '/live_tv_placeholder.svg' : undefined);

        // User avatar (Plex account thumb)
        let userAvatar;
        let rawUserThumb =
          (m.User && (m.User.thumb || m.User.avatar)) ||
          (Array.isArray(m.Account) && m.Account[0] && (m.Account[0].thumb || m.Account[0].avatar)) ||
          (m.Account && (m.Account.thumb || m.Account.avatar)) ||
          (Array.isArray(m.account) && m.account[0] && (m.account[0].thumb || m.account[0].avatar)) ||
          (m.account && (m.account.thumb || m.account.avatar)) ||
          null;

        if (rawUserThumb && typeof rawUserThumb === 'string') {
          if (/^https?:\/\//i.test(rawUserThumb)) {
            userAvatar = rawUserThumb;
          } else if (resp.config && resp.config.serverConfig) {
            const serverId = resp.config.serverConfig.id;
            userAvatar = `/api/poster?serverId=${encodeURIComponent(serverId)}&path=${encodeURIComponent(rawUserThumb)}`;
          }
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
        const durationSec = m.duration ? Math.round(m.duration / 1000) : 0;
        const viewOffsetSec = m.viewOffset ? Math.round(m.viewOffset / 1000) : 0;
        const progressPct = m.progress || (durationSec > 0 ? Math.round(viewOffsetSec / durationSec * 100) : 0);

        const media0 = Array.isArray(m.Media) && m.Media.length ? m.Media[0] : {};

        // Work out what exactly is being transcoded (video/audio/subtitles)
        let transcodingVideo = false;
        let transcodingAudio = false;
        let transcodingSubtitle = false;

        if (m.TranscodeSession) {
          const t = m.TranscodeSession;
          const vDec = (t.videoDecision || '').toString().toLowerCase();
          const aDec = (t.audioDecision || '').toString().toLowerCase();
          const sDec = (t.subtitleDecision || '').toString().toLowerCase();
          if (vDec === 'transcode') transcodingVideo = true;
          if (aDec === 'transcode') transcodingAudio = true;
          if (sDec === 'transcode' || sDec === 'burn') transcodingSubtitle = true;
        }

        if (!transcodingVideo && m.Video && m.Video[0] && typeof m.Video[0].decision === 'string') {
          const vDecTrack = m.Video[0].decision.toLowerCase();
          if (vDecTrack === 'transcode') transcodingVideo = true;
        }

        if (!transcodingAudio && m.Audio && m.Audio[0] && typeof m.Audio[0].decision === 'string') {
          const aDecTrack = m.Audio[0].decision.toLowerCase();
          if (aDecTrack === 'transcode') transcodingAudio = true;
        }

        if (!transcodingSubtitle && m.Subtitle && m.Subtitle[0] && typeof m.Subtitle[0].decision === 'string') {
          const sDecTrack = m.Subtitle[0].decision.toLowerCase();
          if (sDecTrack === 'transcode' || sDecTrack === 'burn') transcodingSubtitle = true;
        }

        let transcodeDetails = '';
        if (transcoding) {
          const parts = [];
          if (transcodingVideo) parts.push('Video');
          if (transcodingAudio) parts.push('Audio');
          if (transcodingSubtitle) parts.push('Subtitles');
          transcodeDetails = parts.join(' + ');
        }

        // Plex sometimes exposes an explicit transcode progress percentage
        let transcodeProgress = 0;
        if (m.TranscodeSession && typeof m.TranscodeSession.progress === 'number') {
          const p = m.TranscodeSession.progress;
          if (!Number.isNaN(p)) {
            transcodeProgress = Math.max(0, Math.min(100, Math.round(p)));
          }
        }

        // Derive a quality label when Plex does not provide one directly
        let quality = m.quality || '';
        if (!quality) {
          let resolution = '';
          if (m.Video && m.Video[0]) {
            resolution = m.Video[0].resolution || '';
          } else if (media0.videoResolution) {
            resolution = media0.videoResolution;
          }
          if (resolution && bandwidth) {
            quality = `${resolution} (${bandwidth.toFixed(1)} Mbps)`;
          } else if (bandwidth) {
            quality = `${bandwidth.toFixed(1)} Mbps`;
          } else if (resolution) {
            quality = resolution;
          }
        }

        // Stream / container / video / audio details for UI display
        let stream = '';
        if (transcoding) {
          // If Plex exposes a more detailed decision text, prefer it
          if (m.transcodeDecision) {
            stream = m.transcodeDecision;
          } else if (m.TranscodeSession && m.TranscodeSession.throttled) {
            // Match Plex-style "Transcode (Throttled)" when transcode is throttled
            stream = 'Transcode (Throttled)';
          } else {
            stream = 'Transcode';
          }
        } else {
          stream = 'Direct Play';
        }

        const plexContainer = m.container || media0.container || '';
        let container = '';
        if (transcoding) {
          // Example: "Converting (MKV  MKV)" – source and target container when known
          const source = media0.container || plexContainer || '';
          const target = (m.TranscodeSession && m.TranscodeSession.container) || source;
          if (source || target) {
            container = `Converting (${source || ''}  ${target || ''})`;
          } else {
            container = 'Converting';
          }
        } else if (plexContainer) {
          container = `Direct Play (${plexContainer.toUpperCase()})`;
        } else {
          container = '';
        }

        function mapDecision(decision) {
          const d = (decision || '').toString().toLowerCase();
          if (d === 'copy' || d === 'directstream' || d === 'direct stream') return 'Direct Stream';
          if (d === 'directplay' || d === 'direct play') return 'Direct Play';
          if (d === 'transcode') return 'Transcode';
          return decision || '';
        }

        let video = m.video || '';
        if (!video) {
          if (m.Video && m.Video[0]) {
            const v = m.Video[0];
            const dec = mapDecision(v.decision || (transcoding ? 'Transcode' : 'Direct Play'));
            const codec = v.codec || '';
            const res = v.resolution || '';
            const parts = [];
            if (dec) parts.push(dec);
            const right = [codec, res].filter(Boolean).join(' ');
            if (right) parts.push(`(${right})`);
            video = parts.join(' ');
          } else if (media0.videoCodec || media0.videoResolution) {
            const parts = [];
            if (media0.videoCodec) parts.push(media0.videoCodec.toString().toUpperCase());
            if (media0.videoResolution) parts.push(media0.videoResolution);
            video = parts.join(' ');
          }
        }

        let audio = m.audio || '';
        if (!audio) {
          if (m.Audio && m.Audio[0]) {
            const a = m.Audio[0];
            const dec = mapDecision(a.decision || (transcoding ? 'Transcode' : 'Direct Play'));
            const lang = a.language || '';
            const codec = a.codec || '';
            const ch = a.channels || '';
            const pieces = [];
            if (dec) pieces.push(dec);
            const rightParts = [];
            if (lang) rightParts.push(lang);
            if (codec) rightParts.push(codec);
            if (ch) rightParts.push(`${ch}`);
            const right = rightParts.join(' - ');
            if (right) pieces.push(`(${right})`);
            audio = pieces.join(' ');
          } else if (media0.audioCodec || media0.audioChannels) {
            const parts = [];
            if (media0.audioCodec) parts.push(media0.audioCodec.toString().toUpperCase());
            if (media0.audioChannels) parts.push(`${media0.audioChannels}`);
            audio = parts.join(' ');
          }
        }

        return {
          user: m.user || m.User?.title || 'Unknown',
          title: m.media_title || m.title || m.grandparentTitle || 'Unknown',
          // For TV episodes, Plex gives grandparentTitle as the series name
          seriesTitle: m.grandparentTitle || undefined,
          episode: m.episode || (m.grandparentTitle ? m.title : undefined),
          year: m.year,
          platform: m.platform || m.Player?.platform || m.Player?.product || '',
          state: m.state || m.Player?.state || '',
          poster: m.poster || normalizedPoster,
          duration: durationSec,
          viewOffset: viewOffsetSec,
          progress: progressPct,
          product: m.product || m.Player?.product || '',
          player: m.player || m.Player?.title || '',
          quality,
          stream,
          container,
          video,
          audio,
          transcodeDetails,
          transcodeProgress,
          subtitle: m.subtitle || (m.Subtitle && m.Subtitle[0] ? `${m.Subtitle[0].language || ''}` : 'None'),
          location: m.location || (m.Player?.local ? 'LAN' : 'WAN'),
          ip: m.Player?.address || '',
          bandwidth,
          // Season / episode numbers when available (Plex)
          seasonNumber: typeof m.parentIndex === 'number' ? m.parentIndex : undefined,
          episodeNumber: typeof m.index === 'number' ? m.index : undefined,
          channel: m.channelTitle || '',
          episodeTitle: m.episodeTitle || '',
          userName: m.user || m.User?.title || '',
          userAvatar,
          isLive: m.type === 'live',
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
            // Some flat Jellyfin/Emby formats include series/season/episode info separately
            seriesTitle: s.series || s.SeriesTitle || undefined,
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
            // Season / episode numbers for flat Jellyfin/Emby format when provided
            seasonNumber: typeof s.season === 'number' ? s.season
              : (typeof s.SeasonNumber === 'number' ? s.SeasonNumber : undefined),
            episodeNumber: typeof s.episodeNumber === 'number' ? s.episodeNumber
              : (typeof s.IndexNumber === 'number' ? s.IndexNumber : undefined),
            transcoding: s.transcoding,
          };
        }
        // Standard Jellyfin/Emby API: treat any session with NowPlayingItem and PlayState as active
        if (s.NowPlayingItem && s.PlayState) {
          let posterUrl;
          if (resp.config && resp.config.serverConfig) {
            const serverId = resp.config.serverConfig.id;
            let itemId = s.NowPlayingItem.Id;
            const seriesId = s.NowPlayingItem.SeriesId;
            if (s.NowPlayingItem.Type === 'Episode' && seriesId) {
              itemId = seriesId;
            }
            if (itemId) {
              const embyPath = `/Items/${itemId}/Images/Primary`;
              posterUrl = `/api/poster?serverId=${encodeURIComponent(serverId)}&path=${encodeURIComponent(embyPath)}`;
            }
          }
          // Fallback placeholder for LiveTv sessions without artwork
          if (!posterUrl && s.NowPlayingItem?.Type === 'LiveTv') {
            posterUrl = '/live_tv_placeholder.svg';
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

          // Jellyfin/Emby transcode progress when available
          let transcodeProgress = 0;
          if (s.TranscodingInfo) {
            if (typeof s.TranscodingInfo.CompletionPercentage === 'number') {
              transcodeProgress = s.TranscodingInfo.CompletionPercentage;
            } else if (typeof s.TranscodingInfo.Progress === 'number') {
              transcodeProgress = s.TranscodingInfo.Progress;
            }
            if (!Number.isNaN(transcodeProgress)) {
              transcodeProgress = Math.max(0, Math.min(100, Math.round(transcodeProgress)));
            } else {
              transcodeProgress = 0;
            }
          }
          return {
            user: s.UserName || 'Unknown',
            title: s.NowPlayingItem?.Name || 'Idle',
            // Standard Jellyfin/Emby: SeriesName + EpisodeTitle
            seriesTitle: s.NowPlayingItem?.SeriesName || undefined,
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
            transcodeProgress,
            channel: s.NowPlayingItem?.ChannelName || '',
            isLive: (s.NowPlayingItem?.Type === 'LiveTv') || (s.NowPlayingItem?.IsLive === true),
            // Season / episode numbers for Jellyfin/Emby standard API
            seasonNumber: typeof s.NowPlayingItem?.ParentIndexNumber === 'number'
              ? s.NowPlayingItem.ParentIndexNumber
              : undefined,
            episodeNumber: typeof s.NowPlayingItem?.IndexNumber === 'number'
              ? s.NowPlayingItem.IndexNumber
              : undefined,
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
    // Attach server config for poster URL generation and proxying
    resp.config.serverConfig = {
      id: s.id,
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
  if (!servers || servers.length === 0) {
    lastPollAt = new Date().toISOString();
    lastPollDurationMs = 0;
    lastPollError = null;
    return;
  }
  const start = Date.now();
  lastPollError = null;
  try {
    await Promise.all(servers.map((s) => pollServer(s)));
  } catch (e) {
    // Capture any unexpected top-level error from Promise.all; individual server
    // errors are already recorded on their respective status entries.
    lastPollError = e && e.message ? e.message : String(e);
  }
  const duration = Date.now() - start;
  lastPollAt = new Date().toISOString();
  lastPollDurationMs = duration;

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
      // Trim to MAX_HISTORY rows to keep DB small (if configured)
      if (MAX_HISTORY > 0) {
        historyDb.run(
          'DELETE FROM history WHERE id NOT IN (SELECT id FROM history ORDER BY id DESC LIMIT ?)',
          [MAX_HISTORY],
          (err) => {
            if (err) console.error('Failed to trim history database:', err.message);
          }
        );
      }
    });
  }
  // After updating statuses and history, evaluate and send any outbound notifications
  triggerNotifiers();
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
    setup: enabledServers.length === 0,
    poll: {
      lastPollAt,
      lastPollDurationMs,
      lastPollError
    },
    version: appVersion || null
  });
});

// Lightweight health endpoint for external monitors (e.g., Home Assistant, Uptime Kuma)
app.get('/api/health', (req, res) => {
  const enabledServers = servers.filter(s => !s.disabled);
  const total = enabledServers.length;
  let online = 0;
  let offline = 0;
  enabledServers.forEach(s => {
    const st = statuses[s.id];
    if (!st) {
      offline++;
      return;
    }
    if (st.online) online++; else offline++;
  });

  let overall = 'ok';
  if (total > 0 && online === 0) {
    overall = 'down';
  } else if (offline > 0) {
    overall = 'degraded';
  }

  res.json({
    status: overall,
    time: new Date().toISOString(),
    version: appVersion || null,
    poll: {
      lastPollAt,
      lastPollDurationMs,
      lastPollError
    },
    servers: {
      total,
      online,
      offline
    }
  });
});

// Proxy poster artwork so the browser doesn't need direct access
// to Plex/Jellyfin/Emby base URLs or tokens. The frontend passes
// a serverId and a relative artwork path (e.g. /library/metadata/...)
// and this endpoint streams the image back.
app.get('/api/poster', async (req, res) => {
  try {
    const { serverId, path: artworkPath } = req.query;
    if (!serverId || !artworkPath) {
      return res.status(400).end();
    }
    const server = servers.find(s => String(s.id) === String(serverId));
    if (!server || !server.baseUrl) {
      return res.status(404).end();
    }
    let base = server.baseUrl;
    if (base.endsWith('/')) base = base.slice(0, -1);
    const rel = String(artworkPath).startsWith('/') ? String(artworkPath) : '/' + String(artworkPath);
    let url = base + rel;
    // Attach token using the same rules as pollServer
    if (server.token) {
      const tokenLoc = server.tokenLocation || (server.type === 'plex' ? 'query' : 'header');
      if (tokenLoc === 'query') {
        const sep = url.includes('?') ? '&' : '?';
        if (server.type === 'plex') {
          url += `${sep}X-Plex-Token=${encodeURIComponent(server.token)}`;
        } else if (server.type === 'jellyfin') {
          url += `${sep}api_key=${encodeURIComponent(server.token)}`;
        } else {
          url += `${sep}X-Emby-Token=${encodeURIComponent(server.token)}`;
        }
      }
    }
    const headers = {};
    if (server.token) {
      const tokenLoc = server.tokenLocation || (server.type === 'plex' ? 'query' : 'header');
      if (tokenLoc === 'header') {
        if (server.type === 'plex') {
          headers['X-Plex-Token'] = server.token;
        } else if (server.type === 'jellyfin') {
          headers['X-MediaBrowser-Token'] = server.token;
        } else {
          headers['X-Emby-Token'] = server.token;
        }
      }
    }
    const resp = await axios.get(url, { responseType: 'stream', headers });
    if (resp.headers['content-type']) {
      res.setHeader('Content-Type', resp.headers['content-type']);
    }
    resp.data.pipe(res);
  } catch (e) {
    console.error('[OmniStream] Poster proxy failed:', e.message);
    res.status(502).end();
  }
});

// Simple history API - backed by SQLite
app.get('/api/history', (req, res) => {
  if (!historyDb) return res.json({ history: [] });
  let sql = 'SELECT time, serverId, serverName, type, user, title, stream, transcoding, location, bandwidth FROM history ORDER BY id ASC';
  const params = [];
  if (MAX_HISTORY > 0) {
    sql += ' LIMIT ?';
    params.push(MAX_HISTORY);
  }
  historyDb.all(sql, params, (err, rows) => {
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
  });
});

// Basic system info for reliability/inspection
app.get('/api/system', (req, res) => {
  const overseerrCfg = appConfig && appConfig.overseerr ? appConfig.overseerr : null;
  res.json({
    version: appVersion,
    uptimeSeconds: process.uptime(),
    now: new Date().toISOString(),
    historyDbPath: HISTORY_DB_FILE,
    serversFilePath: SERVERS_FILE,
    hasHistoryDb: !!historyDb,
    maxHistory: MAX_HISTORY,
    poll: {
      lastPollAt,
      lastPollDurationMs,
      lastPollError
    },
    backupEnabled: !!archiver,
    importHistory: {
      lastRunAt: lastImportRunAt,
      lastResults: lastImportResults
    },
    notifiers: {
      lastError: lastNotifierError,
      lastErrorAt: lastNotifierErrorAt,
      lastErrorChannel: lastNotifierErrorChannel
    },
    overseerr: {
      configured: !!(overseerrCfg && overseerrCfg.baseUrl && overseerrCfg.apiKey)
    }
  });
});

// One-click backup: zip servers.json + history.db into a single download
app.get('/api/system/backup', (req, res) => {
  try {
    if (!archiver) {
      return res.status(500).json({ error: 'Backup zip not available (archiver not installed on server).' });
    }

    const hasServers = fs.existsSync(SERVERS_FILE);
    const hasHistory = historyDb && fs.existsSync(HISTORY_DB_FILE);
    if (!hasServers && !hasHistory) {
      return res.status(404).json({ error: 'Nothing to back up (no servers.json or history.db found).' });
    }

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `omnistream-backup-${ts}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (err) => {
      console.error('[OmniStream] Backup zip error:', err.message);
      try { res.status(500).end(); } catch (_) {}
    });

    archive.pipe(res);
    if (hasServers) {
      archive.file(SERVERS_FILE, { name: 'servers.json' });
    }
    if (hasHistory) {
      archive.file(HISTORY_DB_FILE, { name: 'history.db' });
    }
    archive.finalize();
  } catch (e) {
    console.error('[OmniStream] Failed to create backup zip:', e.message);
    res.status(500).json({ error: 'Failed to create backup zip' });
  }
});

// Fetch basic user info (name + email) from Overseerr, if configured
async function fetchOverseerrUsers() {
  const cfg = appConfig && appConfig.overseerr ? appConfig.overseerr : null;
  if (!cfg || !cfg.baseUrl || !cfg.apiKey) {
    throw new Error('Overseerr is not configured (baseUrl/apiKey missing in config.json).');
  }
  const base = String(cfg.baseUrl).replace(/\/$/, '');
  const headers = {
    'X-Api-Key': cfg.apiKey
  };
  const allUsers = [];
  let skip = 0;
  const pageSize = 100;
  // Simple pagination with a hard guard on pages
  for (let page = 0; page < 50; page++) {
    const params = { take: pageSize, skip };
    let resp;
    try {
      resp = await axios.get(base + '/api/v1/user', { headers, params, timeout: 15000 });
    } catch (e) {
      throw new Error('Failed to contact Overseerr: ' + (e.message || String(e)));
    }
    const data = resp.data;
    const batch = Array.isArray(data)
      ? data
      : (Array.isArray(data.results) ? data.results : []);
    if (!batch.length) break;
    allUsers.push(...batch);
    if (batch.length < pageSize) break;
    skip += batch.length;
  }
  // Map down to a safe shape for the client
  const mapped = allUsers.map(u => {
    const email = u.email || u.emailAddress || u.userEmail || null;
    const name = u.displayName || u.username || u.name || email || null;
    return {
      id: u.id ?? u.userId ?? null,
      name,
      email
    };
  });
  return mapped;
}

app.get('/api/overseerr/users', async (req, res) => {
  try {
    const users = await fetchOverseerrUsers();
    // Only keep users that have an email address
    const withEmail = users.filter(u => u && u.email);

    // Look up which Overseerr users are already imported as subscribers
    let flagsById = new Map();
    let flagsByEmail = new Map();
    if (historyDb) {
      try {
        const rows = await new Promise((resolve, reject) => {
          historyDb.all(
            'SELECT externalId, email, active FROM newsletter_subscribers WHERE source = ?',
            ['overseerr'],
            (err, rows) => {
              if (err) return reject(err);
              resolve(rows || []);
            }
          );
        });
        rows.forEach(r => {
          const extId = r.externalId != null ? String(r.externalId) : null;
          const email = (r.email || '').toLowerCase();
          const active = Number(r.active) === 1;
          if (extId) {
            flagsById.set(extId, { imported: true, active });
          }
          if (email) {
            if (!flagsByEmail.has(email)) {
              flagsByEmail.set(email, { imported: true, active });
            }
          }
        });
      } catch (e) {
        console.error('[OmniStream] Failed to load existing Overseerr subscribers:', e.message);
        flagsById = new Map();
        flagsByEmail = new Map();
      }
    }

    const enriched = withEmail.map(u => {
      let imported = false;
      let subscriberActive = false;
      const extId = u.id != null ? String(u.id) : null;
      const emailKey = u.email ? u.email.toLowerCase() : null;
      if (extId && flagsById.has(extId)) {
        const info = flagsById.get(extId);
        imported = !!info.imported;
        subscriberActive = !!info.active;
      } else if (emailKey && flagsByEmail.has(emailKey)) {
        const info = flagsByEmail.get(emailKey);
        imported = !!info.imported;
        subscriberActive = !!info.active;
      }
      return {
        ...u,
        imported,
        subscriberActive
      };
    });

    res.json({
      total: users.length,
      withEmail: withEmail.length,
      users: enriched
    });
  } catch (e) {
    console.error('[OmniStream] /api/overseerr/users failed:', e.message);
    res.status(500).json({ error: e.message || 'Failed to fetch Overseerr users' });
  }
});

// Import Overseerr users with email into the local subscribers table for later newsletters
async function importOverseerrSubscribers() {
  if (!historyDb) {
    throw new Error('history DB not available');
  }
  const users = await fetchOverseerrUsers();
  const withEmail = users.filter(u => u && u.email);
  const now = new Date().toISOString();

  return await new Promise((resolve, reject) => {
    historyDb.serialize(() => {
      // Ensure table exists (in case DB was created before this version)
      historyDb.run(
        'CREATE TABLE IF NOT EXISTS newsletter_subscribers (\n' +
        '  id INTEGER PRIMARY KEY AUTOINCREMENT,\n' +
        "  source TEXT NOT NULL,\n" +
        "  externalId TEXT,\n" +
        "  name TEXT,\n" +
        "  email TEXT NOT NULL,\n" +
        "  createdAt TEXT NOT NULL,\n" +
        "  updatedAt TEXT NOT NULL,\n" +
        "  active INTEGER NOT NULL DEFAULT 1,\n" +
        '  UNIQUE(source, externalId)\n' +
        ')'
      );
      const stmt = historyDb.prepare(
        'INSERT INTO newsletter_subscribers (source, externalId, name, email, createdAt, updatedAt, active) ' +
        'VALUES (?, ?, ?, ?, ?, ?, 1) ' +
        'ON CONFLICT(source, externalId) DO UPDATE SET ' +
        '  name = excluded.name, ' +
        '  email = excluded.email, ' +
        '  updatedAt = excluded.updatedAt, ' +
        '  active = 1'
      );

      let processed = 0;
      withEmail.forEach(u => {
        const externalId = u.id != null ? String(u.id) : null;
        const name = u.name || u.email;
        stmt.run('overseerr', externalId, name, u.email, now, now, (err) => {
          if (err) {
            console.error('[OmniStream] Failed to upsert subscriber from Overseerr:', err.message);
            return; // continue with others
          }
          processed++;
        });
      });
      stmt.finalize((err) => {
        if (err) {
          return reject(err);
        }
        resolve({
          total: users.length,
          withEmail: withEmail.length,
          imported: withEmail.length, // number attempted; per-row errors are logged
        });
      });
    });
  });
}

app.post('/api/subscribers/import/overseerr', async (req, res) => {
  try {
    const result = await importOverseerrSubscribers();
    res.json(result);
  } catch (e) {
    console.error('[OmniStream] /api/subscribers/import/overseerr failed:', e.message);
    res.status(500).json({ error: e.message || 'Failed to import subscribers from Overseerr' });
  }
});

// Simple summary of subscribers for UI (total and active, grouped by source)
app.get('/api/subscribers/summary', (req, res) => {
  if (!historyDb) {
    return res.json({ total: 0, active: 0, sources: {} });
  }
  historyDb.all(
    'SELECT source, COUNT(*) AS total, SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END) AS active ' +
    'FROM newsletter_subscribers GROUP BY source',
    [],
    (err, rows) => {
      if (err) {
        console.error('[OmniStream] Failed to read subscribers summary:', err.message);
        return res.status(500).json({ total: 0, active: 0, sources: {} });
      }
      const sources = {};
      let total = 0;
      let active = 0;
      (rows || []).forEach(r => {
        const src = r.source || 'unknown';
        const t = Number(r.total) || 0;
        const a = Number(r.active) || 0;
        sources[src] = { total: t, active: a };
        total += t;
        active += a;
        });
        res.json({ total, active, sources });
      }
    );
  });

  // List subscribers for management UI (optional filters, basic limit)
  app.get('/api/subscribers', (req, res) => {
    if (!historyDb) {
      return res.json({ total: 0, items: [] });
    }

    const { source, active, q } = req.query;
    const where = [];
    const params = [];

    if (source) {
      where.push('source = ?');
      params.push(String(source));
    }

    if (typeof active !== 'undefined') {
      const v = String(active).toLowerCase();
      if (v === '1' || v === 'true') {
        where.push('active = 1');
      } else if (v === '0' || v === 'false') {
        where.push('active = 0');
      }
    }

    if (q) {
      const needle = `%${String(q).toLowerCase()}%`;
      where.push('(LOWER(name) LIKE ? OR LOWER(email) LIKE ? OR LOWER(source) LIKE ?)');
      params.push(needle, needle, needle);
    }

    const DEFAULT_LIMIT = 500;
    const MAX_LIMIT = 1000;
    let limit = Number(req.query.limit) || DEFAULT_LIMIT;
    if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIMIT;
    if (limit > MAX_LIMIT) limit = MAX_LIMIT;
    let offset = Number(req.query.offset) || 0;
    if (!Number.isFinite(offset) || offset < 0) offset = 0;

    let sql = 'SELECT id, source, externalId, name, email, createdAt, updatedAt, active FROM newsletter_subscribers';
    if (where.length) {
      sql += ' WHERE ' + where.join(' AND ');
    }
    sql += ' ORDER BY datetime(createdAt) DESC, id DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    historyDb.all(sql, params, (err, rows) => {
      if (err) {
        console.error('[OmniStream] Failed to read subscribers:', err.message);
        return res.status(500).json({ total: 0, items: [] });
      }
      const items = (rows || []).map(r => ({
        id: r.id,
        source: r.source,
        externalId: r.externalId,
        name: r.name,
        email: r.email,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        active: Number(r.active) === 1
      }));
      res.json({ total: items.length, items });
    });
  });

  // Toggle subscriber active flag
  app.put('/api/subscribers/:id', (req, res) => {
    if (!historyDb) {
      return res.status(500).json({ error: 'history DB not available' });
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid subscriber id' });
    }
    const body = req.body || {};
    if (typeof body.active === 'undefined') {
      return res.status(400).json({ error: 'active field is required' });
    }
    const active = body.active ? 1 : 0;
    const now = new Date().toISOString();

    historyDb.run(
      'UPDATE newsletter_subscribers SET active = ?, updatedAt = ? WHERE id = ?',
      [active, now, id],
      function(err) {
        if (err) {
          console.error('[OmniStream] Failed to update subscriber:', err.message);
          return res.status(500).json({ error: 'Failed to update subscriber' });
        }
        if (this.changes === 0) {
          return res.status(404).json({ error: 'Subscriber not found' });
        }
        historyDb.get(
          'SELECT id, source, externalId, name, email, createdAt, updatedAt, active FROM newsletter_subscribers WHERE id = ?',
          [id],
          (err2, row) => {
            if (err2 || !row) {
              if (err2) {
                console.error('[OmniStream] Failed to read updated subscriber:', err2.message);
              }
              return res.json({ id, active: !!active });
            }
            res.json({
              id: row.id,
              source: row.source,
              externalId: row.externalId,
              name: row.name,
              email: row.email,
              createdAt: row.createdAt,
              updatedAt: row.updatedAt,
              active: Number(row.active) === 1
            });
          }
        );
      }
    );
  });

  // Send a simple newsletter/broadcast email to all active subscribers
  app.post('/api/newsletter/send', async (req, res) => {
    try {
      if (!historyDb) {
        return res.status(500).json({ error: 'history DB not available' });
      }
      if (!nodemailer) {
        return res.status(500).json({ error: 'Email sending not available (nodemailer not installed).' });
      }
      const emailCfg = appConfig?.newsletterEmail;
      if (!emailCfg || emailCfg.enabled === false) {
        return res.status(400).json({ error: 'Newsletter email is not configured or disabled.' });
      }

      const subject = (req.body && String(req.body.subject || '').trim()) || '';
      const body = (req.body && String(req.body.body || '').trim()) || '';
      if (!subject || !body) {
        return res.status(400).json({ error: 'subject and body are required' });
      }

      const rows = await new Promise((resolve, reject) => {
        historyDb.all(
          'SELECT DISTINCT email, name FROM newsletter_subscribers WHERE active = 1 AND email IS NOT NULL',
          [],
          (err, rows) => {
            if (err) return reject(err);
            resolve(rows || []);
          }
        );
      });

      const emails = rows
        .map(r => (r && r.email ? String(r.email).trim() : ''))
        .filter(e => !!e);
      const uniqueEmails = Array.from(new Set(emails));

      if (!uniqueEmails.length) {
        return res.json({ sent: 0, message: 'No active subscribers with email found.' });
      }

      const transport = nodemailer.createTransport(emailCfg.smtp || {});
      const mailOptions = {
        from: emailCfg.from,
        to: emailCfg.to || emailCfg.from,
        bcc: uniqueEmails,
        subject,
        text: body
      };

      await transport.sendMail(mailOptions);
      res.json({ sent: uniqueEmails.length });
    } catch (e) {
      console.error('[OmniStream] Newsletter send failed:', e.message);
      recordNotifierError('newsletter', e.message);
      res.status(500).json({ error: 'Failed to send newsletter' });
    }
  });

  // Helper: fetch recently added items from enabled Plex servers
  async function fetchPlexRecentlyAdded({ perServer = 10 } = {}) {
    const enabledPlex = servers.filter(s => !s.disabled && s.type === 'plex' && s.token);
    const results = [];
    for (const server of enabledPlex) {
      const base = (server.baseUrl || '').replace(/\/$/, '');
      const url = base + '/library/recentlyAdded';
      const headers = {};
      const params = {
        'X-Plex-Container-Start': 0,
        'X-Plex-Container-Size': perServer
      };
      const tokenLoc = server.tokenLocation || 'query';
      if (tokenLoc === 'header') {
        headers['X-Plex-Token'] = server.token;
      } else {
        params['X-Plex-Token'] = server.token;
      }
      try {
        const resp = await axios.get(url, { headers, params, timeout: 15000 });
        const mc = resp.data && resp.data.MediaContainer ? resp.data.MediaContainer : null;
        const items = mc && Array.isArray(mc.Metadata) ? mc.Metadata : [];
        items.forEach(m => {
          const rawType = (m.type || '').toLowerCase();
          const isMovie = rawType === 'movie';
          const isEpisode = rawType === 'episode';
          if (!isMovie && !isEpisode) return;
          let title;
          if (isEpisode || m.grandparentTitle) {
            const series = m.grandparentTitle || '';
            const epName = m.title || '';
            const seasonNum = typeof m.parentIndex === 'number' ? m.parentIndex : null;
            const epNum = typeof m.index === 'number' ? m.index : null;
            let epLabel = '';
            if (seasonNum !== null && epNum !== null) {
              epLabel = `S${String(seasonNum).padStart(2, '0')}E${String(epNum).padStart(2, '0')}`;
            } else if (epNum !== null) {
              epLabel = `E${String(epNum).padStart(2, '0')}`;
            }
            if (series && epLabel && epName) {
              title = `${series} - ${epLabel} - ${epName}`;
            } else if (series && epName) {
              title = `${series} - ${epName}`;
            } else {
              title = epName || series || m.title || m.originalTitle || 'Unknown';
            }
          } else {
            title = m.title || m.originalTitle || 'Unknown';
          }
          let addedAtIso;
          if (typeof m.addedAt === 'number') {
            addedAtIso = new Date(m.addedAt * 1000).toISOString();
          } else if (typeof m.addedAt === 'string') {
            const parsed = Date.parse(m.addedAt);
            addedAtIso = Number.isNaN(parsed) ? new Date().toISOString() : new Date(parsed).toISOString();
          } else {
            addedAtIso = new Date().toISOString();
          }
          results.push({
            serverId: server.id,
            serverName: server.name || server.baseUrl,
            type: isMovie ? 'movie' : 'episode',
            title,
            year: m.year || null,
            addedAt: addedAtIso
          });
        });
      } catch (e) {
        console.error(`[OmniStream] Failed to fetch recently added from Plex server ${server.name || server.baseUrl}:`, e.message);
      }
    }
    // Sort newest first
    results.sort((a, b) => {
      const ta = Date.parse(a.addedAt) || 0;
      const tb = Date.parse(b.addedAt) || 0;
      return tb - ta;
    });
    return results;
  }

  // Expose recently added Plex items for newsletter/template helpers
  app.get('/api/newsletter/plex/recently-added', async (req, res) => {
    try {
      const limit = Number(req.query.limit) || 20;
      const perServer = Number(req.query.perServer) || 10;
      const items = await fetchPlexRecentlyAdded({ perServer });
      res.json({
        total: items.length,
        items: items.slice(0, limit)
      });
    } catch (e) {
      console.error('[OmniStream] /api/newsletter/plex/recently-added failed:', e.message);
      res.status(500).json({ error: 'Failed to fetch recently added from Plex' });
    }
  });

// Compact summary for Home Assistant and other external dashboards
// Provides a stable, low-noise JSON shape that can be used with
// Home Assistant REST sensors or templates.
app.get('/api/ha/summary', (req, res) => {
  try {
    const enabledServers = servers.filter(s => !s.disabled);
    const totalServers = enabledServers.length;
    let online = 0;
    let offline = 0;
    let totalStreams = 0;
    let directStreams = 0;
    let transcodeStreams = 0;
    let wanStreams = 0;

    enabledServers.forEach(s => {
      const st = statuses[s.id];
      if (!st) {
        offline++;
        return;
      }
      if (st.online) online++; else offline++;
      const sessions = Array.isArray(st.sessions) ? st.sessions : [];
      sessions.forEach(sess => {
        totalStreams++;
        const isWan = sess.location && typeof sess.location === 'string' && sess.location.toUpperCase().includes('WAN');
        if (isWan) wanStreams++;
        let isTranscode = false;
        if (typeof sess.transcoding === 'boolean') {
          isTranscode = sess.transcoding;
        } else if (sess.stream && typeof sess.stream === 'string' && sess.stream.toLowerCase().includes('transcode')) {
          isTranscode = true;
        } else if (sess.state && typeof sess.state === 'string' && sess.state.toLowerCase().includes('transcode')) {
          isTranscode = true;
        }
        if (isTranscode) transcodeStreams++; else directStreams++;
      });
    });

    let overall = 'ok';
    if (totalServers > 0 && online === 0) {
      overall = 'down';
    } else if (offline > 0) {
      overall = 'degraded';
    }

    res.json({
      status: overall,
      version: appVersion || null,
      poll: {
        lastPollAt,
        lastPollDurationMs,
        lastPollError
      },
      servers: {
        total: totalServers,
        online,
        offline
      },
      streams: {
        total: totalStreams,
        direct: directStreams,
        transcode: transcodeStreams,
        wan: wanStreams
      }
    });
  } catch (e) {
    console.error('[OmniStream] /api/ha/summary failed:', e.message);
    res.status(500).json({ error: 'failed to build summary' });
  }
});

// Simple download endpoints for key state files
app.get('/api/download/servers', (req, res) => {
  try {
    if (!fs.existsSync(SERVERS_FILE)) {
      return res.status(404).json({ error: 'servers.json not found' });
    }
    res.download(SERVERS_FILE, 'servers.json');
  } catch (e) {
    console.error('[OmniStream] Failed to download servers.json:', e.message);
    res.status(500).json({ error: 'Failed to download servers.json' });
  }
});

app.get('/api/download/history', (req, res) => {
  try {
    if (!historyDb || !fs.existsSync(HISTORY_DB_FILE)) {
      return res.status(404).json({ error: 'history database not available' });
    }
    res.download(HISTORY_DB_FILE, 'history.db');
  } catch (e) {
    console.error('[OmniStream] Failed to download history.db:', e.message);
    res.status(500).json({ error: 'Failed to download history.db' });
  }
});

// Queryable history API with basic filters and sorting
app.get('/api/history/query', (req, res) => {
  if (!historyDb) return res.json({ history: [] });
  const {
    serverId,
    user,
    q,
    from,
    to,
    sort = 'time',
    order = 'desc',
    limit
  } = req.query;

  const where = [];
  const params = [];
  if (serverId) {
    where.push('serverId = ?');
    params.push(serverId);
  }
  if (user) {
    where.push('LOWER(user) LIKE ?');
    params.push(`%${String(user).toLowerCase()}%`);
  }
  if (q) {
    const needle = `%${String(q).toLowerCase()}%`;
    where.push('(LOWER(title) LIKE ? OR LOWER(stream) LIKE ? OR LOWER(user) LIKE ? OR LOWER(serverName) LIKE ?)');
    params.push(needle, needle, needle, needle);
  }
  if (from) {
    where.push('time >= ?');
    params.push(from);
  }
  if (to) {
    where.push('time <= ?');
    params.push(to);
  }

  let orderBy = 'time DESC';
  const dir = String(order).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
  if (sort === 'bandwidth') {
    orderBy = `bandwidth ${dir}`;
  } else {
    orderBy = `time ${dir}`;
  }

  let max;
  let limitClause = '';
  if (MAX_HISTORY > 0) {
    max = Math.min(Number(limit) || MAX_HISTORY, MAX_HISTORY);
    limitClause = ' LIMIT ?';
    params.push(max);
  } else if (limit) {
    const requested = Number(limit);
    if (Number.isFinite(requested) && requested > 0) {
      max = requested;
      limitClause = ' LIMIT ?';
      params.push(max);
    }
  }

  const sql = `SELECT time, serverId, serverName, type, user, title, stream, transcoding, location, bandwidth
               FROM history
               ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY ${orderBy}${limitClause}`;

  historyDb.all(sql, params, (err, rows) => {
    if (err) {
      console.error('Failed to query history database:', err.message);
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
  });
});

// Import watch history from supported backends (Jellyfin/Emby/Plex)
app.post('/api/import-history', async (req, res) => {
  if (!historyDb) return res.status(500).json({ error: 'history DB not available' });
  const enabledServers = servers.filter(s => !s.disabled && (s.type === 'jellyfin' || s.type === 'emby' || s.type === 'plex'));
  const results = [];
  for (const s of enabledServers) {
    if (s.type === 'plex') {
      const r = await importPlexHistory(s, { limit: 1000 });
      results.push(r);
    } else {
      // Jellyfin/Emby share the same import helper
      const r = await importJellyfinHistory(s, { limitPerUser: 200 });
      results.push(r);
    }
  }
  lastImportRunAt = new Date().toISOString();
  lastImportResults = results;
  res.json({ results });
});

// Derived notifications based on current statuses
function buildNotificationsSnapshot() {
  const notifications = [];
  const now = new Date().toISOString();
  const rules = (appConfig.notifiers && appConfig.notifiers.rules) || {};
  const offlineRule = rules.offline || {};
  const wanRule = rules.wanTranscodes || {};
  const highRule = rules.highBandwidth || {};
   const anyWanRule = rules.anyWan || {};
   const highWanRule = rules.highWanBandwidth || {};
  const offlineEnabled = offlineRule.enabled !== false;
  const wanEnabled = wanRule.enabled !== false;
  const highEnabled = highRule.enabled !== false;
   const anyWanEnabled = anyWanRule.enabled === true; // opt-in to avoid noise
  const highThreshold = typeof highRule.thresholdMbps === 'number' && !Number.isNaN(highRule.thresholdMbps)
    ? highRule.thresholdMbps
    : 50;
   const highWanThreshold = typeof highWanRule.thresholdMbps === 'number' && !Number.isNaN(highWanRule.thresholdMbps)
    ? highWanRule.thresholdMbps
    : 30;
  Object.values(statuses).forEach(st => {
    // Server offline
    if (!st.online && offlineEnabled) {
      notifications.push({
        id: `offline-${st.id}`,
        level: 'error',
        serverId: st.id,
        serverName: st.name,
        time: now,
        kind: 'offline',
        message: `${st.name || 'Server'} is offline`
      });
      return;
    }
    const sessions = st.sessions || [];

    // Any WAN transcodes
    const wanTranscodes = sessions.filter(sess => {
      const isWan = sess.location && sess.location.toUpperCase().includes('WAN');
      let isTranscode = false;
      if (typeof sess.transcoding === 'boolean') isTranscode = sess.transcoding;
      else if (sess.stream && typeof sess.stream === 'string' && sess.stream.toLowerCase().includes('transcode')) isTranscode = true;
      else if (sess.state && typeof sess.state === 'string' && sess.state.toLowerCase().includes('transcode')) isTranscode = true;
      return isWan && isTranscode;
    });
    if (wanEnabled && wanTranscodes.length > 0) {
      notifications.push({
        id: `wan-transcode-${st.id}`,
        level: 'warn',
        serverId: st.id,
        serverName: st.name,
        time: now,
        kind: 'wanTranscode',
        message: `${wanTranscodes.length} WAN transcode${wanTranscodes.length > 1 ? 's' : ''} active on ${st.name || 'server'}`
      });
    }

    // Any WAN streams (direct or transcode) – optional, more chatty
    if (anyWanEnabled) {
      const wanSessions = sessions.filter(sess => sess.location && sess.location.toUpperCase().includes('WAN'));
      if (wanSessions.length > 0) {
        notifications.push({
          id: `wan-any-${st.id}`,
          level: 'info',
          serverId: st.id,
          serverName: st.name,
          time: now,
          kind: 'anyWan',
          message: `${wanSessions.length} WAN stream${wanSessions.length > 1 ? 's' : ''} active on ${st.name || 'server'}`
        });
      }
    }

    // High total bandwidth (simple threshold)
    const summary = st.summary || {};
    const totalBw = typeof summary.totalBandwidth === 'number' ? summary.totalBandwidth : 0;
    if (highEnabled && totalBw > highThreshold) {
      notifications.push({
        id: `high-bandwidth-${st.id}`,
        level: 'warn',
        serverId: st.id,
        serverName: st.name,
        time: now,
        kind: 'highBandwidth',
        message: `High total bandwidth on ${st.name || 'server'}: ${totalBw.toFixed(1)} Mbps (threshold ${highThreshold.toFixed(1)} Mbps)`
      });
    }

    // High WAN bandwidth (Plex has WAN breakdown; Jellyfin/Emby may be zero)
    const wanBw = typeof summary.wanBandwidth === 'number' ? summary.wanBandwidth : 0;
    if (highWanRule.enabled !== false && wanBw > highWanThreshold) {
      notifications.push({
        id: `high-wan-bandwidth-${st.id}`,
        level: 'warn',
        serverId: st.id,
        serverName: st.name,
        time: now,
        kind: 'highWanBandwidth',
        message: `High WAN bandwidth on ${st.name || 'server'}: ${wanBw.toFixed(1)} Mbps (threshold ${highWanThreshold.toFixed(1)} Mbps)`
      });
    }
  });
  return notifications;
}

app.get('/api/notifications', (req, res) => {
  const notifications = buildNotificationsSnapshot();
  res.json({ notifications });
});

// Fire a synthetic test notification through configured notifiers
app.post('/api/notifiers/test', (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const requested = Array.isArray(body.channels) ? body.channels : null;
    const notifierCfg = (appConfig && appConfig.notifiers) || {};
    const notification = {
      id: `test-${Date.now()}`,
      level: 'info',
      serverId: 'test',
      serverName: 'OmniStream',
      time: new Date().toISOString(),
      kind: 'test',
      message: 'This is a test notification from OmniStream. If you received this, your notifier is working.'
    };
    const sent = [];

    const shouldUse = (name) => !requested || requested.includes(name);

    if (shouldUse('discord') && notifierCfg.discord && notifierCfg.discord.webhookUrl) {
      sendDiscordNotification(notification);
      sent.push('discord');
    }
    if (shouldUse('email') && notifierCfg.email && notifierCfg.email.enabled !== false && notifierCfg.email.from && notifierCfg.email.to) {
      sendEmailNotification(notification);
      sent.push('email');
    }
    if (shouldUse('webhook') && notifierCfg.webhook && notifierCfg.webhook.url) {
      sendGenericWebhookNotification(notification);
      sent.push('webhook');
    }
    if (shouldUse('slack') && notifierCfg.slack && notifierCfg.slack.webhookUrl) {
      sendSlackNotification(notification);
      sent.push('slack');
    }
    if (shouldUse('telegram') && notifierCfg.telegram && notifierCfg.telegram.botToken && notifierCfg.telegram.chatId) {
      sendTelegramNotification(notification);
      sent.push('telegram');
    }
    if (shouldUse('twilio') && notifierCfg.twilio && notifierCfg.twilio.accountSid && notifierCfg.twilio.authToken && notifierCfg.twilio.from && notifierCfg.twilio.to) {
      sendTwilioSmsNotification(notification);
      sent.push('twilio');
    }
    if (shouldUse('pushover') && notifierCfg.pushover && notifierCfg.pushover.user && notifierCfg.pushover.token) {
      sendPushoverNotification(notification);
      sent.push('pushover');
    }
    if (shouldUse('gotify') && notifierCfg.gotify && notifierCfg.gotify.serverUrl && notifierCfg.gotify.token) {
      sendGotifyNotification(notification);
      sent.push('gotify');
    }

    res.json({ ok: true, channels: sent });
  } catch (e) {
    console.error('[OmniStream] Failed to send test notification:', e.message);
    res.status(500).json({ error: 'Failed to send test notification' });
  }
});

// Simple API to read/update notifier configuration (Discord, email, rules) from config.json
app.get('/api/config/notifiers', (req, res) => {
  res.json({ notifiers: appConfig.notifiers || {} });
});

app.put('/api/config/notifiers', (req, res) => {
  try {
    const incoming = req.body && typeof req.body === 'object' ? req.body : {};
    const current = appConfig.notifiers || {};
    // Shallow merge notifier configs; caller can send only the fields they want to change
    appConfig.notifiers = { ...current, ...incoming };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(appConfig, null, 2));
    res.json({ notifiers: appConfig.notifiers });
  } catch (e) {
    console.error('[OmniStream] Failed to update notifier config:', e.message);
    res.status(500).json({ error: 'Failed to update notifier config' });
  }
});

// Read/update global application config (history retention, Overseerr, etc.) from config.json
app.get('/api/config/app', (req, res) => {
  try {
    const overseerrCfg = appConfig.overseerr || {};
    res.json({
      maxHistory: typeof MAX_HISTORY === 'number' ? MAX_HISTORY : DEFAULT_MAX_HISTORY,
      overseerr: {
        baseUrl: overseerrCfg.baseUrl || '',
        hasApiKey: !!overseerrCfg.apiKey
      },
      newsletterEmail: {
        enabled: appConfig.newsletterEmail?.enabled !== false,
        from: appConfig.newsletterEmail?.from || '',
        to: appConfig.newsletterEmail?.to || ''
      },
      newsletterTemplates: Array.isArray(appConfig.newsletterTemplates) ? appConfig.newsletterTemplates.map(t => ({
        id: t.id,
        name: t.name,
        subject: t.subject,
        body: t.body
      })) : []
    });
  } catch (e) {
    console.error('[OmniStream] Failed to read app config:', e.message);
    res.status(500).json({ error: 'Failed to read app config' });
  }
});

app.put('/api/config/app', (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};

    // maxHistory: number, or null to reset to default
    if (Object.prototype.hasOwnProperty.call(body, 'maxHistory')) {
      const v = body.maxHistory;
      if (typeof v === 'number' && Number.isFinite(v)) {
        appConfig.maxHistory = v;
        MAX_HISTORY = v;
      } else if (v === null) {
        delete appConfig.maxHistory;
        MAX_HISTORY = DEFAULT_MAX_HISTORY;
      }
    }

    // Overseerr config: baseUrl and apiKey (apiKey is write-only; never returned to client)
    if (body.overseerr && typeof body.overseerr === 'object') {
      const current = appConfig.overseerr || {};
      const incoming = body.overseerr;
      const next = { ...current };

      if (Object.prototype.hasOwnProperty.call(incoming, 'baseUrl')) {
        const b = incoming.baseUrl;
        next.baseUrl = typeof b === 'string' ? b.trim() : '';
      }
      // Only update apiKey when explicitly provided; empty string means "clear"
      if (Object.prototype.hasOwnProperty.call(incoming, 'apiKey')) {
        const k = incoming.apiKey;
        next.apiKey = typeof k === 'string' ? k.trim() : '';
      }

      appConfig.overseerr = next;
    }

    // Newsletter email config: separate from alert email notifier
    if (body.newsletterEmail && typeof body.newsletterEmail === 'object') {
      const currentNl = appConfig.newsletterEmail || {};
      const incomingNl = body.newsletterEmail;
      const nextNl = { ...currentNl };
      if (Object.prototype.hasOwnProperty.call(incomingNl, 'enabled')) {
        nextNl.enabled = incomingNl.enabled !== false;
      }
      if (Object.prototype.hasOwnProperty.call(incomingNl, 'from')) {
        nextNl.from = typeof incomingNl.from === 'string' ? incomingNl.from.trim() : '';
      }
      if (Object.prototype.hasOwnProperty.call(incomingNl, 'to')) {
        nextNl.to = typeof incomingNl.to === 'string' ? incomingNl.to.trim() : '';
      }
      if (Object.prototype.hasOwnProperty.call(incomingNl, 'smtp') && typeof incomingNl.smtp === 'object') {
        nextNl.smtp = incomingNl.smtp;
      }
      appConfig.newsletterEmail = nextNl;
    }

    // Newsletter templates (simple replace of array)
    if (Object.prototype.hasOwnProperty.call(body, 'newsletterTemplates')) {
      const raw = body.newsletterTemplates;
      if (Array.isArray(raw)) {
        appConfig.newsletterTemplates = raw.map((t, idx) => ({
          id: t.id != null ? String(t.id) : String(idx),
          name: typeof t.name === 'string' ? t.name : `Template ${idx + 1}`,
          subject: typeof t.subject === 'string' ? t.subject : '',
          body: typeof t.body === 'string' ? t.body : ''
        }));
      }
    }

    fs.writeFileSync(CONFIG_FILE, JSON.stringify(appConfig, null, 2));

    const overseerrCfg = appConfig.overseerr || {};
    res.json({
      maxHistory: typeof MAX_HISTORY === 'number' ? MAX_HISTORY : DEFAULT_MAX_HISTORY,
      overseerr: {
        baseUrl: overseerrCfg.baseUrl || '',
        hasApiKey: !!overseerrCfg.apiKey
      },
      newsletterEmail: {
        enabled: appConfig.newsletterEmail?.enabled !== false,
        from: appConfig.newsletterEmail?.from || '',
        to: appConfig.newsletterEmail?.to || ''
      },
      newsletterTemplates: Array.isArray(appConfig.newsletterTemplates) ? appConfig.newsletterTemplates.map(t => ({
        id: t.id,
        name: t.name,
        subject: t.subject,
        body: t.body
      })) : []
    });
  } catch (e) {
    console.error('[OmniStream] Failed to update app config:', e.message);
    res.status(500).json({ error: 'Failed to update app config' });
  }
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
