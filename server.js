// ...existing code...
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const crypto = require('crypto');
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
app.disable('x-powered-by');

// Basic hardening headers (avoid breaking the existing inline-script UI).
app.use((req, res, next) => {
  try {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  } catch (_) {
    // ignore
  }
  next();
});

// CORS is disabled by default. If you need cross-origin API access, set
// OMNISTREAM_CORS_ORIGINS="http://host1,http://host2" (comma-separated).
const corsAllowlistRaw = String(process.env.OMNISTREAM_CORS_ORIGINS || '').trim();
if (corsAllowlistRaw) {
  const allowedOrigins = corsAllowlistRaw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  app.use(cors({
    origin: (origin, cb) => {
      // Non-browser callers (curl, server-side) may not send Origin.
      if (!origin) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error('Not allowed by CORS'), false);
    }
  }));
}
// Allow modestly-sized JSON payloads (used for base64 logo uploads).
app.use(express.json({ limit: '15mb' }));

// Help avoid confusion from cached HTML and make it easy to confirm which build is serving a page.
app.use((req, res, next) => {
  try {
    res.setHeader('X-OmniStream-Version', appVersion || 'dev');
  } catch (_) {
    // ignore
  }

  // For HTML pages, be extra strict about caching to reduce "old UI" reports.
  const accept = String(req.headers.accept || '');
  const isHtmlRequest = accept.includes('text/html') || req.path === '/' || req.path.endsWith('.html');
  if (isHtmlRequest) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});


const SERVERS_FILE = path.join(__dirname, 'servers.json');
const CONFIG_FILE = path.join(__dirname, 'config.json');
const PKG_FILE = path.join(__dirname, 'package.json');

const DEFAULT_GITHUB_REPO = 'winky2000/omnistream';
const DEFAULT_GITHUB_URL = `https://github.com/${DEFAULT_GITHUB_REPO}`;
const DEFAULT_GITHUB_RELEASES_URL = `${DEFAULT_GITHUB_URL}/releases`;
const DEFAULT_GITHUB_LATEST_RELEASE_API = `https://api.github.com/repos/${DEFAULT_GITHUB_REPO}/releases/latest`;

const updateState = {
  lastCheckedAtMs: 0,
  latestVersion: null,
  updateAvailable: null,
  error: null
};

function parseSemver(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const s = raw.startsWith('v') || raw.startsWith('V') ? raw.slice(1) : raw;
  const m = s.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  if (![major, minor, patch].every(Number.isFinite)) return null;
  return [major, minor, patch];
}

function compareSemver(a, b) {
  if (!a || !b) return 0;
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return 1;
    if (a[i] < b[i]) return -1;
  }
  return 0;
}

async function checkForUpdatesOnGitHub() {
  const resp = await axios.get(DEFAULT_GITHUB_LATEST_RELEASE_API, {
    timeout: 8000,
    headers: {
      'User-Agent': `OmniStream/${appVersion || 'dev'}`,
      'Accept': 'application/vnd.github+json'
    }
  });
  const tag = resp && resp.data ? (resp.data.tag_name || resp.data.name || '') : '';
  return String(tag || '').trim();
}

async function maybeCheckForUpdates({ force } = {}) {
  const now = Date.now();
  const minIntervalMs = 6 * 60 * 60 * 1000; // 6 hours
  if (!force && updateState.lastCheckedAtMs && (now - updateState.lastCheckedAtMs) < minIntervalMs) {
    return;
  }

  // Random gate so we don't check predictably or too often.
  const probability = 0.35;
  if (!force && Math.random() > probability) {
    return;
  }

  try {
    const latestTag = await checkForUpdatesOnGitHub();
    const latestParsed = parseSemver(latestTag);
    const currentParsed = parseSemver(appVersion);
    updateState.latestVersion = latestParsed ? `v${latestParsed.join('.')}` : (latestTag || null);
    if (currentParsed && latestParsed) {
      updateState.updateAvailable = compareSemver(latestParsed, currentParsed) === 1;
    } else {
      updateState.updateAvailable = null;
    }
    updateState.error = null;
  } catch (e) {
    updateState.error = e && e.message ? String(e.message) : 'Update check failed';
  } finally {
    updateState.lastCheckedAtMs = now;
  }
}

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

// ---------------------------------------------------------------------------
// Internal authentication (optional, default enabled)
//
// Modes:
// - internal: OmniStream enforces login itself (session cookie)
// - nginx: OmniStream does NOT enforce internal auth (assume reverse proxy auth)
// ---------------------------------------------------------------------------

const AUTH_COOKIE_NAME = 'omnistream_session';
const AUTH_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const AUTH_PBKDF2_ITERS = 120000;
const AUTH_PBKDF2_KEYLEN = 32;
const AUTH_PBKDF2_DIGEST = 'sha256';

const authSessions = new Map(); // sid -> { username, createdAtMs, lastSeenAtMs }

function normalizeAuthMode(input) {
  const raw = String(input || '').trim().toLowerCase();
  if (raw === 'nginx') return 'nginx';
  return 'internal';
}

function getAuthConfig() {
  const cfg = (appConfig && typeof appConfig === 'object') ? appConfig : {};
  const auth = (cfg.auth && typeof cfg.auth === 'object') ? cfg.auth : {};
  return auth;
}

function getAuthMode() {
  return normalizeAuthMode(getAuthConfig().mode);
}

function internalAuthEnabled() {
  return getAuthMode() !== 'nginx';
}

function parseCookies(header) {
  const out = {};
  const raw = String(header || '').trim();
  if (!raw) return out;
  raw.split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (!k) return;
    out[k] = decodeURIComponent(v);
  });
  return out;
}

function pbkdf2HashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.pbkdf2Sync(
    Buffer.from(String(password || ''), 'utf8'),
    salt,
    AUTH_PBKDF2_ITERS,
    AUTH_PBKDF2_KEYLEN,
    AUTH_PBKDF2_DIGEST
  );
  return `pbkdf2$${AUTH_PBKDF2_DIGEST}$${AUTH_PBKDF2_ITERS}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

function pbkdf2VerifyPassword(password, stored) {
  try {
    const raw = String(stored || '').trim();
    const parts = raw.split('$');
    if (parts.length !== 5) return false;
    const [kind, digest, itersRaw, saltB64, hashB64] = parts;
    if (kind !== 'pbkdf2') return false;
    const iters = Number(itersRaw);
    if (!Number.isFinite(iters) || iters < 10000) return false;
    const salt = Buffer.from(String(saltB64 || ''), 'base64');
    const expected = Buffer.from(String(hashB64 || ''), 'base64');
    if (!salt.length || !expected.length) return false;
    const derived = crypto.pbkdf2Sync(
      Buffer.from(String(password || ''), 'utf8'),
      salt,
      iters,
      expected.length,
      String(digest || AUTH_PBKDF2_DIGEST)
    );
    if (derived.length !== expected.length) return false;
    return crypto.timingSafeEqual(derived, expected);
  } catch (_) {
    return false;
  }
}

function maybeResetInternalAuthFromEnv() {
  try {
    const raw = String(process.env.OMNISTREAM_RESET_INTERNAL_AUTH || '').trim().toLowerCase();
    if (!raw || (raw !== '1' && raw !== 'true' && raw !== 'yes')) return;

    if (!appConfig || typeof appConfig !== 'object') {
      appConfig = {};
    }
    if (!appConfig.auth || typeof appConfig.auth !== 'object') {
      appConfig.auth = {};
    }

    appConfig.auth.mode = 'internal';
    appConfig.auth.username = 'admin';
    appConfig.auth.passwordHash = pbkdf2HashPassword('omnistream');
    appConfig.auth.passwordChangeRequired = true;

    try {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(appConfig, null, 2));
      console.log('[OmniStream] Reset internal auth credentials (admin/omnistream) due to OMNISTREAM_RESET_INTERNAL_AUTH');
    } catch (e) {
      console.error('[OmniStream] Failed to persist auth reset:', e.message);
    }
  } catch (e) {
    console.error('[OmniStream] maybeResetInternalAuthFromEnv failed:', e.message);
  }
}

function ensureDefaultInternalAuthConfig() {
  try {
    if (!appConfig || typeof appConfig !== 'object') {
      appConfig = {};
    }
    if (!appConfig.auth || typeof appConfig.auth !== 'object') {
      appConfig.auth = {};
    }

    if (!appConfig.auth.mode) {
      appConfig.auth.mode = 'internal';
    }
    if (!appConfig.auth.username) {
      appConfig.auth.username = 'admin';
    }

    // Only seed a default password when one has never been set.
    if (!appConfig.auth.passwordHash) {
      appConfig.auth.passwordHash = pbkdf2HashPassword('omnistream');
      appConfig.auth.passwordChangeRequired = true;
      try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(appConfig, null, 2));
        console.log('[OmniStream] Seeded default internal auth credentials (admin/omnistream) into config.json');
      } catch (e) {
        console.error('[OmniStream] Failed to persist default auth config:', e.message);
      }
    }

    if (typeof appConfig.auth.passwordChangeRequired !== 'boolean') {
      appConfig.auth.passwordChangeRequired = false;
    }
  } catch (e) {
    console.error('[OmniStream] ensureDefaultInternalAuthConfig failed:', e.message);
  }
}

maybeResetInternalAuthFromEnv();
ensureDefaultInternalAuthConfig();

try {
  const raw = String(process.env.OMNISTREAM_AUTH_DEBUG || '').trim().toLowerCase();
  if (raw === '1' || raw === 'true' || raw === 'yes') {
    const authCfg = getAuthConfig();
    console.log('[OmniStream] Auth debug:', {
      mode: getAuthMode(),
      username: String(authCfg.username || 'admin'),
      hasPasswordHash: Boolean(authCfg.passwordHash),
      passwordChangeRequired: authCfg.passwordChangeRequired === true
    });
  }
} catch (_) {
  // ignore
}

function getSessionIdFromReq(req) {
  const cookies = parseCookies(req.headers.cookie);
  const sid = cookies[AUTH_COOKIE_NAME];
  return sid ? String(sid) : '';
}

function getSessionForReq(req) {
  const sid = getSessionIdFromReq(req);
  if (!sid) return null;
  const sess = authSessions.get(sid);
  if (!sess) return null;
  const now = Date.now();
  if (sess.lastSeenAtMs && (now - sess.lastSeenAtMs) > AUTH_SESSION_TTL_MS) {
    authSessions.delete(sid);
    return null;
  }
  sess.lastSeenAtMs = now;
  return { sid, ...sess };
}

function setSessionCookie(res, sid, { secure } = {}) {
  const parts = [
    `${AUTH_COOKIE_NAME}=${encodeURIComponent(String(sid))}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(AUTH_SESSION_TTL_MS / 1000)}`
  ];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res, { secure } = {}) {
  const parts = [
    `${AUTH_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0'
  ];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function shouldUseSecureCookie(req) {
  const xfProto = String(req.headers['x-forwarded-proto'] || '').toLowerCase();
  if (xfProto === 'https') return true;
  return Boolean(req.secure);
}

function isHtmlLikeRequest(req) {
  const accept = String(req.headers.accept || '');
  if (req.path === '/' || req.path.endsWith('.html')) return true;
  return accept.includes('text/html');
}

function isPublicAuthAssetPath(p) {
  // Keep this list intentionally tight: only what's required to render login pages.
  if (p === '/theme.css') return true;
  if (p === '/omnistream_logo.png') return true;
  return false;
}

// Auth gate: enforces internal login for ALL UI and API routes when mode=internal.
app.use((req, res, next) => {
  try {
    if (!internalAuthEnabled()) {
      return next();
    }

    const p = req.path;
    const isApi = p.startsWith('/api/');
    const isLoginPage = p === '/login.html';
    const isChangePwPage = p === '/change-password.html';
    const isAuthApi = p.startsWith('/api/auth/');

    // Allow static assets needed for login/change-password UI
    if (isPublicAuthAssetPath(p)) {
      return next();
    }

    // Login page is always accessible
    if (isLoginPage) {
      return next();
    }

    const sess = getSessionForReq(req);
    const authed = Boolean(sess && sess.username);

    if (!authed) {
      if (isApi) {
        // Allow calling auth endpoints without a session (login + me)
        if (isAuthApi) return next();
        return res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHENTICATED' });
      }
      // Non-API: redirect to login
      if (isHtmlLikeRequest(req)) {
        return res.redirect(302, '/login.html');
      }
      return res.status(401).send('Unauthorized');
    }

    // Force password change after first login
    const authCfg = getAuthConfig();
    const mustChange = authCfg && authCfg.passwordChangeRequired === true;
    if (mustChange) {
      if (isApi) {
        // Allow only auth endpoints while password change is required
        if (isAuthApi) return next();
        return res.status(403).json({ error: 'Password change required', code: 'PASSWORD_CHANGE_REQUIRED' });
      }
      // Allow change-password page, block everything else
      if (isChangePwPage) return next();
      return res.redirect(302, '/change-password.html');
    }

    return next();
  } catch (e) {
    console.error('[OmniStream] auth gate error:', e.message);
    return res.status(500).json({ error: 'Auth gate failed' });
  }
});

// Now that auth gate is installed, serve the static UI.
app.use(express.static('public'));

// Auth API
app.get('/api/auth/me', (req, res) => {
  try {
    const mode = getAuthMode();
    if (mode === 'nginx') {
      return res.json({ mode, internalAuthEnabled: false, authenticated: true, username: null, mustChangePassword: false });
    }

    const sess = getSessionForReq(req);
    const authCfg = getAuthConfig();
    return res.json({
      mode,
      internalAuthEnabled: true,
      authenticated: Boolean(sess && sess.username),
      username: sess && sess.username ? sess.username : null,
      mustChangePassword: authCfg && authCfg.passwordChangeRequired === true
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to get auth status' });
  }
});

app.post('/api/auth/login', (req, res) => {
  try {
    if (!internalAuthEnabled()) {
      return res.status(400).json({ error: 'Internal auth is disabled', code: 'INTERNAL_AUTH_DISABLED' });
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';

    const authCfg = getAuthConfig();
    const expectedUser = String(authCfg.username || 'admin');
    const storedHash = String(authCfg.passwordHash || '');
    if (!username || !password) {
      return res.status(400).json({ error: 'Missing username or password' });
    }
    if (username !== expectedUser) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    if (!storedHash || !pbkdf2VerifyPassword(password, storedHash)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const sid = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    authSessions.set(sid, { username: expectedUser, createdAtMs: now, lastSeenAtMs: now });
    setSessionCookie(res, sid, { secure: shouldUseSecureCookie(req) });
    return res.json({ ok: true, mustChangePassword: authCfg.passwordChangeRequired === true });
  } catch (e) {
    console.error('[OmniStream] login failed:', e.message);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  try {
    const sid = getSessionIdFromReq(req);
    if (sid) authSessions.delete(sid);
    clearSessionCookie(res, { secure: shouldUseSecureCookie(req) });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Logout failed' });
  }
});

app.post('/api/auth/change-password', (req, res) => {
  try {
    if (!internalAuthEnabled()) {
      return res.status(400).json({ error: 'Internal auth is disabled', code: 'INTERNAL_AUTH_DISABLED' });
    }

    const sess = getSessionForReq(req);
    if (!sess || !sess.username) {
      return res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHENTICATED' });
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
    const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Missing currentPassword or newPassword' });
    }
    if (String(newPassword).length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }

    const authCfg = getAuthConfig();
    const storedHash = String(authCfg.passwordHash || '');
    if (!storedHash || !pbkdf2VerifyPassword(currentPassword, storedHash)) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    if (!appConfig.auth || typeof appConfig.auth !== 'object') {
      appConfig.auth = {};
    }
    appConfig.auth.passwordHash = pbkdf2HashPassword(newPassword);
    appConfig.auth.passwordChangeRequired = false;
    appConfig.auth.username = String(appConfig.auth.username || 'admin');
    appConfig.auth.mode = normalizeAuthMode(appConfig.auth.mode);

    // Persist
    try {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(appConfig, null, 2));
    } catch (e) {
      console.error('[OmniStream] Failed to persist password change:', e.message);
      return res.status(500).json({ error: 'Failed to persist new password' });
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('[OmniStream] change-password failed:', e.message);
    res.status(500).json({ error: 'Change password failed' });
  }
});

// Convenience: allow manual logout via browser navigation.
app.get('/logout', (req, res) => {
  try {
    const sid = getSessionIdFromReq(req);
    if (sid) authSessions.delete(sid);
    clearSessionCookie(res, { secure: shouldUseSecureCookie(req) });
    const mode = appConfig && appConfig.auth ? normalizeAuthMode(appConfig.auth.mode) : 'internal';
    res.redirect(302, mode === 'nginx' ? '/' : '/login.html');
  } catch (e) {
    res.redirect(302, '/login.html');
  }
});

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
if (!appConfig.newsletterCustomSections) {
  appConfig.newsletterCustomSections = [];
}
if (!appConfig.newsletterBranding) {
  appConfig.newsletterBranding = { logoUrl: '' };
}
if (typeof appConfig.newsletterBranding.logoUrl !== 'string') {
  appConfig.newsletterBranding.logoUrl = '';
}
if (!appConfig.newsletterSchedule) {
  appConfig.newsletterSchedule = {
    enabled: false,
    templateId: 'tpl-default-recently-added',
    dayOfWeek: 0,
    time: '09:00',
    lastSentDate: ''
  };
}

function saveAppConfigToDisk() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(appConfig, null, 2));
    return true;
  } catch (e) {
    console.error('[OmniStream] Failed to write config.json:', e.message);
    return false;
  }
}

const DEFAULT_NEWSLETTER_TEMPLATE_ID = 'tpl-default-recently-added';
const DEFAULT_NEWSLETTER_TEMPLATE_FILE = path.join(__dirname, 'newsletter_templates', 'recently_added_default.html');
const SENT_NEWSLETTERS_DIR = path.join(__dirname, 'sent_newsletters');

function readDefaultNewsletterTemplateBody() {
  try {
    if (fs.existsSync(DEFAULT_NEWSLETTER_TEMPLATE_FILE)) {
      const stat = fs.statSync(DEFAULT_NEWSLETTER_TEMPLATE_FILE);
      if (stat && stat.isFile()) {
        return fs.readFileSync(DEFAULT_NEWSLETTER_TEMPLATE_FILE, 'utf8') || '';
      }
    }
  } catch (e) {
    console.error('[OmniStream] Failed to read default newsletter template:', e.message);
  }
  return '';
}

function ensureDefaultNewsletterTemplate() {
  try {
    if (!Array.isArray(appConfig.newsletterTemplates)) {
      appConfig.newsletterTemplates = [];
    }

    const bodyFromDisk = readDefaultNewsletterTemplateBody();

    // If there are no templates at all, seed the default.
    if (!appConfig.newsletterTemplates.length) {
      appConfig.newsletterTemplates = [
        {
          id: DEFAULT_NEWSLETTER_TEMPLATE_ID,
          name: 'Recently Added (default)',
          subject: 'Recently Added: {{START_DATE}} - {{END_DATE}}',
          body: bodyFromDisk || 'Recently added this week:\n\n{{RECENTLY_ADDED}}'
        }
      ];

      // Persist so it survives restarts.
      try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(appConfig, null, 2));
        console.log('[OmniStream] Seeded default newsletter template into config.json');
      } catch (e) {
        console.error('[OmniStream] Failed to persist default newsletter template:', e.message);
      }
      return;
    }

    // If the default template already exists, only auto-refresh it when it
    // still looks like an unmodified older built-in version.
    if (bodyFromDisk) {
      const idx = appConfig.newsletterTemplates.findIndex(t => t && String(t.id) === DEFAULT_NEWSLETTER_TEMPLATE_ID);
      if (idx !== -1) {
        const existing = appConfig.newsletterTemplates[idx] || {};
        const existingBody = String(existing.body || '');
        const looksLikeOldBright = existingBody.includes('background-color: #F1E5AC');
        const looksLikeOldHardcodedLogo = /winkys\.com\/img\/wpe\.(jpg|jpeg|png)/i.test(existingBody)
          && !/\{\{\s*NEWSLETTER_LOGO_BLOCK\s*\}\}/i.test(existingBody);
        const looksLikeHardcodedSection = /<figure\s+class="table"/i.test(existingBody)
          && /Useful\s+Links/i.test(existingBody)
          && /Donate\s+to\s+my\s+hard\s+drive\s+fund/i.test(existingBody)
          && !/\{\{\s*CUSTOM_SECTIONS\s*\}\}/i.test(existingBody);

        if (looksLikeOldBright || looksLikeOldHardcodedLogo || looksLikeHardcodedSection) {
          appConfig.newsletterTemplates[idx] = {
            ...existing,
            body: bodyFromDisk
          };
          try {
            fs.writeFileSync(CONFIG_FILE, JSON.stringify(appConfig, null, 2));
            console.log('[OmniStream] Refreshed default newsletter template body from disk');
          } catch (e) {
            console.error('[OmniStream] Failed to persist refreshed default newsletter template:', e.message);
          }
        }
      }
    }
  } catch (e) {
    console.error('[OmniStream] ensureDefaultNewsletterTemplate failed:', e.message);
  }
}

function normalizeNewsletterLogoUrl(input) {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) return '';
  // Allow serving uploaded logo from our own static path.
  if (raw.startsWith('/uploads/')) return raw;
  // Allow only http(s) absolute URLs.
  try {
    const u = new URL(raw);
    if (u.protocol === 'http:' || u.protocol === 'https:') return raw;
  } catch (_) {
    // ignore
  }
  return '';
}

function escapeHtml(input) {
  return String(input || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatIsoDateShort(d) {
  try {
    return new Date(d).toISOString().slice(0, 10);
  } catch (_) {
    return '';
  }
}

function computeDefaultDateRange() {
  const end = new Date();
  const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
  return {
    startDate: formatIsoDateShort(start),
    endDate: formatIsoDateShort(end)
  };
}

function applyBasicNewsletterReplacements(text, replacements) {
  let out = String(text || '');
  const pairs = Object.entries(replacements || {});
  for (const [key, value] of pairs) {
    const token = String(key);
    out = out.split(token).join(String(value));
  }
  return out;
}

function linkifyAndPreserveLines(text) {
  // Escape HTML, then turn bare URLs into links, then preserve newlines.
  const escaped = escapeHtml(text || '');
  const withLinks = escaped.replace(/\bhttps?:\/\/[^\s<]+/gi, (m) => {
    return `<a href="${m}" target="_blank" rel="noopener noreferrer" style="color:#E5A00D;text-decoration:none;">${m}</a>`;
  });
  return withLinks.replace(/\r\n|\r|\n/g, '<br>');
}

function normalizeCustomHeaderSize(input) {
  const s = String(input || '').trim().toLowerCase();
  if (s === 'sm' || s === 'small') return 'sm';
  if (s === 'lg' || s === 'large') return 'lg';
  return 'md';
}

function normalizeHexColor(input) {
  const s = String(input || '').trim();
  if (!s) return '';
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(s)) return s.toLowerCase();
  return '';
}

function normalizeCustomHeaderColumn(input) {
  if (typeof input === 'string') {
    return { type: 'text', value: input };
  }
  if (input && typeof input === 'object') {
    const rawType = String(input.type || input.kind || 'text').trim().toLowerCase();
    const type = rawType === 'url' ? 'url' : 'text';
    const value = typeof input.value === 'string' ? input.value : '';
    return { type, value };
  }
  return { type: 'text', value: '' };
}

function safeLinkHref(input) {
  const s = String(input || '').trim();
  if (!s) return '';
  const lower = s.toLowerCase();
  if (lower.startsWith('http://') || lower.startsWith('https://') || lower.startsWith('mailto:')) {
    return s;
  }
  return '';
}

function renderUrlColumnHtml(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';

  const lines = text.split(/\r\n|\r|\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return '';

  const parts = [];
  for (const line of lines) {
    const href = safeLinkHref(line);
    if (href) {
      const escapedHref = escapeHtml(href);
      const escapedLabel = escapeHtml(line);
      parts.push(`<a href="${escapedHref}" target="_blank" rel="noopener noreferrer" style="color:#E5A00D;text-decoration:none;">${escapedLabel}</a>`);
    } else {
      parts.push(escapeHtml(line));
    }
  }
  return parts.join('<br>');
}

function buildCustomSectionsBlocks(sections) {
  const list = Array.isArray(sections) ? sections : [];
  const cleaned = list
    .map((s) => {
      const header = s && typeof s.header === 'string' ? s.header.trim() : '';
      const headerSize = normalizeCustomHeaderSize(s && s.headerSize);
      const headerColor = normalizeHexColor(s && s.headerColor);

      let columnCount = parseInt((s && s.columnCount != null) ? s.columnCount : 3, 10);
      if (![1, 2, 3].includes(columnCount)) columnCount = 3;

      const cols = s && Array.isArray(s.columns) ? s.columns : [];
      const c1 = normalizeCustomHeaderColumn(cols[0]);
      const c2 = normalizeCustomHeaderColumn(cols[1]);
      const c3 = normalizeCustomHeaderColumn(cols[2]);
      const v1 = (c1 && typeof c1.value === 'string') ? c1.value.trim() : '';
      const v2 = (c2 && typeof c2.value === 'string') ? c2.value.trim() : '';
      const v3 = (c3 && typeof c3.value === 'string') ? c3.value.trim() : '';
      const activeVals = columnCount === 1 ? [v1] : (columnCount === 2 ? [v1, v2] : [v1, v2, v3]);
      const hasAny = !!(header || activeVals.some(Boolean));
      return hasAny ? { header, headerSize, headerColor, columnCount, columns: [c1, c2, c3] } : null;
    })
    .filter(Boolean);

  if (!cleaned.length) return { text: '', html: '' };

  const textParts = [];
  const htmlParts = [];

  cleaned.forEach((sec) => {
    const header = sec.header || '';
    const headerSize = normalizeCustomHeaderSize(sec.headerSize);
    const headerColor = normalizeHexColor(sec.headerColor) || '#e5e7eb';
    const sizePx = headerSize === 'sm' ? 18 : (headerSize === 'lg' ? 26 : 22);

    let columnCount = parseInt(sec.columnCount != null ? sec.columnCount : 3, 10);
    if (![1, 2, 3].includes(columnCount)) columnCount = 3;

    const [col1, col2, col3] = sec.columns;
    const c1 = col1 && typeof col1.value === 'string' ? col1.value.trim() : '';
    const c2 = col2 && typeof col2.value === 'string' ? col2.value.trim() : '';
    const c3 = col3 && typeof col3.value === 'string' ? col3.value.trim() : '';
    const hasAnyColumnData = columnCount === 1 ? Boolean(c1) : (columnCount === 2 ? Boolean(c1 || c2) : Boolean(c1 || c2 || c3));

    if (header) {
      textParts.push(header);
      textParts.push('-'.repeat(Math.min(40, Math.max(6, header.length))));
    }
    if (hasAnyColumnData) {
      const linesFor = (col) => {
        const normalized = normalizeCustomHeaderColumn(col);
        const raw = typeof normalized.value === 'string' ? normalized.value.trim() : '';
        if (!raw) return [];
        if (normalized.type === 'url') {
          return raw.split(/\r\n|\r|\n/).map(l => l.trim()).filter(Boolean);
        }
        return raw.split(/\r\n|\r|\n/).filter(Boolean);
      };

      const activeCols = columnCount === 1 ? [col1] : (columnCount === 2 ? [col1, col2] : [col1, col2, col3]);
      const lines = activeCols.map(linesFor);
      const max = Math.max(0, ...lines.map(a => a.length));
      for (let i = 0; i < max; i++) {
        const row = lines.map(arr => arr[i] || '').filter(Boolean).join(' | ');
        if (row) textParts.push(row);
      }
    }
    textParts.push('');

    const renderColumnCell = (rawCol, rawValue, widthPct, isFirst) => {
      const normalized = normalizeCustomHeaderColumn(rawCol);
      const content = normalized.type === 'url' ? renderUrlColumnHtml(rawValue) : linkifyAndPreserveLines(rawValue);
      const borderLeft = isFirst ? '' : 'border-left:1px solid rgba(148,163,184,0.18);';
      return `<td width="${widthPct}%" valign="top" style="padding:12px 10px;background:#0b1226;color:#e5e7eb;font-size:13px;line-height:1.5;${borderLeft}" class="dark-mode-card">${content}</td>`;
    };

    const htmlColumns = (() => {
      if (!hasAnyColumnData) return '';
      if (columnCount === 1) {
        return renderColumnCell(col1, c1, 100, true);
      }
      if (columnCount === 2) {
        return renderColumnCell(col1, c1, 50, true) + renderColumnCell(col2, c2, 50, false);
      }
      return renderColumnCell(col1, c1, 33, true) + renderColumnCell(col2, c2, 33, false) + renderColumnCell(col3, c3, 34, false);
    })();

    htmlParts.push(
      `<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width:600px;margin:0 auto;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">` +
      `<tr><td style="padding: 10px 20px ${hasAnyColumnData ? '0' : '18px'} 20px;">` +
      `<div style="border-top: 2px solid #E5A00D; margin: 10px 0 14px 0;" class="dark-mode-border"></div>` +
      (header
        ? `<div style="margin:0 0 10px 0;font-weight:700;font-size:${sizePx}px;letter-spacing:0.3px;color:${escapeHtml(headerColor)};text-align:center;" class="dark-mode-text">${escapeHtml(header)}</div>`
        : '') +
      `</td></tr>` +
      (hasAnyColumnData
        ? (`<tr>` +
          `<td style="padding: 0 20px 18px 20px;">` +
          `<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="border-radius:10px;overflow:hidden;border:1px solid rgba(148,163,184,0.25);">` +
          `<tr>` +
          htmlColumns +
          `</tr>` +
          `</table>` +
          `</td>` +
          `</tr>`)
        : '') +
      `</table>`
    );
  });

  return {
    text: textParts.join('\n').trim(),
    html: htmlParts.join('')
  };
}

function stripHtmlToText(html) {
  // Very lightweight fallback; avoids pulling in extra dependencies.
  return String(html || '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*\/p\s*>/gi, '\n\n')
    .replace(/<\s*p\b[^>]*>/gi, '')
    .replace(/<\s*li\b[^>]*>/gi, '- ')
    .replace(/<\s*\/li\s*>/gi, '\n')
    .replace(/<\s*\/ul\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function safeFilename(input) {
  const s = String(input || '').trim();
  const cleaned = s
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .slice(0, 120)
    .trim();
  return cleaned || 'newsletter';
}

function formatTimestampForFilename(date) {
  const d = date instanceof Date ? date : new Date();
  const yyyy = String(d.getFullYear());
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
}

function saveSentNewsletterToDisk(rendered) {
  try {
    const ts = formatTimestampForFilename(new Date());
    const subject = rendered && rendered.subject ? String(rendered.subject) : 'newsletter';
    const base = `${ts}_${safeFilename(subject)}`;
    fs.mkdirSync(SENT_NEWSLETTERS_DIR, { recursive: true });
    const files = [];

    const meta = {
      savedAt: new Date().toISOString(),
      subject: rendered && rendered.subject ? rendered.subject : '',
      hasHtml: !!(rendered && rendered.html),
      placeholders: {
        startDate: (rendered && rendered._startDate) || null,
        endDate: (rendered && rendered._endDate) || null
      }
    };

    const metaPath = path.join(SENT_NEWSLETTERS_DIR, base + '.json');
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
    files.push(metaPath);

    const textPath = path.join(SENT_NEWSLETTERS_DIR, base + '.txt');
    fs.writeFileSync(textPath, String((rendered && rendered.text) || ''), 'utf8');
    files.push(textPath);

    if (rendered && rendered.html) {
      const htmlPath = path.join(SENT_NEWSLETTERS_DIR, base + '.html');
      fs.writeFileSync(htmlPath, String(rendered.html), 'utf8');
      files.push(htmlPath);
    }

    return files;
  } catch (e) {
    console.error('[OmniStream] Failed to save sent newsletter:', e.message);
    return [];
  }
}

function normalizeDateInput(input) {
  const s = String(input || '').trim();
  if (!s) return '';
  // Accept YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return '';
  return formatIsoDateShort(new Date(t));
}

function buildPublicBaseUrl(req) {
  try {
    const cfg = appConfig || {};
    const configured = String(cfg.publicBaseUrl || cfg.httpBaseUrl || '').trim();
    if (configured) return configured.replace(/\/$/, '');
  } catch (_) {
    // ignore
  }
  try {
    const proto = (req && req.headers && req.headers['x-forwarded-proto']) ? String(req.headers['x-forwarded-proto']).split(',')[0].trim() : (req && req.protocol ? req.protocol : 'http');
    const host = req && typeof req.get === 'function' ? req.get('host') : '';
    if (host) return `${proto}://${host}`;
  } catch (_) {
    // ignore
  }
  return '';
}

function normalizePublicBaseUrl(input) {
  const s = String(input || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) return '';
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return s.replace(/\/$/, '');
  } catch (_) {
    return '';
  }
}

function normalizeDayOfWeek(input) {
  const n = Number(input);
  if (!Number.isFinite(n)) return 0;
  const i = Math.floor(n);
  if (i < 0 || i > 6) return 0;
  return i;
}

function normalizeTimeHHMM(input) {
  const s = String(input || '').trim();
  const m = s.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!m) return '';
  const hh = String(m[1]).padStart(2, '0');
  const mm = String(m[2]).padStart(2, '0');
  return `${hh}:${mm}`;
}

async function sendNewsletterBroadcast({ subject, body, startDate, endDate, publicBaseUrl, serverId } = {}) {
  if (!historyDb) {
    throw new Error('history DB not available');
  }
  if (!nodemailer) {
    throw new Error('Email sending not available (nodemailer not installed).');
  }
  const emailCfg = appConfig?.newsletterEmail;
  if (!emailCfg || emailCfg.enabled === false) {
    throw new Error('Newsletter email is not configured or disabled.');
  }
  const subj = String(subject || '').trim();
  const rawBody = String(body || '').trim();
  if (!subj || !rawBody) {
    throw new Error('subject and body are required');
  }

  const scopeServerId = serverId != null ? String(serverId).trim() : '';

  const rendered = await renderNewsletterSubjectAndBody(subj, rawBody, fetchUnifiedRecentlyAdded, {
    startDate,
    endDate,
    publicBaseUrl: String(publicBaseUrl || '').trim(),
    serverId: scopeServerId
  });

  const rows = await new Promise((resolve, reject) => {
    const where = ['active = 1', 'email IS NOT NULL'];
    const params = [];

    if (scopeServerId) {
      // serverTags stored as a JSON array string (e.g. ["plex-1","jelly-1"]).
      // Use a quoted LIKE match to reduce substring collisions.
      where.push('serverTags IS NOT NULL');
      where.push('serverTags LIKE ?');
      params.push(`%"${scopeServerId.replace(/"/g, '')}"%`);
    }

    historyDb.all(
      `SELECT DISTINCT email, name FROM newsletter_subscribers WHERE ${where.join(' AND ')}`,
      params,
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
    return { sent: 0, saved: [] };
  }

  const transport = nodemailer.createTransport(emailCfg.smtp || {});
  const mailOptions = {
    from: emailCfg.from,
    to: emailCfg.to || emailCfg.from,
    bcc: uniqueEmails,
    subject: rendered.subject || subj,
    text: rendered.text || rawBody
  };
  if (rendered.html) {
    mailOptions.html = rendered.html;
  }

  await transport.sendMail(mailOptions);
  const savedFiles = saveSentNewsletterToDisk(rendered);
  return { sent: uniqueEmails.length, saved: savedFiles.length ? savedFiles.map(p => path.basename(p)) : [] };
}

async function runNewsletterScheduleIfDue() {
  try {
    const templates = Array.isArray(appConfig.newsletterTemplates) ? appConfig.newsletterTemplates : [];
    const schedules = Array.isArray(appConfig.newsletterSchedules) && appConfig.newsletterSchedules.length
      ? appConfig.newsletterSchedules
      : (appConfig && appConfig.newsletterSchedule ? [appConfig.newsletterSchedule] : []);

    if (!schedules.length) return;

    const now = new Date();
    const today = formatIsoDateShort(now);
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const baseUrl = String(appConfig.publicBaseUrl || appConfig.httpBaseUrl || '').trim();
    const windowMins = 10;

    for (const sched of schedules) {
      if (!sched || sched.enabled !== true) continue;

      const dayOfWeek = normalizeDayOfWeek(sched.dayOfWeek);
      const time = normalizeTimeHHMM(sched.time);
      const templateId = sched.templateId != null ? String(sched.templateId) : '';
      if (!time || !templateId) continue;
      if (now.getDay() !== dayOfWeek) continue;

      if (sched.lastSentDate && String(sched.lastSentDate) === today) continue;

      const parts = time.split(':');
      const schedMin = Number(parts[0]) * 60 + Number(parts[1]);
      if (nowMin < schedMin || nowMin >= (schedMin + windowMins)) continue;

      const tpl = templates.find(t => t && String(t.id) === templateId);
      if (!tpl) {
        console.warn('[OmniStream] Newsletter schedule: template not found:', templateId);
        continue;
      }

      const scopeServerId = (Array.isArray(appConfig.newsletterSchedules) ? (sched.serverId != null ? String(sched.serverId).trim() : '') : '');
      if (scopeServerId) {
        const server = servers.find(s => s && String(s.id) === scopeServerId);
        if (!server) {
          console.warn('[OmniStream] Newsletter schedule: invalid serverId:', scopeServerId);
          continue;
        }
      }

      const result = await sendNewsletterBroadcast({
        subject: tpl.subject || '',
        body: tpl.body || '',
        publicBaseUrl: baseUrl,
        serverId: scopeServerId
      });

      if (result && typeof result.sent === 'number' && result.sent > 0) {
        sched.lastSentDate = today;
        saveAppConfigToDisk();
        console.log(`[OmniStream] Newsletter schedule sent to ${result.sent} subscriber(s) using template ${templateId}${scopeServerId ? ` (server ${scopeServerId})` : ''} (${today} ${time}).`);
      } else {
        console.log(`[OmniStream] Newsletter schedule due, but no active subscribers were emailed (template ${templateId}${scopeServerId ? `, server ${scopeServerId}` : ''}).`);
      }
    }
  } catch (e) {
    console.error('[OmniStream] Newsletter schedule failed:', e.message);
    recordNotifierError('newsletter-schedule', e.message);
  }
}

function buildRecentlyAddedBlocks(items, { publicBaseUrl } = {}) {
  const options = arguments.length > 1 && arguments[1] && typeof arguments[1] === 'object' ? arguments[1] : {};
  const rowsAll = Array.isArray(items) ? items : [];
  const startDate = typeof options.startDate === 'string' ? options.startDate.trim() : '';
  const endDate = typeof options.endDate === 'string' ? options.endDate.trim() : '';
  const displayLimit = Number.isFinite(Number(options.displayLimit)) ? Number(options.displayLimit) : 20;
  const scopeServerName = typeof options.scopeServerName === 'string' ? options.scopeServerName.trim() : '';

  const parseRangeMs = () => {
    const startMs = startDate ? Date.parse(`${startDate}T00:00:00.000Z`) : NaN;
    const endMs = endDate ? Date.parse(`${endDate}T23:59:59.999Z`) : NaN;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
    return { startMs, endMs };
  };

  const range = parseRangeMs();
  const rows = range
    ? rowsAll.filter(r => {
      if (!r || !r.addedAt) return false;
      const t = Date.parse(r.addedAt);
      if (!Number.isFinite(t)) return false;
      return t >= range.startMs && t <= range.endMs;
    })
    : rowsAll;

  const sortByAddedAtDesc = (a, b) => {
    const ta = a && a.addedAt ? (Date.parse(a.addedAt) || 0) : 0;
    const tb = b && b.addedAt ? (Date.parse(b.addedAt) || 0) : 0;
    return tb - ta;
  };

  // Totals are computed across the full (optionally date-filtered) result set.
  const totalMovies = rows.filter(r => r && r.type === 'movie').length;
  const totalEpisodes = rows.filter(r => r && r.type === 'episode').length;

  const tvRows = rows.filter(r => r && (r.type === 'episode' || r.type === 'season' || r.type === 'show'));
  const showKeyFor = (r) => {
    if (!r) return '';
    if (r.showTitle) return String(r.showTitle).trim();
    // Fallback: try to infer from the formatted title "Show - S01E01 - Episode".
    const t = String(r.title || '').trim();
    const idx = t.indexOf(' - ');
    if (idx > 0) return t.slice(0, idx).trim();
    return '';
  };

  const showSet = new Set();
  const seasonSet = new Set();
  for (const r of tvRows) {
    const show = showKeyFor(r);
    if (show) showSet.add(show);

    const seasonNum = (r && typeof r.seasonNumber === 'number' && Number.isFinite(r.seasonNumber)) ? r.seasonNumber : null;
    const seasonTitle = r && r.seasonTitle ? String(r.seasonTitle).trim() : '';
    if (show) {
      if (seasonNum !== null) {
        seasonSet.add(`${show}::${seasonNum}`);
      } else if (seasonTitle) {
        seasonSet.add(`${show}::${seasonTitle}`);
      }
    }
  }

  const totalShows = showSet.size;
  const totalSeasons = seasonSet.size;

  // Display lists are limited so emails don't explode in size.
  // Apply the limit *per section* (movies vs TV) so one type doesn't crowd out the other.
  const safeLimit = Math.max(0, displayLimit);
  const movies = rows
    .filter(r => r && r.type === 'movie')
    .sort(sortByAddedAtDesc)
    .slice(0, safeLimit);
  const episodes = rows
    .filter(r => r && r.type === 'episode')
    .sort(sortByAddedAtDesc)
    .slice(0, safeLimit);

  const moviesTitleBase = scopeServerName ? `Recently Added on ${scopeServerName} - Movies` : 'Recently Added Movies';
  const tvTitleBase = scopeServerName ? `Recently Added on ${scopeServerName} - TV` : 'Recently Added TV';
  const moviesTitle = totalMovies > movies.length
    ? `${moviesTitleBase} (${totalMovies}, showing ${movies.length})`
    : `${moviesTitleBase} (${totalMovies})`;
  const tvTitle = totalEpisodes > episodes.length
    ? `${tvTitleBase} (${totalShows} shows · ${totalSeasons} seasons, showing ${episodes.length})`
    : `${tvTitleBase} (${totalShows} shows · ${totalSeasons} seasons)`;

  const formatLine = (it) => {
    let line = it.title || '';
    if (it.year) line += ` (${it.year})`;
    if (!scopeServerName && it.serverName) line += ` · ${it.serverName}`;
    return line;
  };

  const textParts = [];
  if (movies.length) {
    textParts.push(totalMovies > movies.length ? `Movies (${totalMovies}, showing ${movies.length})` : `Movies (${totalMovies})`);
    movies.forEach(m => textParts.push('- ' + formatLine(m)));
    textParts.push('');
  }
  if (episodes.length) {
    textParts.push(
      totalEpisodes > episodes.length
        ? `TV (${totalShows} shows · ${totalSeasons} seasons, showing ${episodes.length})`
        : `TV (${totalShows} shows · ${totalSeasons} seasons)`
    );
    episodes.forEach(e => textParts.push('- ' + formatLine(e)));
    textParts.push('');
  }
  if (!movies.length && !episodes.length) {
    textParts.push('No recently added items found.');
  }

  const thumbUrlFor = (it) => {
    const base = String(publicBaseUrl || '').replace(/\/$/, '');
    if (!base) return '';
    if (it && it.thumbProxyPath) {
      const rel = String(it.thumbProxyPath);
      if (!rel) return '';
      if (rel.startsWith('http://') || rel.startsWith('https://')) return rel;
      return base + (rel.startsWith('/') ? rel : '/' + rel);
    }
    if (!it || !it.serverId || !it.thumb) return '';
    return `${base}/api/newsletter/plex/thumb?serverId=${encodeURIComponent(String(it.serverId))}&thumb=${encodeURIComponent(String(it.thumb))}`;
  };

  const metaPartsFor = (it) => {
    const parts = [];
    if (it.year) parts.push(String(it.year));
    if (typeof it.durationMinutes === 'number' && Number.isFinite(it.durationMinutes) && it.durationMinutes > 0) {
      parts.push(`${Math.round(it.durationMinutes)} mins`);
    }
    if (!scopeServerName && it.serverName) parts.push(String(it.serverName));
    return parts.join(' · ');
  };

  const genresFor = (it) => {
    if (!it || !Array.isArray(it.genres) || !it.genres.length) return '';
    return it.genres.slice(0, 3).join(' · ');
  };

  const cardHtml = (it) => {
    const thumbUrl = thumbUrlFor(it);
    const meta = metaPartsFor(it);
    const genres = genresFor(it);
    const summary = it && it.summary ? String(it.summary) : '';
    const img = thumbUrl
      ? `<img src="${escapeHtml(thumbUrl)}" width="100" height="150" alt="" style="display:block;width:100px;height:150px;border-radius:4px;object-fit:cover;background:#3F4245;" />`
      : `<div style="width:100px;height:150px;border-radius:4px;background:#3F4245;"></div>`;

    return (
      `<div style="background:#0b1226;border-radius:8px;padding:15px;box-shadow:0 2px 4px rgba(0,0,0,0.25);margin:10px 0;" class="dark-mode-card">` +
        `<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">` +
          `<tr>` +
            `<td style="vertical-align:top;width:110px;padding-right:12px;">${img}</td>` +
            `<td style="vertical-align:top;">` +
              `<div style="font-size:18px;line-height:1.2;font-weight:700;color:#e5e7eb;text-align:left;" class="dark-mode-text">${escapeHtml(it.title || '')}</div>` +
              (meta ? `<div style="margin:6px 0 0 0;font-size:14px;color:#94a3b8;" class="dark-mode-muted">${escapeHtml(meta)}</div>` : '') +
              (genres ? `<div style="margin:6px 0 0 0;font-size:14px;color:#94a3b8;" class="dark-mode-muted">${escapeHtml(genres)}</div>` : '') +
              (summary ? `<div style="margin:10px 0 0 0;font-size:14px;color:#94a3b8;" class="dark-mode-muted">${escapeHtml(summary)}</div>` : '') +
            `</td>` +
          `</tr>` +
        `</table>` +
      `</div>`
    );
  };

  const htmlParts = [];
  const section = (title, arr) => {
    if (!arr.length) return;
    htmlParts.push(`<div style="margin: 18px 0 10px 0; font-weight: 600; font-size: 16px; color:#e5e7eb;" class="dark-mode-text">${escapeHtml(title)}</div>`);
    arr.forEach(it => {
      htmlParts.push(cardHtml(it));
    });
  };
  section(moviesTitle, movies);
  section(tvTitle, episodes);
  if (!movies.length && !episodes.length) {
    htmlParts.push('<div style="color:#94a3b8;" class="dark-mode-muted">No recently added items found.</div>');
  }

  return {
    text: textParts.join('\n').trim(),
    html: htmlParts.join(''),
    stats: {
      movies: totalMovies,
      shows: totalShows,
      seasons: totalSeasons
    }
  };
}

async function renderNewsletterSubjectAndBody(subject, body, fetchRecentlyAdded, options = {}) {
  const requestedStart = normalizeDateInput(options.startDate);
  const requestedEnd = normalizeDateInput(options.endDate);
  const fallback = computeDefaultDateRange();
  const startDate = requestedStart || fallback.startDate;
  const endDate = requestedEnd || fallback.endDate;
  const publicBaseUrl = String(options.publicBaseUrl || '').trim();

  const scopeServerId = options.serverId != null ? String(options.serverId).trim() : '';
  const scopeServer = scopeServerId ? servers.find(s => String(s.id) === scopeServerId) : null;
  const scopeServerName = scopeServer
    ? String(scopeServer.name || scopeServer.baseUrl || scopeServerId)
    : (scopeServerId ? scopeServerId : 'OmniStream');

  const rawLogoUrl = normalizeNewsletterLogoUrl(
    (appConfig && appConfig.newsletterBranding && typeof appConfig.newsletterBranding.logoUrl === 'string')
      ? String(appConfig.newsletterBranding.logoUrl)
      : ''
  );

  const logoUrlForEmail = (() => {
    if (!rawLogoUrl) return '';
    if (rawLogoUrl.startsWith('/') && publicBaseUrl) {
      return publicBaseUrl.replace(/\/$/, '') + rawLogoUrl;
    }
    return rawLogoUrl;
  })();

  function autoInsertCustomSectionsTokenIntoHtml(html) {
    try {
      const token = '{{CUSTOM_SECTIONS}}';
      if (!html) return html;
      if (/\{\{\s*CUSTOM_SECTIONS\s*\}\}/i.test(html)) return html;

      // Heuristic: put custom sections just below the header/logo area.
      // For most email templates the first table is the header wrapper.
      const lower = html.toLowerCase();
      let insertAt = -1;

      const imgIdx = lower.indexOf('<img');
      if (imgIdx !== -1) {
        const tableCloseAfterImg = lower.indexOf('</table>', imgIdx);
        if (tableCloseAfterImg !== -1) {
          insertAt = tableCloseAfterImg + '</table>'.length;
        }
      }

      if (insertAt === -1) {
        const firstTableClose = lower.indexOf('</table>');
        if (firstTableClose !== -1) {
          insertAt = firstTableClose + '</table>'.length;
        }
      }

      if (insertAt === -1) {
        const bodyOpen = html.match(/<body\b[^>]*>/i);
        if (bodyOpen && typeof bodyOpen.index === 'number') {
          insertAt = bodyOpen.index + bodyOpen[0].length;
        }
      }

      if (insertAt === -1) {
        insertAt = 0;
      }

      return html.slice(0, insertAt) + `\n\n${token}\n\n` + html.slice(insertAt);
    } catch (e) {
      // If anything goes wrong, fall back to leaving the template untouched.
      return html;
    }
  }

  const customSectionsBlocks = buildCustomSectionsBlocks(
    appConfig && Array.isArray(appConfig.newsletterCustomSections) ? appConfig.newsletterCustomSections : []
  );

  const needsRecent = /\{\{\s*RECENTLY_ADDED\s*\}\}/i.test(String(subject || '')) || /\{\{\s*RECENTLY_ADDED\s*\}\}/i.test(String(body || ''));
  let recentlyAddedBlocks = { text: '', html: '' };
  if (needsRecent) {
    try {
      if (typeof fetchRecentlyAdded === 'function') {
        // Fetch more than we display so counts reflect the full date window.
        const items = await fetchRecentlyAdded({ perServer: 50, serverId: scopeServerId });
        recentlyAddedBlocks = buildRecentlyAddedBlocks((items || []), { publicBaseUrl, startDate, endDate, displayLimit: 20, scopeServerName });
      } else {
        recentlyAddedBlocks = { text: 'Recently added list unavailable.', html: '<div>Recently added list unavailable.</div>' };
      }
    } catch (e) {
      console.error('[OmniStream] Failed to build recently added blocks:', e.message);
      recentlyAddedBlocks = { text: 'Recently added list unavailable.', html: '<div>Recently added list unavailable.</div>' };
    }
  }

  const recentStats = recentlyAddedBlocks && recentlyAddedBlocks.stats ? recentlyAddedBlocks.stats : { movies: 0, shows: 0, seasons: 0 };

  const replacements = {
    '{{SERVER_ID}}': scopeServerId,
    '{{SERVER_NAME}}': scopeServerName,
    '{{START_DATE}}': startDate,
    '{{END_DATE}}': endDate,
    '{{RECENTLY_ADDED}}': recentlyAddedBlocks.text,
    '{{RECENTLY_ADDED_MOVIES_COUNT}}': String(recentStats.movies || 0),
    '{{RECENTLY_ADDED_SHOWS_COUNT}}': String(recentStats.shows || 0),
    '{{RECENTLY_ADDED_SEASONS_COUNT}}': String(recentStats.seasons || 0),
    '{{CUSTOM_SECTIONS}}': customSectionsBlocks.text,
    '{{NEWSLETTER_LOGO_URL}}': logoUrlForEmail,
    '{{NEWSLETTER_LOGO_BLOCK}}': '',
    // Back-compat with some existing templates people copy in
    "${parameters['start_date']}": startDate,
    "${parameters['end_date']}": endDate
  };

  const rawSubject = applyBasicNewsletterReplacements(subject || '', replacements);
  let rawBody = String(body || '');

  const isHtml = /<!doctype\s+html|<html\b/i.test(rawBody);

  // If a template doesn't explicitly place {{CUSTOM_SECTIONS}}, auto-place it
  // near the top (under the header/logo) when sections exist.
  const hasCustomSections = Boolean((customSectionsBlocks && (customSectionsBlocks.html || customSectionsBlocks.text)));
  const bodyHasCustomToken = /\{\{\s*CUSTOM_SECTIONS\s*\}\}/i.test(rawBody);
  if (hasCustomSections && !bodyHasCustomToken) {
    if (isHtml) {
      rawBody = autoInsertCustomSectionsTokenIntoHtml(rawBody);
    } else {
      rawBody = `{{CUSTOM_SECTIONS}}\n\n${rawBody}`;
    }
  }

  if (isHtml) {
    const logoBlockHtml = logoUrlForEmail
      ? `<img src="${escapeHtml(logoUrlForEmail)}" alt="Logo" style="display:block;max-width:100%;height:auto;" />`
      : '';
    const htmlReplacements = {
      ...replacements,
      '{{RECENTLY_ADDED}}': recentlyAddedBlocks.html,
      '{{CUSTOM_SECTIONS}}': customSectionsBlocks.html,
      '{{NEWSLETTER_LOGO_BLOCK}}': logoBlockHtml
    };
    const renderedHtml = applyBasicNewsletterReplacements(rawBody, htmlReplacements);
    const renderedText = stripHtmlToText(renderedHtml) || applyBasicNewsletterReplacements(rawBody, replacements);
    return { subject: rawSubject, text: renderedText, html: renderedHtml, _startDate: startDate, _endDate: endDate };
  }

  const renderedText = applyBasicNewsletterReplacements(rawBody, replacements);
  return { subject: rawSubject, text: renderedText, html: null, _startDate: startDate, _endDate: endDate };
}

ensureDefaultNewsletterTemplate();

// Track last derived notifications so we only fire notifiers on changes
let lastNotificationIds = new Set();

// Track global polling health/metadata
let lastPollAt = null;           // ISO string of last completed pollAll
let lastPollDurationMs = null;   // Duration of last pollAll in milliseconds
let lastPollError = null;        // Last top-level pollAll error message, if any

// Track currently active sessions so history can record one row per session
// (insert on first sight, update while active, and mark ended when it disappears).
const activeHistorySessions = new Map(); // key -> { rowId, serverId, lastSeenAt }

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
let historyDbReady = false;
try {
  historyDb = new sqlite3.Database(HISTORY_DB_FILE);
  historyDb.serialize(() => {
    historyDb.run(
      'CREATE TABLE IF NOT EXISTS history (\n' +
      '  id INTEGER PRIMARY KEY AUTOINCREMENT,\n' +
      '  time TEXT NOT NULL,\n' +
      '  sessionKey TEXT,\n' +
      '  endedAt TEXT,\n' +
      '  lastSeenAt TEXT,\n' +
      '  serverId TEXT,\n' +
      '  serverName TEXT,\n' +
      '  type TEXT,\n' +
      '  user TEXT,\n' +
      '  userAvatar TEXT,\n' +
      '  title TEXT,\n' +
      '  mediaType TEXT,\n' +
      '  seriesTitle TEXT,\n' +
      '  episodeTitle TEXT,\n' +
      '  year INTEGER,\n' +
      '  channel TEXT,\n' +
      '  isLive INTEGER,\n' +
      '  poster TEXT,\n' +
      '  background TEXT,\n' +
      '  stream TEXT,\n' +
      '  transcoding INTEGER,\n' +
      '  location TEXT,\n' +
      '  bandwidth REAL,\n' +
      '  platform TEXT,\n' +
      '  product TEXT,\n' +
      '  player TEXT,\n' +
      '  quality TEXT,\n' +
      '  duration INTEGER,\n' +
      '  progress INTEGER,\n' +
      '  ip TEXT,\n' +
      '  completed INTEGER\n' +
      ')'
    );
    historyDb.run('CREATE INDEX IF NOT EXISTS idx_history_time ON history(time)');

    // Lightweight schema migrations for existing DBs
    historyDb.all('PRAGMA table_info(history)', (err, rows) => {
      if (err) {
        console.error('[OmniStream] Failed to inspect history schema:', err.message);
        historyDbReady = true;
        return;
      }
      const existing = new Set((rows || []).map(r => r && r.name).filter(Boolean));
      const toAdd = [
        { name: 'sessionKey', ddl: 'ALTER TABLE history ADD COLUMN sessionKey TEXT' },
        { name: 'endedAt', ddl: 'ALTER TABLE history ADD COLUMN endedAt TEXT' },
        { name: 'lastSeenAt', ddl: 'ALTER TABLE history ADD COLUMN lastSeenAt TEXT' },
        { name: 'mediaType', ddl: 'ALTER TABLE history ADD COLUMN mediaType TEXT' },
        { name: 'seriesTitle', ddl: 'ALTER TABLE history ADD COLUMN seriesTitle TEXT' },
        { name: 'episodeTitle', ddl: 'ALTER TABLE history ADD COLUMN episodeTitle TEXT' },
        { name: 'year', ddl: 'ALTER TABLE history ADD COLUMN year INTEGER' },
        { name: 'channel', ddl: 'ALTER TABLE history ADD COLUMN channel TEXT' },
        { name: 'isLive', ddl: 'ALTER TABLE history ADD COLUMN isLive INTEGER' },
        { name: 'poster', ddl: 'ALTER TABLE history ADD COLUMN poster TEXT' },
        { name: 'background', ddl: 'ALTER TABLE history ADD COLUMN background TEXT' },
        { name: 'platform', ddl: 'ALTER TABLE history ADD COLUMN platform TEXT' },
        { name: 'product', ddl: 'ALTER TABLE history ADD COLUMN product TEXT' },
        { name: 'player', ddl: 'ALTER TABLE history ADD COLUMN player TEXT' },
        { name: 'quality', ddl: 'ALTER TABLE history ADD COLUMN quality TEXT' },
        { name: 'duration', ddl: 'ALTER TABLE history ADD COLUMN duration INTEGER' },
        { name: 'progress', ddl: 'ALTER TABLE history ADD COLUMN progress INTEGER' },
        { name: 'ip', ddl: 'ALTER TABLE history ADD COLUMN ip TEXT' },
        { name: 'completed', ddl: 'ALTER TABLE history ADD COLUMN completed INTEGER' },
        { name: 'userAvatar', ddl: 'ALTER TABLE history ADD COLUMN userAvatar TEXT' }
      ].filter(c => !existing.has(c.name));

      const finalizeReady = () => {
        // sessionKey index is only valid after the column exists
        if (existing.has('sessionKey') || !toAdd.find(c => c.name === 'sessionKey')) {
          historyDb.run('CREATE INDEX IF NOT EXISTS idx_history_sessionKey ON history(sessionKey)', () => {
            historyDbReady = true;
          });
        } else {
          // sessionKey was attempted but might not exist; still mark ready.
          historyDbReady = true;
        }
      };

      if (!toAdd.length) {
        finalizeReady();
        return;
      }

      let remaining = toAdd.length;
      toAdd.forEach(c => {
        historyDb.run(c.ddl, (e) => {
          if (e) {
            // Don't fail startup on migration errors; just log.
            console.error(`[OmniStream] Failed to migrate history schema (add ${c.name}):`, e.message);
          } else {
            existing.add(c.name);
          }
          remaining--;
          if (remaining <= 0) finalizeReady();
        });
      });
    });

    // Table for newsletter / subscriber emails imported from external sources (e.g. Overseerr)
    historyDb.run(
      'CREATE TABLE IF NOT EXISTS newsletter_subscribers (\n' +
      '  id INTEGER PRIMARY KEY AUTOINCREMENT,\n' +
      "  source TEXT NOT NULL,\n" +
      "  externalId TEXT,\n" +
      "  name TEXT,\n" +
      "  watchUser TEXT,\n" +
      "  email TEXT NOT NULL,\n" +
      "  createdAt TEXT NOT NULL,\n" +
      "  updatedAt TEXT NOT NULL,\n" +
      "  active INTEGER NOT NULL DEFAULT 1,\n" +
      "  serverTags TEXT,\n" +
      '  UNIQUE(source, externalId)\n' +
      ')'
    );
    historyDb.run('CREATE INDEX IF NOT EXISTS idx_subscribers_email ON newsletter_subscribers(email)');

    // Lightweight schema migrations for newsletter_subscribers
    historyDb.all('PRAGMA table_info(newsletter_subscribers)', (err, rows) => {
      if (err) {
        console.error('[OmniStream] Failed to inspect newsletter_subscribers schema:', err.message);
        return;
      }
      const existing = new Set((rows || []).map(r => r && r.name).filter(Boolean));
      const toAdd = [
        { name: 'watchUser', ddl: 'ALTER TABLE newsletter_subscribers ADD COLUMN watchUser TEXT' },
        { name: 'serverTags', ddl: 'ALTER TABLE newsletter_subscribers ADD COLUMN serverTags TEXT' }
      ].filter(c => !existing.has(c.name));
      if (!toAdd.length) return;
      toAdd.forEach(c => {
        historyDb.run(c.ddl, (e) => {
          if (e) {
            console.error(`[OmniStream] Failed to migrate newsletter_subscribers schema (add ${c.name}):`, e.message);
          }
        });
      });
    });
  });
  console.log('[OmniStream] Using history database at', HISTORY_DB_FILE);
} catch (e) {
  console.error('Failed to initialize history database:', e.message);
  historyDb = null;
  historyDbReady = false;
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
    // Optional Plex session debug logging (very noisy in production)
    if (process.env.DEBUG_PLEX_SESSIONS === '1') {
      if (d && d.MediaContainer && d.MediaContainer.Metadata) {
        d.MediaContainer.Metadata.forEach(m => {
          console.log('Session:', m.title, 'Type:', m.type, 'Thumb:', m.thumb);
        });
        d.MediaContainer.Metadata.forEach(m => {
          if (m.type === 'live') {
            console.log('Live TV session:', m.title, 'Poster:', m.thumb);
          }
        });
      }
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
        const mediaType = (m.type || '').toString().toLowerCase();
        const isLive = mediaType === 'live';
        let posterUrl;
        let backgroundUrl;
        // Prefer show poster for TV episodes so we avoid episode/season stills
        let rawThumb;
        if (m.type === 'episode' || m.grandparentTitle) {
          rawThumb = m.grandparentThumb || m.parentThumb || m.thumb || m.art || '';
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

        // Background artwork – prefer "art" when available, fall back to poster
        const rawArt = m.art || '';
        if (rawArt && typeof rawArt === 'string') {
          if (/^https?:\/\//i.test(rawArt)) {
            backgroundUrl = rawArt;
          } else if (resp.config && resp.config.serverConfig) {
            const serverId = resp.config.serverConfig.id;
            backgroundUrl = `/api/poster?serverId=${encodeURIComponent(serverId)}&path=${encodeURIComponent(rawArt)}`;
          }
        }
        if (!backgroundUrl) {
          backgroundUrl = posterUrl || undefined;
        }

        // Fallback placeholder when no artwork is available
        const normalizedPoster = posterUrl || '/live_tv_placeholder.svg';
        if (!backgroundUrl) {
          backgroundUrl = normalizedPoster;
        }

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
          mediaType,
          isLive,
          channel: isLive ? (m.grandparentTitle || m.parentTitle || m.title || '') : undefined,
          platform: m.platform || m.Player?.platform || m.Player?.product || '',
          state: m.state || m.Player?.state || '',
          poster: m.poster || normalizedPoster,
          background: backgroundUrl || normalizedPoster,
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
          const derivedMediaType = (s.mediaType || (s.isLive ? 'live' : (s.episode || s.series || s.SeriesTitle ? 'episode' : 'movie'))).toString().toLowerCase();
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
            mediaType: derivedMediaType,
            isLive: !!s.isLive,
            channel: s.channel || '',
            platform: s.platform || s.Client || s.DeviceName || '',
            state: s.state,
            poster: s.poster || '/live_tv_placeholder.svg',
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
            background: s.background || s.backdrop || s.poster || '/live_tv_placeholder.svg',
            userAvatar: s.userAvatar || undefined,
          };
        }
        // Standard Jellyfin/Emby API: treat any session with NowPlayingItem and PlayState as active
        if (s.NowPlayingItem && s.PlayState) {
          let posterUrl;
          let backgroundUrl;
          const rawType = (s.NowPlayingItem?.Type || '').toString().toLowerCase();
          const isLive = rawType === 'livetv' || rawType === 'live' || s.NowPlayingItem?.IsLive === true;
          const mediaType = rawType === 'movie'
            ? 'movie'
            : (rawType === 'episode' ? 'episode' : (isLive ? 'live' : (rawType === 'audio' ? 'track' : rawType)));
          if (resp.config && resp.config.serverConfig) {
            const serverId = resp.config.serverConfig.id;
            const itemId = s.NowPlayingItem.Id;
            const seriesId = s.NowPlayingItem.SeriesId;
            const nowPlayingType = String(s.NowPlayingItem.Type || rawType || '').toLowerCase();

            // For episode sessions, prefer the series (show) artwork over season/episode artwork.
            const posterItemId = (nowPlayingType === 'episode' && seriesId) ? seriesId : itemId;
            const backdropItemId = posterItemId;

            if (posterItemId) {
              const embyPath = `/Items/${posterItemId}/Images/Primary`;
              posterUrl = `/api/poster?serverId=${encodeURIComponent(serverId)}&path=${encodeURIComponent(embyPath)}`;
              const backdropPath = `/Items/${backdropItemId}/Images/Backdrop`;
              backgroundUrl = `/api/poster?serverId=${encodeURIComponent(serverId)}&path=${encodeURIComponent(backdropPath)}`;
            }
          }
          // Fallback placeholder for LiveTv sessions without artwork
          if (!posterUrl && s.NowPlayingItem?.Type === 'LiveTv') {
            posterUrl = '/live_tv_placeholder.svg';
          }
          if (!posterUrl) {
            posterUrl = '/live_tv_placeholder.svg';
          }
          if (!backgroundUrl) {
            backgroundUrl = posterUrl;
          }

          // Jellyfin/Emby user avatar when user id is available
          let userAvatar;
          if (resp.config && resp.config.serverConfig) {
            const serverId = resp.config.serverConfig.id;
            const userId = s.UserId || (s.User && (s.User.Id || s.User.id));
            if (userId) {
              const avatarPath = `/Users/${userId}/Images/Primary`;
              userAvatar = `/api/poster?serverId=${encodeURIComponent(serverId)}&path=${encodeURIComponent(avatarPath)}`;
            }
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
            // Jellyfin sometimes leaves EpisodeTitle null; for episodes, fall back to Name.
            episode: s.NowPlayingItem?.EpisodeTitle || (mediaType === 'episode' ? s.NowPlayingItem?.Name : undefined),
            year: s.NowPlayingItem?.ProductionYear,
            mediaType,
            platform: s.Client || s.DeviceName || '',
            state: s.PlayState?.PlayMethod || '',
            poster: posterUrl,
            background: backgroundUrl,
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
            userAvatar,
            channel: s.NowPlayingItem?.ChannelName || '',
            isLive: isLive,
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

  // After polling all servers, record one row per session in history database.
  // We insert when a session is first seen, update while active, and mark ended when it disappears.
  if (historyDb && historyDbReady) {
    const timestamp = new Date().toISOString();
    const currentlyActiveKeys = new Set();
    const currentSessions = [];

    Object.values(statuses).forEach(st => {
      if (!st.online || !Array.isArray(st.sessions)) return;
      st.sessions.forEach(sess => {
        // Prefer stable session id if available; fall back to a best-effort derived key.
        const rawSessionId = sess.sessionId || sess.sessionKey || sess.id || '';
        const derived = [
          st.id,
          rawSessionId || '',
          sess.user || sess.userName || '',
          sess.title || '',
          sess.player || '',
          sess.ip || ''
        ].map(v => String(v || '').toLowerCase()).join('|');
        const sessionKey = derived;
        currentlyActiveKeys.add(sessionKey);
        currentSessions.push({ st, sess, sessionKey });
      });
    });

    historyDb.serialize(() => {
      // Mark ended sessions
      for (const [key, meta] of activeHistorySessions.entries()) {
        if (currentlyActiveKeys.has(key)) continue;
        try {
          historyDb.run(
            'UPDATE history SET endedAt = ?, lastSeenAt = COALESCE(lastSeenAt, ?), completed = CASE WHEN progress >= 95 THEN 1 ELSE completed END WHERE id = ?',
            [timestamp, timestamp, meta.rowId],
            () => {}
          );
        } catch (_) {}
        activeHistorySessions.delete(key);
      }

      // Upsert active sessions
      currentSessions.forEach(({ st, sess, sessionKey }) => {
        const user = sess.user || sess.userName || 'Unknown';
        const userAvatar = (sess.userAvatar || '').toString();
        const isLive = !!sess.isLive;
        const mediaType = (sess.mediaType || '').toString().toLowerCase();
        const seriesTitle = (sess.seriesTitle || '').toString();
        const episodeTitle = (sess.episode || sess.episodeTitle || '').toString();
        const year = typeof sess.year === 'number' ? sess.year : null;
        const channel = (sess.channel || '').toString();
        const poster = (sess.poster || '/live_tv_placeholder.svg').toString();
        const background = (sess.background || sess.poster || '/live_tv_placeholder.svg').toString();

        const title = seriesTitle ? `${seriesTitle} - ${episodeTitle || sess.title || ''}`.replace(/\s+-\s*$/, '') : (sess.title || channel || 'Idle');
        const stream = sess.stream || '';
        const transcoding = typeof sess.transcoding === 'boolean' ? (sess.transcoding ? 1 : 0) : null;
        const location = sess.location || '';
        const bandwidth = typeof sess.bandwidth === 'number' ? sess.bandwidth : 0;
        const platform = sess.platform || '';
        const product = sess.product || '';
        const player = sess.player || '';
        const quality = sess.quality || '';
        const duration = typeof sess.duration === 'number' ? sess.duration : null;
        const progress = typeof sess.progress === 'number' ? sess.progress : null;
        const ip = sess.ip || '';

        const existing = activeHistorySessions.get(sessionKey);
        if (!existing) {
          historyDb.run(
            'INSERT INTO history (time, sessionKey, lastSeenAt, serverId, serverName, type, user, userAvatar, title, mediaType, seriesTitle, episodeTitle, year, channel, isLive, poster, background, stream, transcoding, location, bandwidth, platform, product, player, quality, duration, progress, ip, completed) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
            [
              timestamp,
              sessionKey,
              timestamp,
              st.id,
              st.name,
              st.type,
              user,
              userAvatar,
              title,
              mediaType,
              seriesTitle,
              episodeTitle,
              year,
              channel,
              isLive ? 1 : 0,
              poster,
              background,
              stream,
              transcoding,
              location,
              bandwidth,
              platform,
              product,
              player,
              quality,
              duration,
              progress,
              ip,
              null
            ],
            function (err) {
              if (!err && this && typeof this.lastID === 'number') {
                activeHistorySessions.set(sessionKey, { rowId: this.lastID, serverId: st.id, lastSeenAt: timestamp });
              }
            }
          );
        } else {
          historyDb.run(
            'UPDATE history SET lastSeenAt = ?, serverName = ?, user = ?, userAvatar = ?, title = ?, mediaType = ?, seriesTitle = ?, episodeTitle = ?, year = ?, channel = ?, isLive = ?, poster = ?, background = ?, stream = ?, transcoding = ?, location = ?, bandwidth = ?, platform = ?, product = ?, player = ?, quality = ?, duration = ?, progress = ?, ip = ? WHERE id = ?',
            [
              timestamp,
              st.name,
              user,
              userAvatar,
              title,
              mediaType,
              seriesTitle,
              episodeTitle,
              year,
              channel,
              isLive ? 1 : 0,
              poster,
              background,
              stream,
              transcoding,
              location,
              bandwidth,
              platform,
              product,
              player,
              quality,
              duration,
              progress,
              ip,
              existing.rowId
            ],
            () => {}
          );
          existing.lastSeenAt = timestamp;
        }
      });

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
    version: appVersion || null,
    update: {
      checkedAt: updateState.lastCheckedAtMs ? new Date(updateState.lastCheckedAtMs).toISOString() : null,
      latestVersion: updateState.latestVersion,
      updateAvailable: updateState.updateAvailable,
      releasesUrl: DEFAULT_GITHUB_RELEASES_URL
    }
  });
});

app.get('/api/about', (req, res) => {
  const checkedAt = updateState.lastCheckedAtMs ? new Date(updateState.lastCheckedAtMs).toISOString() : null;
  res.json({
    name: 'OmniStream',
    version: appVersion || null,
    githubUrl: DEFAULT_GITHUB_URL,
    releasesUrl: DEFAULT_GITHUB_RELEASES_URL,
    update: {
      checkedAt,
      latestVersion: updateState.latestVersion,
      updateAvailable: updateState.updateAvailable,
      error: updateState.error
    },
    serverTime: new Date().toISOString()
  });
});

app.get('/api/reports/watch-statistics', async (req, res) => {
  try {
    if (!historyDb || !historyDbReady) {
      return res.status(503).json({ error: 'History database not ready' });
    }

    const metricRaw = (req.query.metric || 'count').toString().toLowerCase();
    const metric = metricRaw === 'duration' ? 'duration' : 'count';
    const daysRaw = Number(req.query.days ?? 1000);
    const days = Number.isFinite(daysRaw) ? Math.max(1, Math.min(5000, Math.floor(daysRaw))) : 1000;

    const now = Date.now();
    const startIso = new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
    const eventTimeExpr = 'COALESCE(endedAt, lastSeenAt, time)';
    const watchSecondsExpr = `CASE
      WHEN duration IS NULL THEN 0
      WHEN progress IS NULL THEN duration
      WHEN progress < 0 THEN 0
      WHEN progress > 100 THEN duration
      ELSE CAST(duration * (progress / 100.0) AS INTEGER)
    END`;

    const valueExpr = metric === 'duration' ? `SUM(${watchSecondsExpr})` : 'COUNT(*)';

    const dbAll = (sql, params) => new Promise((resolve, reject) => {
      historyDb.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });

    const topLimit = 5;

    const [
      mostWatchedMovies,
      mostPopularMovies,
      mostWatchedTvShows,
      mostPopularTvShows,
      mostPlayedArtists,
      mostPopularArtists,
      recentlyWatched,
      mostActiveLibraries,
      mostActiveUsers,
      mostActivePlatforms
    ] = await Promise.all([
      dbAll(
        `SELECT title AS name, year, MAX(poster) AS poster, MAX(background) AS background, ${valueExpr} AS value
         FROM history
         WHERE mediaType = 'movie' AND ${eventTimeExpr} >= ?
         GROUP BY title, year
         ORDER BY value DESC
         LIMIT ?`,
        [startIso, topLimit]
      ),
      dbAll(
        `SELECT title AS name, year, MAX(poster) AS poster, MAX(background) AS background, COUNT(DISTINCT user) AS value
         FROM history
         WHERE mediaType = 'movie' AND ${eventTimeExpr} >= ?
         GROUP BY title, year
         ORDER BY value DESC
         LIMIT ?`,
        [startIso, topLimit]
      ),
      dbAll(
        `SELECT COALESCE(NULLIF(seriesTitle,''), title) AS name, MAX(poster) AS poster, MAX(background) AS background, ${valueExpr} AS value
         FROM history
         WHERE mediaType = 'episode' AND ${eventTimeExpr} >= ?
         GROUP BY name
         ORDER BY value DESC
         LIMIT ?`,
        [startIso, topLimit]
      ),
      dbAll(
        `SELECT COALESCE(NULLIF(seriesTitle,''), title) AS name, MAX(poster) AS poster, MAX(background) AS background, COUNT(DISTINCT user) AS value
         FROM history
         WHERE mediaType = 'episode' AND ${eventTimeExpr} >= ?
         GROUP BY name
         ORDER BY value DESC
         LIMIT ?`,
        [startIso, topLimit]
      ),
      dbAll(
        `SELECT COALESCE(NULLIF(seriesTitle,''), 'Unknown') AS name, MAX(poster) AS poster, MAX(background) AS background, ${valueExpr} AS value
         FROM history
         WHERE mediaType = 'track' AND ${eventTimeExpr} >= ?
         GROUP BY name
         ORDER BY value DESC
         LIMIT ?`,
        [startIso, topLimit]
      ),
      dbAll(
        `SELECT COALESCE(NULLIF(seriesTitle,''), 'Unknown') AS name, MAX(poster) AS poster, MAX(background) AS background, COUNT(DISTINCT user) AS value
         FROM history
         WHERE mediaType = 'track' AND ${eventTimeExpr} >= ?
         GROUP BY name
         ORDER BY value DESC
         LIMIT ?`,
        [startIso, topLimit]
      ),
      dbAll(
        `SELECT ${eventTimeExpr} AS eventTime, user, userAvatar, title, mediaType, seriesTitle, episodeTitle, year, poster, background
         FROM history
         WHERE ${eventTimeExpr} >= ?
         ORDER BY ${eventTimeExpr} DESC
         LIMIT ?`,
        [startIso, topLimit]
      ),
      dbAll(
        `SELECT
           CASE
             WHEN isLive = 1 THEN 'Live TV'
             WHEN mediaType = 'episode' THEN 'TV Shows'
             WHEN mediaType = 'movie' THEN 'Movies'
             WHEN mediaType = 'track' THEN 'Music'
             ELSE 'Other'
           END AS name,
           ${valueExpr} AS value
         FROM history
         WHERE ${eventTimeExpr} >= ?
         GROUP BY name
         ORDER BY value DESC
         LIMIT ?`,
        [startIso, topLimit]
      ),
      dbAll(
        `SELECT COALESCE(NULLIF(user,''), 'Unknown') AS name, MAX(userAvatar) AS avatar, ${valueExpr} AS value
         FROM history
         WHERE ${eventTimeExpr} >= ?
         GROUP BY name
         ORDER BY value DESC
         LIMIT ?`,
        [startIso, topLimit]
      ),
      dbAll(
        `SELECT COALESCE(NULLIF(platform,''), 'Unknown') AS name, ${valueExpr} AS value
         FROM history
         WHERE ${eventTimeExpr} >= ?
         GROUP BY name
         ORDER BY value DESC
         LIMIT ?`,
        [startIso, topLimit]
      )
    ]);

    // Peak concurrency (max) over the selected window, based on history intervals.
    // IMPORTANT: match the dashboard behavior by excluding disabled servers.
    const enabledIds = new Set((Array.isArray(servers) ? servers : [])
      .filter(s => s && !s.disabled)
      .map(s => String(s.id)));

    const computePeakConcurrencyFromHistory = async () => {
      const rangeStartMs = Date.parse(startIso);
      const rangeEndIso = new Date(now).toISOString();
      const rangeEndMs = now;
      if (!Number.isFinite(rangeStartMs) || !Number.isFinite(rangeEndMs) || rangeEndMs <= rangeStartMs) {
        return { streams: 0, transcodes: 0, directPlays: 0 };
      }

      const enabledIdList = Array.from(enabledIds);
      if (!enabledIdList.length) return { streams: 0, transcodes: 0, directPlays: 0 };
      const inSql = enabledIdList.map(() => '?').join(',');

      const rows = await dbAll(
        `SELECT time AS startedAt,
                COALESCE(endedAt, lastSeenAt, time) AS endedAt,
                serverId,
                transcoding,
                stream
           FROM history
          WHERE time <= ?
            AND COALESCE(endedAt, lastSeenAt, time) >= ?
            AND serverId IN (${inSql})`,
        [rangeEndIso, startIso, ...enabledIdList]
      );

      const events = [];
      for (const r of rows) {
        const startMsRaw = Date.parse(r.startedAt);
        const endMsRaw = Date.parse(r.endedAt);
        if (!Number.isFinite(startMsRaw) || !Number.isFinite(endMsRaw)) continue;

        const startMs = Math.max(startMsRaw, rangeStartMs);
        const endMs = Math.min(endMsRaw, rangeEndMs);
        if (!(endMs > startMs)) continue;

        const streamTxt = String(r.stream || '').toLowerCase();
        const isTranscoding = (r.transcoding === 1 || r.transcoding === true) || streamTxt.includes('transcode');
        const isDirect = !isTranscoding;

        // Use [start, end) intervals. Apply end before start at the same timestamp.
        events.push({ t: startMs, order: 1, all: +1, trans: isTranscoding ? +1 : 0, direct: isDirect ? +1 : 0 });
        events.push({ t: endMs, order: 0, all: -1, trans: isTranscoding ? -1 : 0, direct: isDirect ? -1 : 0 });
      }

      events.sort((a, b) => (a.t - b.t) || (a.order - b.order));
      let curAll = 0, curTrans = 0, curDirect = 0;
      let peakAll = 0, peakTrans = 0, peakDirect = 0;
      for (const ev of events) {
        curAll += ev.all;
        curTrans += ev.trans;
        curDirect += ev.direct;
        if (curAll > peakAll) peakAll = curAll;
        if (curTrans > peakTrans) peakTrans = curTrans;
        if (curDirect > peakDirect) peakDirect = curDirect;
      }

      return {
        streams: peakAll,
        transcodes: peakTrans,
        directPlays: peakDirect
      };
    };

    const peakConcurrent = await computePeakConcurrencyFromHistory();

    res.json({
      metric,
      days,
      startIso,
      generatedAt: new Date().toISOString(),
      sections: {
        mostWatchedMovies,
        mostPopularMovies,
        mostWatchedTvShows,
        mostPopularTvShows,
        mostPlayedArtists,
        mostPopularArtists,
        recentlyWatched,
        mostActiveLibraries,
        mostActiveUsers,
        mostActivePlatforms,
        mostConcurrentStreams: {
          streams: peakConcurrent.streams,
          transcodes: peakConcurrent.transcodes,
          directPlays: peakConcurrent.directPlays
        }
      }
    });
  } catch (e) {
    console.error('[OmniStream] Reports watch-statistics failed:', e.message);
    res.status(500).json({ error: 'Failed to build reports', detail: e.message });
  }
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
  let sql = 'SELECT time, endedAt, lastSeenAt, sessionKey, serverId, serverName, type, user, title, stream, transcoding, location, bandwidth, platform, product, player, quality, duration, progress, ip, completed FROM history ORDER BY id DESC';
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
      endedAt: r.endedAt,
      lastSeenAt: r.lastSeenAt,
      sessionKey: r.sessionKey,
      serverId: r.serverId,
      serverName: r.serverName,
      type: r.type,
      user: r.user,
      title: r.title,
      stream: r.stream,
      transcoding: typeof r.transcoding === 'number' ? !!r.transcoding : undefined,
      location: r.location,
      bandwidth: typeof r.bandwidth === 'number' ? r.bandwidth : 0,
      platform: r.platform,
      product: r.product,
      player: r.player,
      quality: r.quality,
      duration: typeof r.duration === 'number' ? r.duration : 0,
      progress: typeof r.progress === 'number' ? r.progress : 0,
      ip: r.ip,
      completed: typeof r.completed === 'number' ? !!r.completed : undefined
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
        "  watchUser TEXT,\n" +
        "  email TEXT NOT NULL,\n" +
        "  createdAt TEXT NOT NULL,\n" +
        "  updatedAt TEXT NOT NULL,\n" +
        "  active INTEGER NOT NULL DEFAULT 1,\n" +
        "  serverTags TEXT,\n" +
        '  UNIQUE(source, externalId)\n' +
        ')'
      );
      const stmt = historyDb.prepare(
        'INSERT INTO newsletter_subscribers (source, externalId, name, watchUser, email, createdAt, updatedAt, active) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, 1) ' +
        'ON CONFLICT(source, externalId) DO UPDATE SET ' +
        '  name = excluded.name, ' +
        '  watchUser = excluded.watchUser, ' +
        '  email = excluded.email, ' +
        '  updatedAt = excluded.updatedAt, ' +
        '  active = 1'
      );

      let processed = 0;
      withEmail.forEach(u => {
        const externalId = u.id != null ? String(u.id) : null;
        const name = u.name || u.email;
        const watchUser = name;
        stmt.run('overseerr', externalId, name, watchUser, u.email, now, now, (err) => {
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

    let sql = 'SELECT id, source, externalId, name, watchUser, email, createdAt, updatedAt, active, serverTags FROM newsletter_subscribers';
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
        watchUser: r.watchUser,
        email: r.email,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        active: Number(r.active) === 1,
        serverTags: (() => {
          if (!r.serverTags) return [];
          try {
            const parsed = JSON.parse(String(r.serverTags));
            return Array.isArray(parsed) ? parsed.map(x => String(x)) : [];
          } catch (_) {
            return [];
          }
        })()
      }));
      res.json({ total: items.length, items });
    });
  });

  // Recompute subscriber server tags based on watch history.
  // Tags are derived by matching subscriber.watchUser (or subscriber.name) to history.user (case-insensitive).
  app.post('/api/subscribers/tag-by-server', (req, res) => {
    if (!historyDb) {
      return res.status(500).json({ error: 'history DB not available' });
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    let days = Number(body.days);
    if (!Number.isFinite(days) || days <= 0) days = 0;
    if (days > 3650) days = 3650;
    const cutoffIso = days ? new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString() : null;

    historyDb.all(
      'SELECT id, COALESCE(NULLIF(watchUser,\'\'), NULLIF(name,\'\')) AS watchUser FROM newsletter_subscribers',
      [],
      (err, subs) => {
        if (err) {
          console.error('[OmniStream] Failed to load subscribers for tagging:', err.message);
          return res.status(500).json({ error: 'Failed to load subscribers' });
        }

        const list = Array.isArray(subs) ? subs : [];
        const userKeys = [];
        const userKeySet = new Set();
        const watchUserBySubId = new Map();
        list.forEach(s => {
          const wu = s && typeof s.watchUser === 'string' ? s.watchUser.trim() : '';
          watchUserBySubId.set(s.id, wu);
          if (!wu) return;
          const key = wu.toLowerCase();
          if (!userKeySet.has(key)) {
            userKeySet.add(key);
            userKeys.push(key);
          }
        });

        if (!userKeys.length) {
          return res.json({ total: list.length, updated: 0, unmatched: list.length, days: days || null });
        }

        const placeholders = userKeys.map(() => '?').join(',');
        const params = [];
        let sql = `SELECT LOWER(user) AS u, GROUP_CONCAT(DISTINCT serverId) AS serverIds FROM history WHERE user IS NOT NULL AND serverId IS NOT NULL`;
        if (cutoffIso) {
          sql += ' AND time >= ?';
          params.push(cutoffIso);
        }
        sql += ` AND LOWER(user) IN (${placeholders}) GROUP BY LOWER(user)`;
        params.push(...userKeys);

        historyDb.all(sql, params, (err2, rows) => {
          if (err2) {
            console.error('[OmniStream] Failed to compute subscriber tags from history:', err2.message);
            return res.status(500).json({ error: 'Failed to compute tags' });
          }

          const tagsByUserLower = new Map();
          (rows || []).forEach(r => {
            const key = r && typeof r.u === 'string' ? r.u : '';
            const raw = r && typeof r.serverIds === 'string' ? r.serverIds : '';
            const parts = raw ? raw.split(',').map(x => String(x).trim()).filter(Boolean) : [];
            const uniq = Array.from(new Set(parts));
            uniq.sort();
            if (key) tagsByUserLower.set(key, uniq);
          });

          const now = new Date().toISOString();
          const stmt = historyDb.prepare('UPDATE newsletter_subscribers SET serverTags = ?, updatedAt = ? WHERE id = ?');
          let updated = 0;
          let unmatched = 0;

          list.forEach(s => {
            const id = s.id;
            const wu = watchUserBySubId.get(id) || '';
            const key = wu ? wu.toLowerCase() : '';
            const tags = key && tagsByUserLower.has(key) ? tagsByUserLower.get(key) : [];
            if (!tags.length) unmatched++;
            try {
              stmt.run(JSON.stringify(tags), now, id);
              updated++;
            } catch (_) {
              // ignore
            }
          });

          stmt.finalize(() => {
            res.json({ total: list.length, updated, unmatched, days: days || null });
          });
        });
      }
    );
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
          'SELECT id, source, externalId, name, watchUser, email, createdAt, updatedAt, active, serverTags FROM newsletter_subscribers WHERE id = ?',
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
              watchUser: row.watchUser,
              email: row.email,
              createdAt: row.createdAt,
              updatedAt: row.updatedAt,
              active: Number(row.active) === 1,
              serverTags: (() => {
                if (!row.serverTags) return [];
                try {
                  const parsed = JSON.parse(String(row.serverTags));
                  return Array.isArray(parsed) ? parsed.map(x => String(x)) : [];
                } catch (_) {
                  return [];
                }
              })()
            });
          }
        );
      }
    );
  });

  // Send a simple newsletter/broadcast email to all active subscribers
  app.post('/api/newsletter/send', async (req, res) => {
    try {
      const subject = (req.body && String(req.body.subject || '').trim()) || '';
      const body = (req.body && String(req.body.body || '').trim()) || '';
      const serverId = (req.body && req.body.serverId != null) ? String(req.body.serverId).trim() : '';
      if (!subject || !body) {
        return res.status(400).json({ error: 'subject and body are required' });
      }

      if (serverId) {
        const server = servers.find(s => String(s.id) === serverId);
        if (!server) {
          return res.status(400).json({ error: 'Invalid serverId' });
        }
      }

      const result = await sendNewsletterBroadcast({
        subject,
        body,
        startDate: req.body && req.body.startDate,
        endDate: req.body && req.body.endDate,
        publicBaseUrl: buildPublicBaseUrl(req),
        serverId
      });
      if (!result.sent) {
        return res.json({ sent: 0, message: 'No active subscribers with email found.' });
      }
      res.json({ sent: result.sent, saved: result.saved || [] });
    } catch (e) {
      console.error('[OmniStream] Newsletter send failed:', e.message);
      recordNotifierError('newsletter', e.message);
      res.status(500).json({ error: 'Failed to send newsletter' });
    }
  });

  // Render a newsletter preview without sending any email.
  app.post('/api/newsletter/preview', async (req, res) => {
    try {
      const subject = (req.body && String(req.body.subject || '').trim()) || '';
      const body = (req.body && String(req.body.body || '').trim()) || '';
      const serverId = (req.body && req.body.serverId != null) ? String(req.body.serverId).trim() : '';
      if (!subject || !body) {
        return res.status(400).json({ error: 'subject and body are required' });
      }

      if (serverId) {
        const server = servers.find(s => String(s.id) === serverId);
        if (!server) {
          return res.status(400).json({ error: 'Invalid serverId' });
        }
      }
      const rendered = await renderNewsletterSubjectAndBody(subject, body, fetchUnifiedRecentlyAdded, {
        startDate: req.body && req.body.startDate,
        endDate: req.body && req.body.endDate,
        publicBaseUrl: buildPublicBaseUrl(req),
        serverId
      });
      res.json({
        subject: rendered.subject || subject,
        html: rendered.html || '',
        text: rendered.text || '',
        startDate: rendered._startDate || null,
        endDate: rendered._endDate || null
      });
    } catch (e) {
      console.error('[OmniStream] Newsletter preview failed:', e.message);
      res.status(500).json({ error: 'Failed to render preview' });
    }
  });

  // Upload a newsletter logo image (base64 data URL) and save under public/uploads.
  // Returns the public path and updates config.newsletterBranding.logoUrl.
  app.post('/api/newsletter/logo/upload', async (req, res) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const dataUrl = typeof body.dataUrl === 'string' ? body.dataUrl.trim() : '';
      if (!dataUrl) {
        return res.status(400).json({ error: 'dataUrl is required' });
      }

      const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/i);
      if (!m) {
        return res.status(400).json({ error: 'Invalid dataUrl format' });
      }
      const mime = String(m[1] || '').toLowerCase();
      const b64 = String(m[2] || '');
      const allowed = new Map([
        ['image/png', 'png'],
        ['image/jpeg', 'jpg'],
        ['image/jpg', 'jpg'],
        ['image/gif', 'gif'],
        ['image/webp', 'webp']
      ]);
      const ext = allowed.get(mime);
      if (!ext) {
        return res.status(400).json({ error: 'Unsupported image type' });
      }

      let buf;
      try {
        buf = Buffer.from(b64, 'base64');
      } catch (_) {
        return res.status(400).json({ error: 'Invalid base64 payload' });
      }
      if (!buf || !buf.length) {
        return res.status(400).json({ error: 'Empty image payload' });
      }
      const maxBytes = 5 * 1024 * 1024;
      if (buf.length > maxBytes) {
        return res.status(413).json({ error: 'Logo too large (max 5MB)' });
      }

      const uploadsDir = path.join(__dirname, 'public', 'uploads');
      fs.mkdirSync(uploadsDir, { recursive: true });
      const name = `newsletter-logo-${Date.now()}-${Math.random().toString(16).slice(2)}.${ext}`;
      const filePath = path.join(uploadsDir, name);
      fs.writeFileSync(filePath, buf);

      if (!appConfig.newsletterBranding || typeof appConfig.newsletterBranding !== 'object') {
        appConfig.newsletterBranding = { logoUrl: '' };
      }
      appConfig.newsletterBranding.logoUrl = `/uploads/${name}`;
      saveAppConfigToDisk();

      res.json({ ok: true, logoUrl: appConfig.newsletterBranding.logoUrl });
    } catch (e) {
      console.error('[OmniStream] Logo upload failed:', e.message);
      res.status(500).json({ error: 'Failed to upload logo' });
    }
  });

  // Proxy Plex thumbnails without exposing Plex tokens in email HTML.
  app.get('/api/newsletter/plex/thumb', async (req, res) => {
    try {
      const serverId = String(req.query.serverId || '').trim();
      let thumb = String(req.query.thumb || '').trim();
      if (!serverId || !thumb) {
        return res.status(400).json({ error: 'serverId and thumb are required' });
      }
      if (!thumb.startsWith('/') || thumb.includes('..') || thumb.includes('://')) {
        return res.status(400).json({ error: 'Invalid thumb path' });
      }
      // Strip any token in the provided thumb query for safety.
      thumb = thumb.replace(/([?&])X-Plex-Token=[^&]+/ig, '$1').replace(/[?&]$/g, '');

      const server = servers.find(s => String(s.id) === serverId);
      if (!server || server.type !== 'plex' || !server.baseUrl || !server.token) {
        return res.status(404).json({ error: 'Plex server not found' });
      }

      const base = String(server.baseUrl).replace(/\/$/, '');
      const urlObj = new URL(base + thumb);
      const headers = {};
      const tokenLoc = server.tokenLocation || 'query';
      if (tokenLoc === 'header') {
        headers['X-Plex-Token'] = server.token;
      } else {
        urlObj.searchParams.set('X-Plex-Token', server.token);
      }

      const resp = await axios.get(urlObj.toString(), {
        headers,
        timeout: 15000,
        responseType: 'arraybuffer'
      });

      const contentType = (resp && resp.headers && resp.headers['content-type']) ? resp.headers['content-type'] : 'image/jpeg';
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.status(200).send(Buffer.from(resp.data));
    } catch (e) {
      console.error('[OmniStream] Newsletter thumb proxy failed:', e.message);
      res.status(500).json({ error: 'Failed to proxy thumb' });
    }
  });

  // Helper: fetch recently added items from enabled Plex servers
  async function fetchPlexRecentlyAdded({ perServer = 10, serverId = '' } = {}) {
    const wantedId = serverId != null ? String(serverId).trim() : '';
    const enabledPlex = servers.filter(s => {
      if (!s || s.disabled || s.type !== 'plex' || !s.token) return false;
      if (wantedId && String(s.id) !== wantedId) return false;
      return true;
    });
    const results = [];

    const parseAddedAtIso = (m) => {
      if (typeof m.addedAt === 'number') {
        return new Date(m.addedAt * 1000).toISOString();
      }
      if (typeof m.addedAt === 'string') {
        const parsed = Date.parse(m.addedAt);
        return Number.isNaN(parsed) ? new Date().toISOString() : new Date(parsed).toISOString();
      }
      return new Date().toISOString();
    };

    const toItem = (server, m) => {
      const rawType = (m && m.type ? String(m.type) : '').toLowerCase();
      const isMovie = rawType === 'movie';
      const isEpisode = rawType === 'episode';
      const isShow = rawType === 'show';
      const isSeason = rawType === 'season';
      if (!isMovie && !isEpisode && !isShow && !isSeason) return null;

      const seasonNumber = isEpisode
        ? (typeof m.parentIndex === 'number' ? m.parentIndex : null)
        : (isSeason
          ? (typeof m.index === 'number' ? m.index : (typeof m.parentIndex === 'number' ? m.parentIndex : null))
          : null);

      const episodeNumber = isEpisode
        ? (typeof m.index === 'number' ? m.index : null)
        : null;

      const showTitle = isEpisode
        ? (m.grandparentTitle || null)
        : (isSeason
          ? (m.parentTitle || m.grandparentTitle || null)
          : (isShow
            ? (m.title || m.originalTitle || null)
            : null));

      const seasonTitle = isEpisode
        ? (m.parentTitle || null)
        : (isSeason ? (m.title || null) : null);

      let title;
      if (isEpisode || m.grandparentTitle) {
        const series = m.grandparentTitle || '';
        const epName = m.title || '';
        const seasonNum = seasonNumber;
        const epNum = episodeNumber;
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
      } else if (isSeason) {
        const showName = showTitle ? String(showTitle) : (m.parentTitle || m.grandparentTitle || '');
        if (showName && seasonNumber !== null) {
          title = `${showName} - Season ${seasonNumber}`;
        } else if (showName && seasonTitle) {
          title = `${showName} - ${seasonTitle}`;
        } else {
          title = m.title || showName || m.originalTitle || 'Unknown';
        }
      } else {
        title = m.title || m.originalTitle || 'Unknown';
      }

      const addedAtIso = parseAddedAtIso(m);

      const thumb = isMovie
        ? (m.thumb || '')
        : (m.grandparentThumb || m.parentThumb || m.thumb || '');

      return {
        serverId: server.id,
        serverName: server.name || server.baseUrl,
        type: rawType,
        title,
        showTitle,
        seasonTitle,
        seasonNumber,
        episodeNumber,
        year: m.year || null,
        durationMinutes: typeof m.duration === 'number' ? (m.duration / 60000) : null,
        genres: Array.isArray(m.Genre) ? m.Genre.map(g => g && g.tag ? String(g.tag) : '').filter(Boolean) : [],
        summary: typeof m.summary === 'string' ? m.summary : '',
        ratingKey: m.ratingKey != null ? String(m.ratingKey) : null,
        thumb,
        addedAt: addedAtIso
      };
    };

    const plexGet = async (server, plexPath, { params = {}, responseType } = {}) => {
      const base = (server.baseUrl || '').replace(/\/$/, '');
      const headers = {};
      const requestParams = { ...(params || {}) };
      const tokenLoc = server.tokenLocation || 'query';
      if (tokenLoc === 'header') {
        headers['X-Plex-Token'] = server.token;
      } else {
        requestParams['X-Plex-Token'] = server.token;
      }
      return axios.get(base + plexPath, {
        headers,
        params: requestParams,
        timeout: 15000,
        responseType
      });
    };

    const seen = new Set();
    for (const server of enabledPlex) {
      try {
        // Prefer per-library-section recently added so TV libraries are always included.
        let sectionDirs = [];
        try {
          const secResp = await plexGet(server, '/library/sections');
          const mc = secResp.data && secResp.data.MediaContainer ? secResp.data.MediaContainer : null;
          sectionDirs = mc && Array.isArray(mc.Directory) ? mc.Directory : [];
        } catch (_) {
          sectionDirs = [];
        }

        const sections = sectionDirs
          .map(d => ({
            key: d && d.key != null ? String(d.key) : '',
            type: d && d.type ? String(d.type).toLowerCase() : ''
          }))
          .filter(s => s.key && (s.type === 'movie' || s.type === 'show'));

        const pullFrom = async (plexPath) => {
          const resp = await plexGet(server, plexPath, {
            params: {
              'X-Plex-Container-Start': 0,
              'X-Plex-Container-Size': perServer
            }
          });
          const mc = resp.data && resp.data.MediaContainer ? resp.data.MediaContainer : null;
          return mc && Array.isArray(mc.Metadata) ? mc.Metadata : [];
        };

        let metas = [];
        if (sections.length) {
          for (const s of sections) {
            try {
              const part = await pullFrom(`/library/sections/${encodeURIComponent(s.key)}/recentlyAdded`);
              metas = metas.concat(part);
            } catch (e) {
              // continue; some servers may have restricted libraries
            }
          }
        } else {
          // Fallback for older servers/configs: global recentlyAdded.
          try {
            metas = await pullFrom('/library/recentlyAdded');
          } catch (e) {
            metas = [];
          }
        }

        metas.forEach(m => {
          const it = toItem(server, m);
          if (!it) return;
          const key = `${it.serverId}:${it.ratingKey || it.title || ''}:${it.type}`;
          if (seen.has(key)) return;
          seen.add(key);
          results.push(it);
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

  function getJellyfinOrEmbyAuth(server) {
    const token = server && server.token ? String(server.token) : '';
    const tokenLoc = (server && server.tokenLocation) ? String(server.tokenLocation) : 'header';
    const headers = {};
    const params = {};
    if (!token) return { headers, params };

    if (server.type === 'jellyfin') {
      if (tokenLoc === 'query') {
        params.api_key = token;
      } else {
        headers['X-MediaBrowser-Token'] = token;
      }
    } else {
      // emby
      if (tokenLoc === 'query') {
        params['X-Emby-Token'] = token;
      } else {
        headers['X-Emby-Token'] = token;
      }
    }
    return { headers, params };
  }

  function pickJellyfinOrEmbyUserId(users = []) {
    const arr = Array.isArray(users) ? users : [];
    const admin = arr.find(u => u && u.Policy && u.Policy.IsAdministrator && u.Id);
    if (admin && admin.Id) return String(admin.Id);
    const first = arr.find(u => u && u.Id);
    return first && first.Id ? String(first.Id) : '';
  }

  function buildJellyfinOrEmbyRecentlyAddedItem(server, it) {
    if (!server || !it) return null;
    const rawType = String(it.Type || it.MediaType || '').trim();
    if (rawType !== 'Movie' && rawType !== 'Episode') return null;

    const isEpisode = rawType === 'Episode';
    const seasonNumber = typeof it.ParentIndexNumber === 'number' ? it.ParentIndexNumber : null;
    const episodeNumber = typeof it.IndexNumber === 'number' ? it.IndexNumber : null;
    const showTitle = isEpisode ? (it.SeriesName || null) : null;
    const seasonTitle = isEpisode ? (it.SeasonName || null) : null;

    let title;
    if (isEpisode || it.SeriesName) {
      const series = it.SeriesName || '';
      const epName = it.Name || '';
      let epLabel = '';
      if (seasonNumber !== null && episodeNumber !== null) {
        epLabel = `S${String(seasonNumber).padStart(2, '0')}E${String(episodeNumber).padStart(2, '0')}`;
      } else if (episodeNumber !== null) {
        epLabel = `E${String(episodeNumber).padStart(2, '0')}`;
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

    const addedAt = typeof it.DateCreated === 'string' && it.DateCreated ? it.DateCreated : new Date().toISOString();
    const runTimeTicks = typeof it.RunTimeTicks === 'number' ? it.RunTimeTicks : null;
    const durationMinutes = runTimeTicks && Number.isFinite(runTimeTicks) ? (runTimeTicks / 600000000) : null;

    const itemId = it.Id != null ? String(it.Id) : '';
    const imagePath = itemId ? `/Items/${encodeURIComponent(itemId)}/Images/Primary` : '';
    const thumbProxyPath = (itemId && imagePath)
      ? `/api/poster?serverId=${encodeURIComponent(String(server.id))}&path=${encodeURIComponent(imagePath)}`
      : '';

    return {
      serverId: server.id,
      serverName: server.name || server.baseUrl,
      type: rawType.toLowerCase(),
      title,
      showTitle,
      seasonTitle,
      seasonNumber,
      episodeNumber,
      year: typeof it.ProductionYear === 'number' ? it.ProductionYear : null,
      durationMinutes,
      genres: Array.isArray(it.Genres) ? it.Genres.map(g => String(g)).filter(Boolean) : [],
      summary: typeof it.Overview === 'string' ? it.Overview : '',
      ratingKey: itemId || null,
      thumb: '',
      thumbProxyPath,
      addedAt
    };
  }

  async function fetchJellyfinOrEmbyRecentlyAddedForServer(server, { perServer = 10 } = {}) {
    try {
      if (!server || !server.baseUrl || !server.token) return [];
      const base = String(server.baseUrl).replace(/\/$/, '');
      const auth = getJellyfinOrEmbyAuth(server);

      const usersResp = await axios.get(base + '/Users', {
        headers: auth.headers,
        params: auth.params,
        timeout: 15000
      });
      const users = Array.isArray(usersResp.data) ? usersResp.data : [];
      const userId = pickJellyfinOrEmbyUserId(users);
      if (!userId) return [];

      const itemsResp = await axios.get(base + `/Users/${encodeURIComponent(userId)}/Items`, {
        headers: auth.headers,
        timeout: 20000,
        params: {
          ...(auth.params || {}),
          IncludeItemTypes: 'Movie,Episode',
          Recursive: true,
          SortBy: 'DateCreated',
          SortOrder: 'Descending',
          Limit: perServer,
          Fields: 'Genres,Overview,ProductionYear,RunTimeTicks,DateCreated'
        }
      });
      const items = itemsResp.data && Array.isArray(itemsResp.data.Items) ? itemsResp.data.Items : [];
      return items
        .map(it => buildJellyfinOrEmbyRecentlyAddedItem(server, it))
        .filter(Boolean);
    } catch (e) {
      console.error(`[OmniStream] Failed to fetch recently added from ${server.type} server ${server.name || server.baseUrl}:`, e.message);
      return [];
    }
  }

  async function fetchUnifiedRecentlyAdded({ perServer = 10, serverId = '' } = {}) {
    const wantedId = serverId != null ? String(serverId).trim() : '';

    if (wantedId) {
      const server = servers.find(s => s && String(s.id) === wantedId);
      if (!server || server.disabled) return [];
      if (server.type === 'plex') {
        return fetchPlexRecentlyAdded({ perServer, serverId: wantedId });
      }
      if (server.type === 'jellyfin' || server.type === 'emby') {
        return fetchJellyfinOrEmbyRecentlyAddedForServer(server, { perServer });
      }
      return [];
    }

    const enabled = servers.filter(s => s && !s.disabled);
    const plex = enabled.some(s => s.type === 'plex') ? await fetchPlexRecentlyAdded({ perServer }) : [];

    const others = [];
    for (const s of enabled) {
      if (s.type === 'jellyfin' || s.type === 'emby') {
        const part = await fetchJellyfinOrEmbyRecentlyAddedForServer(s, { perServer });
        others.push(...part);
      }
    }

    const combined = [...plex, ...others];
    combined.sort((a, b) => {
      const ta = a && a.addedAt ? (Date.parse(a.addedAt) || 0) : 0;
      const tb = b && b.addedAt ? (Date.parse(b.addedAt) || 0) : 0;
      return tb - ta;
    });
    return combined;
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
    limit,
    page,
    pageSize,
    unique,
    includeStats
  } = req.query;

  const isUnique = ['1', 'true', 'yes', 'on'].includes(String(unique || '').toLowerCase());
  const wantStats = ['1', 'true', 'yes', 'on'].includes(String(includeStats || '').toLowerCase());

  const pageNum = Math.max(0, parseInt(String(page || '0'), 10) || 0);
  let size = parseInt(String(pageSize || ''), 10);
  if (!Number.isFinite(size) || size <= 0) {
    // Back-compat: legacy callers use `limit`
    size = parseInt(String(limit || ''), 10);
  }
  if (!Number.isFinite(size) || size <= 0) size = 100;
  size = Math.max(1, Math.min(size, 250));
  const offset = pageNum * size;

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

  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  let orderBy = 'time DESC';
  const dir = String(order).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
  if (sort === 'bandwidth') {
    orderBy = `bandwidth ${dir}`;
  } else {
    orderBy = `time ${dir}`;
  }

  const selectCols = 'time, endedAt, lastSeenAt, sessionKey, serverId, serverName, type, user, userAvatar, title, stream, transcoding, location, bandwidth, platform, product, player, quality, duration, progress, ip, completed';

  const baseParams = [...params];
  let querySql;
  let queryParams;
  if (isUnique) {
    const uniqueSub = `SELECT MAX(id) AS id FROM history ${whereSql} GROUP BY serverId, user, title, stream, location, COALESCE(ip,'')`;
    querySql = `SELECT ${selectCols} FROM history h INNER JOIN (${uniqueSub}) u ON h.id = u.id ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
    queryParams = [...baseParams, size + 1, offset];
  } else {
    querySql = `SELECT ${selectCols} FROM history ${whereSql} ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
    queryParams = [...baseParams, size + 1, offset];
  }

  const statsSqlForMode = () => {
    const watchedExpr = `CASE
      WHEN duration IS NOT NULL AND duration > 0 AND progress IS NOT NULL AND progress > 0
      THEN CASE
        WHEN CAST(ROUND(duration * (progress / 100.0)) AS INTEGER) > duration THEN duration
        ELSE CAST(ROUND(duration * (progress / 100.0)) AS INTEGER)
      END
      ELSE 0
    END`;

    if (isUnique) {
      const uniqueSub = `SELECT MAX(id) AS id FROM history ${whereSql} GROUP BY serverId, user, title, stream, location, COALESCE(ip,'')`;
      return {
        sql: `SELECT
                COUNT(*) AS total,
                COUNT(DISTINCT LOWER(h.user)) AS uniqueUsers,
                COUNT(DISTINCT LOWER(h.title)) AS uniqueTitles,
                SUM(${watchedExpr}) AS watchSeconds
              FROM history h INNER JOIN (${uniqueSub}) u ON h.id = u.id`,
        params: [...baseParams]
      };
    }

    return {
      sql: `SELECT
              COUNT(*) AS total,
              COUNT(DISTINCT LOWER(user)) AS uniqueUsers,
              COUNT(DISTINCT LOWER(title)) AS uniqueTitles,
              SUM(${watchedExpr}) AS watchSeconds
            FROM history ${whereSql}`,
      params: [...baseParams]
    };
  };

  const send = (history, hasMore, stats) => {
    res.json({
      page: pageNum,
      pageSize: size,
      hasMore: !!hasMore,
      unique: isUnique,
      stats: stats || undefined,
      history
    });
  };

  historyDb.all(querySql, queryParams, (err, rows) => {
    if (err) {
      console.error('Failed to query history database:', err.message);
      return res.status(500).json({ history: [] });
    }

    const hasMore = Array.isArray(rows) && rows.length > size;
    const sliced = hasMore ? rows.slice(0, size) : rows;
    const history = sliced.map(r => ({
      time: r.time,
      endedAt: r.endedAt,
      lastSeenAt: r.lastSeenAt,
      sessionKey: r.sessionKey,
      serverId: r.serverId,
      serverName: r.serverName,
      type: r.type,
      user: r.user,
      userAvatar: r.userAvatar || undefined,
      title: r.title,
      stream: r.stream,
      transcoding: typeof r.transcoding === 'number' ? !!r.transcoding : undefined,
      location: r.location,
      bandwidth: typeof r.bandwidth === 'number' ? r.bandwidth : 0,
      platform: r.platform,
      product: r.product,
      player: r.player,
      quality: r.quality,
      duration: typeof r.duration === 'number' ? r.duration : 0,
      progress: typeof r.progress === 'number' ? r.progress : 0,
      ip: r.ip,
      completed: typeof r.completed === 'number' ? !!r.completed : undefined
    }));

    if (!wantStats) {
      return send(history, hasMore, null);
    }

    const st = statsSqlForMode();
    historyDb.get(st.sql, st.params, (e2, row) => {
      if (e2) {
        console.error('Failed to compute history stats:', e2.message);
        return send(history, hasMore, null);
      }
      const stats = {
        totalPlays: row && typeof row.total === 'number' ? row.total : 0,
        uniqueUsers: row && typeof row.uniqueUsers === 'number' ? row.uniqueUsers : 0,
        uniqueTitles: row && typeof row.uniqueTitles === 'number' ? row.uniqueTitles : 0,
        watchSeconds: row && typeof row.watchSeconds === 'number' ? row.watchSeconds : 0
      };
      return send(history, hasMore, stats);
    });
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
    const authCfg = getAuthConfig();
    const authMode = normalizeAuthMode(authCfg.mode);
    const overseerrCfg = appConfig.overseerr || {};
    const rawSchedules = Array.isArray(appConfig.newsletterSchedules) ? appConfig.newsletterSchedules : [];
    const normalizedSchedules = rawSchedules.length
      ? rawSchedules.map((s, idx) => ({
        id: s && s.id != null ? String(s.id) : `sched-${idx + 1}`,
        serverId: s && s.serverId != null ? String(s.serverId) : '',
        enabled: s && s.enabled === true,
        templateId: s && s.templateId != null ? String(s.templateId) : DEFAULT_NEWSLETTER_TEMPLATE_ID,
        dayOfWeek: normalizeDayOfWeek(s && s.dayOfWeek),
        time: normalizeTimeHHMM(s && s.time) || '09:00',
        lastSentDate: s && s.lastSentDate ? String(s.lastSentDate) : ''
      }))
      : [
        {
          id: 'default',
          serverId: '',
          enabled: appConfig.newsletterSchedule?.enabled === true,
          templateId: appConfig.newsletterSchedule?.templateId != null ? String(appConfig.newsletterSchedule.templateId) : DEFAULT_NEWSLETTER_TEMPLATE_ID,
          dayOfWeek: normalizeDayOfWeek(appConfig.newsletterSchedule?.dayOfWeek),
          time: normalizeTimeHHMM(appConfig.newsletterSchedule?.time) || '09:00',
          lastSentDate: appConfig.newsletterSchedule?.lastSentDate || ''
        }
      ];
    res.json({
      maxHistory: typeof MAX_HISTORY === 'number' ? MAX_HISTORY : DEFAULT_MAX_HISTORY,
      auth: {
        mode: authMode
      },
      publicBaseUrl: (appConfig && typeof appConfig.publicBaseUrl === 'string') ? String(appConfig.publicBaseUrl) : '',
      overseerr: {
        baseUrl: overseerrCfg.baseUrl || '',
        hasApiKey: !!overseerrCfg.apiKey
      },
      newsletterBranding: {
        logoUrl: (appConfig && appConfig.newsletterBranding && typeof appConfig.newsletterBranding.logoUrl === 'string')
          ? String(appConfig.newsletterBranding.logoUrl)
          : ''
      },
      newsletterEmail: {
        enabled: appConfig.newsletterEmail?.enabled !== false,
        from: appConfig.newsletterEmail?.from || '',
        to: appConfig.newsletterEmail?.to || ''
      },
      newsletterSchedule: {
        enabled: appConfig.newsletterSchedule?.enabled === true,
        templateId: appConfig.newsletterSchedule?.templateId != null ? String(appConfig.newsletterSchedule.templateId) : DEFAULT_NEWSLETTER_TEMPLATE_ID,
        dayOfWeek: normalizeDayOfWeek(appConfig.newsletterSchedule?.dayOfWeek),
        time: normalizeTimeHHMM(appConfig.newsletterSchedule?.time) || '09:00',
        lastSentDate: appConfig.newsletterSchedule?.lastSentDate || ''
      },
      newsletterSchedules: normalizedSchedules,
      newsletterCustomSections: Array.isArray(appConfig.newsletterCustomSections)
        ? appConfig.newsletterCustomSections.map((s, idx) => ({
          id: s && s.id != null ? String(s.id) : `sec-${idx + 1}`,
          header: s && typeof s.header === 'string' ? s.header : '',
          headerSize: normalizeCustomHeaderSize(s && s.headerSize),
          headerColor: normalizeHexColor(s && s.headerColor) || '#e5e7eb',
          columnCount: (() => {
            let cc = parseInt((s && s.columnCount != null) ? s.columnCount : 3, 10);
            if (![1, 2, 3].includes(cc)) cc = 3;
            return cc;
          })(),
          columns: Array.isArray(s && s.columns)
            ? [
              normalizeCustomHeaderColumn(s.columns[0]),
              normalizeCustomHeaderColumn(s.columns[1]),
              normalizeCustomHeaderColumn(s.columns[2])
            ]
            : [normalizeCustomHeaderColumn(''), normalizeCustomHeaderColumn(''), normalizeCustomHeaderColumn('')]
        }))
        : [],
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

    // Auth mode toggle
    if (Object.prototype.hasOwnProperty.call(body, 'authMode')) {
      const nextMode = normalizeAuthMode(body.authMode);
      if (!appConfig.auth || typeof appConfig.auth !== 'object') {
        appConfig.auth = {};
      }
      appConfig.auth.mode = nextMode;
      // If switching to internal and no password has ever been set, seed the default.
      if (nextMode === 'internal' && !appConfig.auth.passwordHash) {
        appConfig.auth.username = appConfig.auth.username || 'admin';
        appConfig.auth.passwordHash = pbkdf2HashPassword('omnistream');
        appConfig.auth.passwordChangeRequired = true;
      }
    }

    if (Object.prototype.hasOwnProperty.call(body, 'publicBaseUrl')) {
      const v = body.publicBaseUrl;
      if (v === null) {
        delete appConfig.publicBaseUrl;
      } else if (typeof v === 'string') {
        const normalized = normalizePublicBaseUrl(v);
        if (!normalized && v.trim()) {
          return res.status(400).json({ error: 'publicBaseUrl must be an absolute http(s) URL (for example https://example.com)' });
        }
        if (normalized) {
          appConfig.publicBaseUrl = normalized;
        } else {
          delete appConfig.publicBaseUrl;
        }
      }
    }

    if (body.newsletterBranding && typeof body.newsletterBranding === 'object') {
      const incoming = body.newsletterBranding;
      const current = (appConfig.newsletterBranding && typeof appConfig.newsletterBranding === 'object') ? appConfig.newsletterBranding : {};
      const next = { ...current };
      if (Object.prototype.hasOwnProperty.call(incoming, 'logoUrl')) {
        const v = incoming.logoUrl;
        next.logoUrl = normalizeNewsletterLogoUrl(v);
      }
      appConfig.newsletterBranding = next;
    }

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

    // Newsletter custom sections (header + 3 columns)
    if (Object.prototype.hasOwnProperty.call(body, 'newsletterCustomSections')) {
      const raw = body.newsletterCustomSections;
      if (Array.isArray(raw)) {
        appConfig.newsletterCustomSections = raw.map((s, idx) => {
          const header = s && typeof s.header === 'string' ? s.header : '';
          const headerSize = normalizeCustomHeaderSize(s && s.headerSize);
          const headerColor = normalizeHexColor(s && s.headerColor) || '#e5e7eb';

          let columnCount = parseInt((s && s.columnCount != null) ? s.columnCount : 3, 10);
          if (![1, 2, 3].includes(columnCount)) columnCount = 3;

          const cols = s && Array.isArray(s.columns) ? s.columns : [];
          const c1 = normalizeCustomHeaderColumn(cols[0]);
          const c2 = normalizeCustomHeaderColumn(cols[1]);
          const c3 = normalizeCustomHeaderColumn(cols[2]);
          return {
            id: s && s.id != null ? String(s.id) : `sec-${idx + 1}`,
            header,
            headerSize,
            headerColor,
            columnCount,
            columns: [c1, c2, c3]
          };
        });
      }
    }

    // Multiple weekly newsletter schedules (per-server)
    if (Object.prototype.hasOwnProperty.call(body, 'newsletterSchedules')) {
      const raw = body.newsletterSchedules;
      if (raw === null) {
        delete appConfig.newsletterSchedules;
      } else if (Array.isArray(raw)) {
        appConfig.newsletterSchedules = raw.map((s, idx) => {
          const templateId = s && s.templateId != null ? String(s.templateId) : '';
          const time = normalizeTimeHHMM(s && s.time) || '09:00';
          return {
            id: s && s.id != null ? String(s.id) : `sched-${idx + 1}`,
            serverId: s && s.serverId != null ? String(s.serverId).trim() : '',
            enabled: s && s.enabled === true,
            templateId,
            dayOfWeek: normalizeDayOfWeek(s && s.dayOfWeek),
            time,
            lastSentDate: normalizeDateInput(s && s.lastSentDate) || ''
          };
        });
      }
    }

    // Weekly newsletter schedule
    if (Object.prototype.hasOwnProperty.call(body, 'newsletterSchedule')) {
      const incoming = body.newsletterSchedule && typeof body.newsletterSchedule === 'object' ? body.newsletterSchedule : {};
      const current = appConfig.newsletterSchedule && typeof appConfig.newsletterSchedule === 'object' ? appConfig.newsletterSchedule : {};
      const next = { ...current };

      if (Object.prototype.hasOwnProperty.call(incoming, 'enabled')) {
        next.enabled = incoming.enabled === true;
      }
      if (Object.prototype.hasOwnProperty.call(incoming, 'templateId')) {
        next.templateId = incoming.templateId != null ? String(incoming.templateId) : '';
      }
      if (Object.prototype.hasOwnProperty.call(incoming, 'dayOfWeek')) {
        next.dayOfWeek = normalizeDayOfWeek(incoming.dayOfWeek);
      }
      if (Object.prototype.hasOwnProperty.call(incoming, 'time')) {
        const t = normalizeTimeHHMM(incoming.time);
        next.time = t || next.time || '09:00';
      }
      if (Object.prototype.hasOwnProperty.call(incoming, 'lastSentDate')) {
        // Allow manual reset/override if needed
        next.lastSentDate = normalizeDateInput(incoming.lastSentDate);
      }
      appConfig.newsletterSchedule = next;
    }

    saveAppConfigToDisk();

    const overseerrCfg = appConfig.overseerr || {};
    const rawSchedules = Array.isArray(appConfig.newsletterSchedules) ? appConfig.newsletterSchedules : [];
    const normalizedSchedules = rawSchedules.length
      ? rawSchedules.map((s, idx) => ({
        id: s && s.id != null ? String(s.id) : `sched-${idx + 1}`,
        serverId: s && s.serverId != null ? String(s.serverId) : '',
        enabled: s && s.enabled === true,
        templateId: s && s.templateId != null ? String(s.templateId) : DEFAULT_NEWSLETTER_TEMPLATE_ID,
        dayOfWeek: normalizeDayOfWeek(s && s.dayOfWeek),
        time: normalizeTimeHHMM(s && s.time) || '09:00',
        lastSentDate: s && s.lastSentDate ? String(s.lastSentDate) : ''
      }))
      : [
        {
          id: 'default',
          serverId: '',
          enabled: appConfig.newsletterSchedule?.enabled === true,
          templateId: appConfig.newsletterSchedule?.templateId != null ? String(appConfig.newsletterSchedule.templateId) : DEFAULT_NEWSLETTER_TEMPLATE_ID,
          dayOfWeek: normalizeDayOfWeek(appConfig.newsletterSchedule?.dayOfWeek),
          time: normalizeTimeHHMM(appConfig.newsletterSchedule?.time) || '09:00',
          lastSentDate: appConfig.newsletterSchedule?.lastSentDate || ''
        }
      ];
    res.json({
      maxHistory: typeof MAX_HISTORY === 'number' ? MAX_HISTORY : DEFAULT_MAX_HISTORY,
      auth: {
        mode: normalizeAuthMode(getAuthConfig().mode)
      },
      publicBaseUrl: (appConfig && typeof appConfig.publicBaseUrl === 'string') ? String(appConfig.publicBaseUrl) : '',
      overseerr: {
        baseUrl: overseerrCfg.baseUrl || '',
        hasApiKey: !!overseerrCfg.apiKey
      },
      newsletterBranding: {
        logoUrl: (appConfig && appConfig.newsletterBranding && typeof appConfig.newsletterBranding.logoUrl === 'string')
          ? String(appConfig.newsletterBranding.logoUrl)
          : ''
      },
      newsletterEmail: {
        enabled: appConfig.newsletterEmail?.enabled !== false,
        from: appConfig.newsletterEmail?.from || '',
        to: appConfig.newsletterEmail?.to || ''
      },
      newsletterSchedule: {
        enabled: appConfig.newsletterSchedule?.enabled === true,
        templateId: appConfig.newsletterSchedule?.templateId != null ? String(appConfig.newsletterSchedule.templateId) : DEFAULT_NEWSLETTER_TEMPLATE_ID,
        dayOfWeek: normalizeDayOfWeek(appConfig.newsletterSchedule?.dayOfWeek),
        time: normalizeTimeHHMM(appConfig.newsletterSchedule?.time) || '09:00',
        lastSentDate: appConfig.newsletterSchedule?.lastSentDate || ''
      },
      newsletterSchedules: normalizedSchedules,
      newsletterCustomSections: Array.isArray(appConfig.newsletterCustomSections)
        ? appConfig.newsletterCustomSections.map((s, idx) => ({
          id: s && s.id != null ? String(s.id) : `sec-${idx + 1}`,
          header: s && typeof s.header === 'string' ? s.header : '',
          headerSize: normalizeCustomHeaderSize(s && s.headerSize),
          headerColor: normalizeHexColor(s && s.headerColor) || '#e5e7eb',
          columnCount: (() => {
            let cc = parseInt((s && s.columnCount != null) ? s.columnCount : 3, 10);
            if (![1, 2, 3].includes(cc)) cc = 3;
            return cc;
          })(),
          columns: Array.isArray(s && s.columns)
            ? [
              normalizeCustomHeaderColumn(s.columns[0]),
              normalizeCustomHeaderColumn(s.columns[1]),
              normalizeCustomHeaderColumn(s.columns[2])
            ]
            : [normalizeCustomHeaderColumn(''), normalizeCustomHeaderColumn(''), normalizeCustomHeaderColumn('')]
        }))
        : [],
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

function listenWithFallback(startPort) {
  const usingDefaultPort = !process.env.PORT;
  const maxAttempts = 20;
  const basePort = Number(startPort);
  const resolvedBasePort = Number.isFinite(basePort) ? basePort : 3000;

  let attempt = 0;
  const tryListen = (port) => {
    const server = app.listen(port, () => {
      console.log(`OmniStream listening on port ${port}`);
    });
    server.on('error', (err) => {
      if (err && err.code === 'EADDRINUSE' && usingDefaultPort && attempt < maxAttempts) {
        attempt++;
        const nextPort = port + 1;
        console.warn(`[OmniStream] Port ${port} in use; trying ${nextPort}...`);
        try {
          server.close(() => tryListen(nextPort));
        } catch {
          tryListen(nextPort);
        }
        return;
      }

      console.error('[OmniStream] Server failed to start:', err && err.message ? err.message : err);
      process.exit(1);
    });
  };

  tryListen(resolvedBasePort);
}

listenWithFallback(PORT);

// In-process scheduler: checks once per minute whether a weekly newsletter is due.
setInterval(() => {
  runNewsletterScheduleIfDue();
}, 60 * 1000);

// In-process update checker: checks GitHub releases on a randomized schedule.
// This avoids frequent polling while still being reliable.
function scheduleNextUpdateCheck(isStartup) {
  const minDelayMs = isStartup ? (60 * 1000) : (6 * 60 * 60 * 1000);
  const maxDelayMs = isStartup ? (10 * 60 * 1000) : (12 * 60 * 60 * 1000);
  const delay = minDelayMs + Math.floor(Math.random() * (maxDelayMs - minDelayMs + 1));
  setTimeout(async () => {
    await maybeCheckForUpdates({ force: true });
    scheduleNextUpdateCheck(false);
  }, delay);
}

scheduleNextUpdateCheck(true);
