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
    const pkgText = rawPkg ? String(rawPkg).replace(/^\uFEFF/, '').trim() : '';
    if (pkgText) {
      const pkg = JSON.parse(pkgText);
      appVersion = pkg.version || null;
    }
  }
} catch (e) {
  console.error('[OmniStream] Failed to read package.json version:', e.message);
  appVersion = null;
}

let appConfig = {};
let peakConcurrentStreamsAllTime = null;
try {
  if (fs.existsSync(CONFIG_FILE)) {
    const rawCfg = fs.readFileSync(CONFIG_FILE, 'utf8');
    const cfgText = rawCfg ? String(rawCfg).replace(/^\uFEFF/, '').trim() : '';
    appConfig = cfgText ? JSON.parse(cfgText) : {};
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
      const serversText = raw ? String(raw).replace(/^\uFEFF/, '').trim() : '';
      servers = serversText ? JSON.parse(serversText) : [];
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

function base64UrlEncode(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64UrlDecode(str) {
  const s = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s + pad, 'base64');
}

function getAuthSessionSecret() {
  const authCfg = getAuthConfig();
  const secret = authCfg && typeof authCfg.sessionSecret === 'string' ? authCfg.sessionSecret.trim() : '';
  return secret;
}

function getAuthPasswordFingerprint() {
  const authCfg = getAuthConfig();
  const storedHash = String(authCfg.passwordHash || '');
  if (!storedHash) return '';
  return crypto.createHash('sha256').update(storedHash, 'utf8').digest('hex').slice(0, 16);
}

function signSessionPayload(payloadB64) {
  const secret = getAuthSessionSecret();
  if (!secret) return '';
  const sig = crypto.createHmac('sha256', Buffer.from(secret, 'utf8')).update(String(payloadB64)).digest();
  return base64UrlEncode(sig);
}

function timingSafeEqualStr(a, b) {
  try {
    const aa = Buffer.from(String(a || ''), 'utf8');
    const bb = Buffer.from(String(b || ''), 'utf8');
    if (aa.length !== bb.length) return false;
    return crypto.timingSafeEqual(aa, bb);
  } catch {
    return false;
  }
}

function createSignedSessionToken(username) {
  const now = Date.now();
  const payload = {
    v: 1,
    u: String(username || ''),
    iat: now,
    exp: now + AUTH_SESSION_TTL_MS,
    ph: getAuthPasswordFingerprint()
  };
  const payloadB64 = base64UrlEncode(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sigB64 = signSessionPayload(payloadB64);
  if (!sigB64) return '';
  return `${payloadB64}.${sigB64}`;
}

function verifySignedSessionToken(token) {
  try {
    const raw = String(token || '').trim();
    const idx = raw.indexOf('.');
    if (idx === -1) return null;
    const payloadB64 = raw.slice(0, idx);
    const sigB64 = raw.slice(idx + 1);
    if (!payloadB64 || !sigB64) return null;

    const expectedSig = signSessionPayload(payloadB64);
    if (!expectedSig || !timingSafeEqualStr(expectedSig, sigB64)) return null;

    const payloadRaw = base64UrlDecode(payloadB64).toString('utf8');
    const payload = JSON.parse(payloadRaw);
    if (!payload || typeof payload !== 'object') return null;
    if (payload.v !== 1) return null;

    const u = typeof payload.u === 'string' ? payload.u : '';
    const iat = typeof payload.iat === 'number' ? payload.iat : 0;
    const exp = typeof payload.exp === 'number' ? payload.exp : 0;
    const ph = typeof payload.ph === 'string' ? payload.ph : '';

    if (!u || !iat || !exp) return null;
    const now = Date.now();
    if (exp <= now) return null;
    // Defensive: reject tokens with extreme timestamps.
    if (iat > now + 5 * 60 * 1000) return null;

    const authCfg = getAuthConfig();
    const expectedUser = String(authCfg.username || 'admin');
    if (u !== expectedUser) return null;
    if (ph && ph !== getAuthPasswordFingerprint()) return null;

    return { username: u, createdAtMs: iat, expiresAtMs: exp };
  } catch {
    return null;
  }
}

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

    // Seed a stable session signing secret so login can persist across restarts.
    // (Without this, session cookies become invalid after each restart.)
    if (!appConfig.auth.sessionSecret) {
      appConfig.auth.sessionSecret = crypto.randomBytes(32).toString('hex');
      try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(appConfig, null, 2));
        console.log('[OmniStream] Seeded internal auth session secret into config.json');
      } catch (e) {
        console.error('[OmniStream] Failed to persist auth session secret:', e.message);
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

function getBearerTokenFromReq(req) {
  try {
    const raw = String(req.headers.authorization || '').trim();
    if (!raw) return '';
    const m = raw.match(/^Bearer\s+(.+)$/i);
    return m && m[1] ? String(m[1]).trim() : '';
  } catch (_) {
    return '';
  }
}

function getSessionForReq(req) {
  const bearer = getBearerTokenFromReq(req);
  if (bearer && bearer.includes('.')) {
    const verified = verifySignedSessionToken(bearer);
    if (verified) {
      return { sid: bearer, username: verified.username, createdAtMs: verified.createdAtMs, lastSeenAtMs: Date.now() };
    }
  }

  const sid = getSessionIdFromReq(req);
  if (!sid) return null;
  // New format: signed token in cookie (survives restarts).
  if (sid.includes('.')) {
    const verified = verifySignedSessionToken(sid);
    if (!verified) return null;
    return { sid, username: verified.username, createdAtMs: verified.createdAtMs, lastSeenAtMs: Date.now() };
  }
  // Legacy format: in-memory session id.
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
        // Allow signed thumbnail proxy requests for email clients without cookies.
        // Signature is validated inside the route handler.
        if (p === '/api/newsletter/plex/thumb') {
          const sig = typeof req.query.sig === 'string' ? String(req.query.sig).trim() : '';
          const exp = typeof req.query.exp === 'string' || typeof req.query.exp === 'number' ? String(req.query.exp).trim() : '';
          if (sig && exp) return next();
        }
        if (p === '/api/newsletter/plex/thumb/signed') {
          const sig = typeof req.query.sig === 'string' ? String(req.query.sig).trim() : '';
          const exp = typeof req.query.exp === 'string' || typeof req.query.exp === 'number' ? String(req.query.exp).trim() : '';
          if (sig && exp) return next();
        }
        // Allow signed poster proxy requests for email clients without cookies.
        // Signature is validated inside the route handler.
        if (p === '/api/poster') {
          const sig = typeof req.query.sig === 'string' ? String(req.query.sig).trim() : '';
          const exp = typeof req.query.exp === 'string' || typeof req.query.exp === 'number' ? String(req.query.exp).trim() : '';
          if (sig && exp) return next();
        }
        if (p === '/api/poster/signed') {
          const sig = typeof req.query.sig === 'string' ? String(req.query.sig).trim() : '';
          const exp = typeof req.query.exp === 'string' || typeof req.query.exp === 'number' ? String(req.query.exp).trim() : '';
          if (sig && exp) return next();
        }
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

// Avoid noisy 404s for browsers requesting a favicon.
app.get('/favicon.ico', (req, res) => {
  try {
    const ico = path.join(__dirname, 'public', 'favicon.ico');
    if (fs.existsSync(ico)) {
      return res.sendFile(ico);
    }
  } catch (_) {
    // ignore
  }
  res.status(204).end();
});

// Now that auth gate is installed, serve the static UI.
// Prevent stale cached HTML from making UI changes appear broken.
app.use((req, res, next) => {
  try {
    if (req.method === 'GET' && req.path && req.path.endsWith('.html')) {
      res.set('Cache-Control', 'no-store');
    }
  } catch (_) {
    // ignore
  }
  next();
});
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

    const token = createSignedSessionToken(expectedUser);
    if (!token) {
      return res.status(500).json({ error: 'Login failed (session secret missing)' });
    }
    setSessionCookie(res, token, { secure: shouldUseSecureCookie(req) });
    return res.json({ ok: true, mustChangePassword: authCfg.passwordChangeRequired === true });
  } catch (e) {
    console.error('[OmniStream] login failed:', e.message);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Token login for native clients (no cookies). Returns the same signed session token used in cookies.
app.post('/api/auth/token', (req, res) => {
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

    const token = createSignedSessionToken(expectedUser);
    if (!token) {
      return res.status(500).json({ error: 'Token issuance failed (session secret missing)' });
    }

    const verified = verifySignedSessionToken(token);
    return res.json({
      ok: true,
      token,
      expiresAtMs: verified ? verified.expiresAtMs : null,
      mustChangePassword: authCfg.passwordChangeRequired === true
    });
  } catch (e) {
    console.error('[OmniStream] token login failed:', e.message);
    res.status(500).json({ error: 'Token login failed' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  try {
    const sid = getSessionIdFromReq(req);
    if (sid && !sid.includes('.')) authSessions.delete(sid);
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

    // Issue a fresh session token so the user stays logged in after password change.
    const expectedUser = String(appConfig.auth.username || 'admin');
    const token = createSignedSessionToken(expectedUser);
    if (token) {
      setSessionCookie(res, token, { secure: shouldUseSecureCookie(req) });
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
    if (sid && !sid.includes('.')) authSessions.delete(sid);
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
// Ensure backup config exists (default OFF to avoid unexpected disk usage)
if (!appConfig.backups || typeof appConfig.backups !== 'object') {
  appConfig.backups = {};
}
if (!appConfig.backups.historyDb || typeof appConfig.backups.historyDb !== 'object') {
  appConfig.backups.historyDb = { interval: 'off', keep: 30 };
}
if (typeof appConfig.backups.historyDb.interval !== 'string') {
  appConfig.backups.historyDb.interval = 'off';
}
if (typeof appConfig.backups.historyDb.keep !== 'number' || !Number.isFinite(appConfig.backups.historyDb.keep) || appConfig.backups.historyDb.keep < 1) {
  appConfig.backups.historyDb.keep = 30;
}

// Ensure reports config exists
if (!appConfig.reports || typeof appConfig.reports !== 'object') {
  appConfig.reports = {};
}
if (!appConfig.reports.peakConcurrentStreams || typeof appConfig.reports.peakConcurrentStreams !== 'object') {
  appConfig.reports.peakConcurrentStreams = {
    streams: 0,
    transcodes: 0,
    directStreams: 0,
    directPlays: 0,
    updatedAt: ''
  };
}
for (const k of ['streams', 'transcodes', 'directStreams', 'directPlays']) {
  const v = Number(appConfig.reports.peakConcurrentStreams[k]);
  appConfig.reports.peakConcurrentStreams[k] = Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}
if (typeof appConfig.reports.peakConcurrentStreams.updatedAt !== 'string') {
  appConfig.reports.peakConcurrentStreams.updatedAt = '';
}

// Cache the all-time peak in memory so peaks don't drop even if config.json is read-only.
if (!peakConcurrentStreamsAllTime || typeof peakConcurrentStreamsAllTime !== 'object') {
  peakConcurrentStreamsAllTime = { ...appConfig.reports.peakConcurrentStreams };
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

const DEFAULT_NEWSLETTER_THUMB_TTL_DAYS = 30;
const DEFAULT_NEWSLETTER_SIGNING_SECRET_ENV = 'OMNISTREAM_NEWSLETTER_SIGNING_SECRET';

function base64UrlEncode(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function getNewsletterSigningSecret() {
  // Priority:
  // 1) Env var (works even in read-only deployments)
  // 2) Config value (persisted in config.json)
  // 3) Derived from auth.passwordHash (stable if config is readable)
  try {
    const fromEnv = String(process.env[DEFAULT_NEWSLETTER_SIGNING_SECRET_ENV] || '').trim();
    if (fromEnv) return fromEnv;
  } catch (_) {}
  try {
    const raw = appConfig && typeof appConfig.newsletterThumbSigningSecret === 'string'
      ? appConfig.newsletterThumbSigningSecret.trim()
      : '';
    if (raw) return raw;
  } catch (_) {}
  try {
    const authHash = appConfig && appConfig.auth && typeof appConfig.auth.passwordHash === 'string'
      ? String(appConfig.auth.passwordHash)
      : '';
    if (authHash) {
      return crypto.createHash('sha256').update(authHash, 'utf8').digest('hex');
    }
  } catch (_) {}
  return '';
}

function ensureNewsletterThumbSigningSecret() {
  // Legacy name kept because callers assume it may persist a config value.
  try {
    const existing = getNewsletterSigningSecret();
    if (existing) return existing;
    if (!appConfig || typeof appConfig !== 'object') appConfig = {};
    appConfig.newsletterThumbSigningSecret = crypto.randomBytes(32).toString('hex');
    saveAppConfigToDisk();
    return String(appConfig.newsletterThumbSigningSecret || '').trim();
  } catch (e) {
    console.error('[OmniStream] Failed to ensure newsletterThumbSigningSecret:', e.message);
    return '';
  }
}

function signNewsletterThumbParams({ serverId, thumb, exp } = {}) {
  const secret = getNewsletterSigningSecret() || ensureNewsletterThumbSigningSecret();
  if (!secret) return '';
  const payload = `${String(serverId || '').trim()}\n${String(thumb || '').trim()}\n${String(exp || '').trim()}`;
  const mac = crypto.createHmac('sha256', secret).update(payload, 'utf8').digest();
  return base64UrlEncode(mac);
}

function verifyNewsletterThumbSignature({ serverId, thumb, exp, sig } = {}) {
  try {
    const expNum = Number(exp);
    if (!Number.isFinite(expNum)) return false;
    const nowSec = Math.floor(Date.now() / 1000);
    // allow small clock skew
    if (expNum < (nowSec - 60)) return false;
    const expected = signNewsletterThumbParams({ serverId, thumb, exp: expNum });
    if (!expected) return false;
    const a = Buffer.from(String(expected), 'utf8');
    const b = Buffer.from(String(sig || ''), 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch (_) {
    return false;
  }
}

function buildSignedNewsletterThumbUrl({ publicBaseUrl, serverId, thumb } = {}) {
  const base = String(publicBaseUrl || '').replace(/\/$/, '');
  if (!base || !serverId || !thumb) return '';
  const ttlDaysRaw = Number(appConfig && appConfig.newsletterThumbUrlTtlDays);
  const ttlDays = Number.isFinite(ttlDaysRaw) ? Math.max(1, Math.min(365, Math.floor(ttlDaysRaw))) : DEFAULT_NEWSLETTER_THUMB_TTL_DAYS;
  const exp = Math.floor(Date.now() / 1000) + ttlDays * 24 * 60 * 60;
  const sig = signNewsletterThumbParams({ serverId, thumb, exp });
  if (!sig) {
    return `${base}/api/newsletter/plex/thumb/signed?serverId=${encodeURIComponent(String(serverId))}&thumb=${encodeURIComponent(String(thumb))}`;
  }
  const q = new URLSearchParams({
    serverId: String(serverId),
    thumb: String(thumb),
    exp: String(exp),
    sig: String(sig)
  });
  return `${base}/api/newsletter/plex/thumb/signed?${q.toString()}`;
}

function signNewsletterPosterParams({ serverId, path: posterPath, exp } = {}) {
  const secret = getNewsletterSigningSecret() || ensureNewsletterThumbSigningSecret();
  if (!secret) return '';
  const payload = `${String(serverId || '').trim()}\n${String(posterPath || '').trim()}\n${String(exp || '').trim()}`;
  const mac = crypto.createHmac('sha256', secret).update(payload, 'utf8').digest();
  return base64UrlEncode(mac);
}

function verifyNewsletterPosterSignature({ serverId, path: posterPath, exp, sig } = {}) {
  try {
    const expNum = Number(exp);
    if (!Number.isFinite(expNum)) return false;
    const nowSec = Math.floor(Date.now() / 1000);
    if (expNum < (nowSec - 60)) return false;
    const expected = signNewsletterPosterParams({ serverId, path: posterPath, exp: expNum });
    if (!expected) return false;
    const a = Buffer.from(String(expected), 'utf8');
    const b = Buffer.from(String(sig || ''), 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch (_) {
    return false;
  }
}

function buildSignedNewsletterPosterUrl({ publicBaseUrl, serverId, path: posterPath } = {}) {
  const base = String(publicBaseUrl || '').replace(/\/$/, '');
  if (!base || !serverId || !posterPath) return '';
  const ttlDaysRaw = Number(appConfig && appConfig.newsletterThumbUrlTtlDays);
  const ttlDays = Number.isFinite(ttlDaysRaw) ? Math.max(1, Math.min(365, Math.floor(ttlDaysRaw))) : DEFAULT_NEWSLETTER_THUMB_TTL_DAYS;
  const exp = Math.floor(Date.now() / 1000) + ttlDays * 24 * 60 * 60;
  const sig = signNewsletterPosterParams({ serverId, path: posterPath, exp });
  if (!sig) {
    return `${base}/api/poster/signed?serverId=${encodeURIComponent(String(serverId))}&path=${encodeURIComponent(String(posterPath))}`;
  }
  const q = new URLSearchParams({
    serverId: String(serverId),
    path: String(posterPath),
    exp: String(exp),
    sig: String(sig)
  });
  return `${base}/api/poster/signed?${q.toString()}`;
}

function isSafeSentNewsletterId(id) {
  const s = String(id || '').trim();
  if (!s) return false;
  // These IDs are derived from the subject, so they often include spaces and punctuation.
  // Safety requirements here are about preventing path traversal and weird control chars,
  // not about restricting to URL-safe characters (callers should URL-encode).
  if (s.length > 240) return false;
  if (s.includes('\0')) return false;
  if (s.includes('/') || s.includes('\\')) return false;
  // Prevent sneaky dot-segments even if separators aren't present.
  if (s === '.' || s === '..') return false;
  return true;
}

function resolveSentNewsletterPath(id, ext) {
  if (!isSafeSentNewsletterId(id)) return null;
  const safeExt = String(ext || '').replace(/^\./, '');
  if (!/^[A-Za-z0-9]{1,10}$/.test(safeExt)) return null;

  const baseDir = path.resolve(SENT_NEWSLETTERS_DIR);
  const filePath = path.resolve(path.join(SENT_NEWSLETTERS_DIR, `${id}.${safeExt}`));
  if (filePath === baseDir) return null;
  if (!filePath.startsWith(baseDir + path.sep)) return null;
  return filePath;
}

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
    const type = rawType === 'url' ? 'url' : (rawType === 'email' ? 'email' : 'text');
    const value = typeof input.value === 'string' ? input.value : '';
    return { type, value };
  }
  return { type: 'text', value: '' };
}

function normalizeOneLineValue(input) {
  const raw = typeof input === 'string' ? input : '';
  if (!raw) return '';
  const lines = raw.split(/\r\n|\r|\n/);
  for (const line of lines) {
    const trimmed = String(line || '').trim();
    if (trimmed) return trimmed;
  }
  return '';
}

function looksLikeEmailAddress(input) {
  const s = String(input || '').trim();
  if (!s) return false;
  if (s.toLowerCase().startsWith('mailto:')) return true;
  // Deliberately permissive; just avoid spaces and require '@'.
  return /^[^\s@]+@[^\s@]+$/.test(s);
}

function renderOneLineColumnHtml(col, options = {}) {
  const normalized = normalizeCustomHeaderColumn(col);
  const type = normalized.type === 'url' ? 'url' : (normalized.type === 'email' ? 'email' : 'text');
  const value = normalizeOneLineValue(normalized.value);
  if (!value) return '';

  const linkColor = normalizeHexColor(options && options.linkColor) || '#E5A00D';

  if (type === 'url') {
    const href = safeLinkHref(value);
    if (href) {
      const escapedHref = escapeHtml(href);
      const escapedLabel = escapeHtml(value);
      return `<a href="${escapedHref}" target="_blank" rel="noopener noreferrer" style="color:${escapeHtml(linkColor)} !important;text-decoration:none;">${escapedLabel}</a>`;
    }
    return escapeHtml(value);
  }

  if (type === 'email') {
    const href = value.toLowerCase().startsWith('mailto:')
      ? value
      : (looksLikeEmailAddress(value) ? `mailto:${value}` : '');
    if (href) {
      const escapedHref = escapeHtml(href);
      const label = value.toLowerCase().startsWith('mailto:') ? value.slice('mailto:'.length) : value;
      const escapedLabel = escapeHtml(label);
      return `<a href="${escapedHref}" target="_blank" rel="noopener noreferrer" style="color:${escapeHtml(linkColor)} !important;text-decoration:none;">${escapedLabel}</a>`;
    }
    return escapeHtml(value);
  }

  return escapeHtml(value);
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
  const DEFAULT_CUSTOM_SECTION_ROW_COLOR = '#0b1226';
  const DEFAULT_CUSTOM_SECTION_ROW_TEXT_COLOR = '#e5e7eb';
  const cleaned = list
    .map((s) => {
      const header = s && typeof s.header === 'string' ? s.header.trim() : '';
      const headerSize = normalizeCustomHeaderSize(s && s.headerSize);
      const headerColor = normalizeHexColor(s && s.headerColor);

      const normalizeRow = (rowLike) => {
        let columnCount = parseInt((rowLike && rowLike.columnCount != null) ? rowLike.columnCount : 3, 10);
        if (![1, 2, 3].includes(columnCount)) columnCount = 3;

        const rowColor = normalizeHexColor(rowLike && rowLike.rowColor) || DEFAULT_CUSTOM_SECTION_ROW_COLOR;
        const rowTextColor = normalizeHexColor(rowLike && rowLike.rowTextColor) || DEFAULT_CUSTOM_SECTION_ROW_TEXT_COLOR;
        const boxed = !(rowLike && rowLike.boxed === false);

        const cols = rowLike && Array.isArray(rowLike.columns)
          ? rowLike.columns
          : (s && Array.isArray(s.columns) ? s.columns : []);

        const c1 = normalizeCustomHeaderColumn(cols[0]);
        const c2 = normalizeCustomHeaderColumn(cols[1]);
        const c3 = normalizeCustomHeaderColumn(cols[2]);

        // New requirement: each block is a single line.
        c1.value = normalizeOneLineValue(c1.value);
        c2.value = normalizeOneLineValue(c2.value);
        c3.value = normalizeOneLineValue(c3.value);

        const activeVals = columnCount === 1
          ? [c1.value]
          : (columnCount === 2 ? [c1.value, c2.value] : [c1.value, c2.value, c3.value]);
        const hasAny = activeVals.some(Boolean);
        return hasAny ? { columnCount, rowColor, rowTextColor, boxed, columns: [c1, c2, c3] } : null;
      };

      // Back-compat: old format stored a single row as { columnCount, columns }.
      const rawRows = s && Array.isArray(s.rows) ? s.rows : null;
      const rows = (rawRows && rawRows.length)
        ? rawRows.map(normalizeRow).filter(Boolean)
        : [normalizeRow({ columnCount: s && s.columnCount, columns: s && s.columns })].filter(Boolean);

      const hasAny = !!(header || rows.length);
      return hasAny ? { header, headerSize, headerColor, rows } : null;
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

    const rows = Array.isArray(sec.rows) ? sec.rows : [];
    const hasAnyRowData = rows.some((r) => {
      const cc = [1, 2, 3].includes(Number(r.columnCount)) ? Number(r.columnCount) : 3;
      const cols = Array.isArray(r.columns) ? r.columns : [];
      const v1 = normalizeOneLineValue(cols[0] && cols[0].value);
      const v2 = normalizeOneLineValue(cols[1] && cols[1].value);
      const v3 = normalizeOneLineValue(cols[2] && cols[2].value);
      return cc === 1 ? Boolean(v1) : (cc === 2 ? Boolean(v1 || v2) : Boolean(v1 || v2 || v3));
    });

    if (header) {
      textParts.push(header);
      textParts.push('-'.repeat(Math.min(40, Math.max(6, header.length))));
    }
    if (hasAnyRowData) {
      rows.forEach((r) => {
        let columnCount = parseInt(r && r.columnCount != null ? r.columnCount : 3, 10);
        if (![1, 2, 3].includes(columnCount)) columnCount = 3;
        const cols = r && Array.isArray(r.columns) ? r.columns : [];
        const c1 = normalizeCustomHeaderColumn(cols[0]);
        const c2 = normalizeCustomHeaderColumn(cols[1]);
        const c3 = normalizeCustomHeaderColumn(cols[2]);
        const v1 = normalizeOneLineValue(c1.value);
        const v2 = normalizeOneLineValue(c2.value);
        const v3 = normalizeOneLineValue(c3.value);
        const activeVals = columnCount === 1
          ? [v1]
          : (columnCount === 2 ? [v1, v2] : [v1, v2, v3]);
        const rowText = activeVals.filter(Boolean).join(' | ');
        if (rowText) textParts.push(rowText);
      });
    }
    textParts.push('');

    const renderColumnCell = (col, widthPct, isFirst, rowColor, rowTextColor, boxed) => {
      const content = renderOneLineColumnHtml(col, { linkColor: rowTextColor });
      const fg = normalizeHexColor(rowTextColor) || DEFAULT_CUSTOM_SECTION_ROW_TEXT_COLOR;

      if (!boxed) {
        // Floating text: no background, no borders, no dark-mode-card class.
        return `<td width="${widthPct}%" valign="top" style="padding:8px 10px;background-color:transparent !important;color:${escapeHtml(fg)} !important;font-size:13px;line-height:1.5;text-align:center;">${content}</td>`;
      }

      const borderLeft = isFirst ? '' : 'border-left:1px solid rgba(148,163,184,0.18);';
      const bg = normalizeHexColor(rowColor) || DEFAULT_CUSTOM_SECTION_ROW_COLOR;
      // Inline !important beats the template's .dark-mode-card { background-color: ... !important; }
      // and bgcolor helps some email clients.
      return `<td width="${widthPct}%" valign="top" bgcolor="${escapeHtml(bg)}" style="padding:12px 10px;background-color:${escapeHtml(bg)} !important;color:${escapeHtml(fg)} !important;font-size:13px;line-height:1.5;text-align:center;${borderLeft}" class="dark-mode-card">${content}</td>`;
    };

    const renderRowTableHtml = (row, rowIndex, totalRows) => {
      if (!row) return '';
      let columnCount = parseInt(row.columnCount != null ? row.columnCount : 3, 10);
      if (![1, 2, 3].includes(columnCount)) columnCount = 3;
      const rowColor = normalizeHexColor(row.rowColor) || DEFAULT_CUSTOM_SECTION_ROW_COLOR;
      const rowTextColor = normalizeHexColor(row.rowTextColor) || DEFAULT_CUSTOM_SECTION_ROW_TEXT_COLOR;
      const boxed = !(row.boxed === false);
      const cols = Array.isArray(row.columns) ? row.columns : [];
      const col1 = normalizeCustomHeaderColumn(cols[0]);
      const col2 = normalizeCustomHeaderColumn(cols[1]);
      const col3 = normalizeCustomHeaderColumn(cols[2]);

      // Determine if this row has content (after one-line normalization).
      const v1 = normalizeOneLineValue(col1.value);
      const v2 = normalizeOneLineValue(col2.value);
      const v3 = normalizeOneLineValue(col3.value);
      const hasAny = columnCount === 1 ? Boolean(v1) : (columnCount === 2 ? Boolean(v1 || v2) : Boolean(v1 || v2 || v3));
      if (!hasAny) return '';

      const htmlColumns = (() => {
        if (columnCount === 1) {
          return renderColumnCell(col1, 100, true, rowColor, rowTextColor, boxed);
        }
        if (columnCount === 2) {
          return renderColumnCell(col1, 50, true, rowColor, rowTextColor, boxed) + renderColumnCell(col2, 50, false, rowColor, rowTextColor, boxed);
        }
        return renderColumnCell(col1, 33, true, rowColor, rowTextColor, boxed) + renderColumnCell(col2, 33, false, rowColor, rowTextColor, boxed) + renderColumnCell(col3, 34, false, rowColor, rowTextColor, boxed);
      })();

      const isLast = rowIndex === totalRows - 1;
      const padBottom = isLast ? '18px' : '10px';
      const innerTableStyle = boxed
        ? 'border-radius:10px;overflow:hidden;border:1px solid rgba(148,163,184,0.25);'
        : 'border:0;';
      return (
        `<tr>` +
          `<td style="padding: 0 20px ${padBottom} 20px;">` +
          `<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="${innerTableStyle}">` +
          `<tr>` +
          htmlColumns +
          `</tr>` +
          `</table>` +
          `</td>` +
        `</tr>`
      );
    };

    htmlParts.push(
      `<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width:600px;margin:0 auto;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">` +
      `<tr><td style="padding: 10px 20px ${hasAnyRowData ? '0' : '18px'} 20px;">` +
      `<div style="border-top: 2px solid #E5A00D; margin: 10px 0 14px 0;" class="dark-mode-border"></div>` +
      (header
        ? `<div style="margin:0 0 10px 0;font-weight:700;font-size:${sizePx}px;letter-spacing:0.3px;color:${escapeHtml(headerColor)} !important;text-align:center;" class="dark-mode-text">${escapeHtml(header)}</div>`
        : '') +
      `</td></tr>` +
      (hasAnyRowData
        ? (rows.map((r, idx) => renderRowTableHtml(r, idx, rows.length)).join(''))
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

function sanitizeNewsletterSmtpForClient(smtp) {
  const raw = (smtp && typeof smtp === 'object') ? smtp : {};
  const auth = (raw.auth && typeof raw.auth === 'object') ? raw.auth : {};
  const port = (() => {
    if (typeof raw.port === 'number' && Number.isFinite(raw.port)) return raw.port;
    if (typeof raw.port === 'string' && raw.port.trim()) {
      const n = Number(raw.port);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  })();
  return {
    host: typeof raw.host === 'string' ? raw.host : '',
    port,
    secure: raw.secure === true,
    auth: {
      user: typeof auth.user === 'string' ? auth.user : '',
      hasPass: typeof auth.pass === 'string' && auth.pass.length > 0
    }
  };
}

function sanitizeNewsletterEmailForClient(emailCfg) {
  const raw = (emailCfg && typeof emailCfg === 'object') ? emailCfg : {};
  return {
    enabled: raw.enabled !== false,
    from: typeof raw.from === 'string' ? raw.from : '',
    to: typeof raw.to === 'string' ? raw.to : '',
    smtp: sanitizeNewsletterSmtpForClient(raw.smtp)
  };
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

function expandNewsletterFilenameTemplate(input, rendered) {
  const s = String(input || '').trim();
  if (!s) return '';
  const startDate = rendered && rendered._startDate ? String(rendered._startDate) : '';
  const endDate = rendered && rendered._endDate ? String(rendered._endDate) : '';
  const subject = rendered && rendered.subject ? String(rendered.subject) : '';
  return s
    .replace(/\{\{\s*START_DATE\s*\}\}/gi, startDate)
    .replace(/\{\{\s*END_DATE\s*\}\}/gi, endDate)
    .replace(/\{\{\s*SUBJECT\s*\}\}/gi, subject);
}

function saveSentNewsletterToDisk(rendered, { fileName } = {}) {
  try {
    const ts = formatTimestampForFilename(new Date());
    const subject = rendered && rendered.subject ? String(rendered.subject) : 'newsletter';
    const hintExpanded = expandNewsletterFilenameTemplate(fileName, rendered);
    const hint = hintExpanded ? String(hintExpanded).trim() : '';
    const hintNoExt = hint.replace(/\.html?$/i, '');
    const hintClean = hintNoExt ? safeFilename(hintNoExt) : '';
    const base = hintClean ? `${ts}_${hintClean}` : `${ts}_${safeFilename(subject)}`;
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
    const hostLower = String(host || '').toLowerCase();
    // Never auto-generate localhost URLs for emails.
    // If you want local-only access, explicitly set publicBaseUrl in config.
    if (hostLower.startsWith('localhost') || hostLower.startsWith('127.0.0.1') || hostLower.startsWith('[::1]')) {
      return '';
    }
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

function normalizeNewsletterTimeframeDays(input) {
  const n = Number(input);
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  if (i < 1) return 1;
  if (i > 365) return 365;
  return i;
}

function normalizeNewsletterIncludedLibraries(input) {
  const arr = Array.isArray(input) ? input : [];
  const cleaned = arr
    .map(x => String(x || '').trim())
    .filter(Boolean);
  const uniq = Array.from(new Set(cleaned));
  // Avoid unbounded config growth.
  return uniq.slice(0, 200);
}

function normalizeNewsletterSaveFileName(input) {
  const s = String(input || '').trim();
  if (!s) return '';
  // Keep it short and predictable.
  return s.slice(0, 160);
}

function normalizeNewsletterLastMessageId(input) {
  const s = String(input || '').trim();
  if (!s) return '';
  // Basic sanity limit.
  return s.slice(0, 240);
}

function normalizeNewsletterEmailAgent(input) {
  const s = String(input || '').trim();
  // UI currently provides a single built-in option.
  if (!s) return 'builtin-email-1';
  return s.slice(0, 64);
}

async function sendNewsletterBroadcast({ subject, body, startDate, endDate, publicBaseUrl, serverId } = {}) {
  if (!historyDb) {
    throw new Error('history DB not available');
  }
  if (!historyDbReady) {
    throw new Error('history DB not ready');
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

  // If this is a server-scoped send, ensure subscriber serverTags are fresh.
  // This avoids missing recipients when watch history and Overseerr imports drift.
  try {
    if (scopeServerId) {
      await maybeAutoRecomputeSubscriberTagsBeforeSend();
    }
  } catch (e) {
    console.warn('[OmniStream] Auto tag-by-server before send failed:', e && e.message ? e.message : String(e));
  }

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

// ---------------------------------------------------------------------------
// Subscriber tagging (Tag by server)
//
// Watches rely on a stable user key where possible (history.userKey), with a
// fallback to the friendly display name (history.user).
//
// To keep server-scoped newsletters accurate without requiring manual clicks,
// we can recompute tags automatically right before sending.
// ---------------------------------------------------------------------------

function getSubscriberTaggingConfig() {
  const raw = appConfig && typeof appConfig === 'object' ? appConfig.subscriberTagging : null;
  const cfg = raw && typeof raw === 'object' ? raw : {};

  const beforeSend = cfg.beforeSend !== false; // default true
  let days = Number(cfg.days);
  if (!Number.isFinite(days) || days < 0) days = 365;
  if (days > 3650) days = 3650;

  let cooldownMinutes = Number(cfg.cooldownMinutes);
  if (!Number.isFinite(cooldownMinutes) || cooldownMinutes < 0) cooldownMinutes = 30;
  if (cooldownMinutes > 24 * 60) cooldownMinutes = 24 * 60;

  return { beforeSend, days, cooldownMinutes };
}

let subscriberTagRecomputeInFlight = false;
let lastSubscriberTagRecomputeAtMs = 0;

async function recomputeSubscriberServerTags({ days = 0 } = {}) {
  if (!historyDb || !historyDbReady) {
    throw new Error('history DB not available');
  }
  let d = Number(days);
  if (!Number.isFinite(d) || d < 0) d = 0;
  if (d > 3650) d = 3650;
  const cutoffIso = d ? new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString() : null;

  const subs = await new Promise((resolve, reject) => {
    historyDb.all('SELECT id, watchUserKey, watchUser, name FROM newsletter_subscribers', [], (err, rows) => {
      if (!err) return resolve(rows || []);
      // Backward compatibility for older DBs that don't yet have watchUserKey.
      const msg = err && err.message ? String(err.message) : '';
      if (/no such column: watchUserKey/i.test(msg)) {
        historyDb.all('SELECT id, watchUser, name FROM newsletter_subscribers', [], (err2, rows2) => {
          if (err2) return reject(err2);
          resolve(rows2 || []);
        });
        return;
      }
      reject(err);
    });
  });

  const list = Array.isArray(subs) ? subs : [];
  const userKeys = [];
  const userKeySet = new Set();
  const candidateKeysBySubId = new Map();

  const addKeyForAll = (keyRaw) => {
    const key = String(keyRaw || '').trim().toLowerCase();
    if (!key) return;
    if (userKeySet.has(key)) return;
    userKeySet.add(key);
    userKeys.push(key);
  };

  list.forEach(s => {
    const id = s && typeof s.id === 'number' ? s.id : null;
    if (!id) return;
    const wuk = s && typeof s.watchUserKey === 'string' ? s.watchUserKey.trim() : '';
    const wu = s && typeof s.watchUser === 'string' ? s.watchUser.trim() : '';
    const nm = s && typeof s.name === 'string' ? s.name.trim() : '';

    const candidates = [];
    if (wuk) candidates.push(wuk);
    if (wu) candidates.push(wu);
    if (nm && nm.toLowerCase() !== wu.toLowerCase()) candidates.push(nm);

    candidateKeysBySubId.set(id, candidates);
    candidates.forEach(addKeyForAll);
  });

  if (!userKeys.length) {
    return { total: list.length, updated: 0, unmatched: list.length, days: d || null };
  }

  // SQLite has a variable limit (commonly 999). Batch keys to stay safely under it.
  const MAX_KEYS_PER_BATCH = 900;
  const tagsByUserLower = new Map();
  const baseParamsPrefix = cutoffIso ? [cutoffIso] : [];

  // Match against BOTH history.userKey and history.user.
  // This keeps compatibility for older subscribers (username/display-name matching)
  // while allowing stable id keys like plex:<id> to work.
  const keyColumns = [
    `NULLIF(userKey,'')`,
    `NULLIF(user,'')`
  ];

  const mergeRows = (rows) => {
    (rows || []).forEach(r => {
      const key = r && typeof r.u === 'string' ? r.u : '';
      const raw = r && typeof r.serverIds === 'string' ? r.serverIds : '';
      const parts = raw ? raw.split(',').map(x => String(x).trim()).filter(Boolean) : [];
      const uniq = Array.from(new Set(parts));
      uniq.sort();
      if (!key) return;
      if (!tagsByUserLower.has(key)) {
        tagsByUserLower.set(key, uniq);
      } else {
        const merged = Array.from(new Set([...(tagsByUserLower.get(key) || []), ...uniq]));
        merged.sort();
        tagsByUserLower.set(key, merged);
      }
    });
  };

  const batches = [];
  for (let i = 0; i < userKeys.length; i += MAX_KEYS_PER_BATCH) {
    batches.push(userKeys.slice(i, i + MAX_KEYS_PER_BATCH));
  }
  if (!batches.length) batches.push([]);

  // Query batches sequentially to keep memory and DB load predictable.
  for (const colExpr of keyColumns) {
    // eslint-disable-next-line no-await-in-loop
    for (const keys of batches) {
      const placeholders = keys.map(() => '?').join(',');
      let sql = `SELECT LOWER(${colExpr}) AS u, GROUP_CONCAT(DISTINCT serverId) AS serverIds FROM history WHERE serverId IS NOT NULL AND ${colExpr} IS NOT NULL`;
      const params = baseParamsPrefix.slice();
      if (cutoffIso) {
        sql += ' AND time >= ?';
      }
      if (keys.length) {
        sql += ` AND LOWER(${colExpr}) IN (${placeholders})`;
        params.push(...keys);
      }
      sql += ` GROUP BY LOWER(${colExpr})`;

      const rows = await new Promise((resolve, reject) => {
        historyDb.all(sql, params, (err, rows) => {
          if (err) return reject(err);
          resolve(rows || []);
        });
      });
      mergeRows(rows);
    }
  }

  const now = new Date().toISOString();
  const result = await new Promise((resolve, reject) => {
    historyDb.serialize(() => {
      const stmt = historyDb.prepare('UPDATE newsletter_subscribers SET serverTags = ?, updatedAt = ? WHERE id = ?');
      let updated = 0;
      let unmatched = 0;

      list.forEach(s => {
        const id = s && typeof s.id === 'number' ? s.id : null;
        if (!id) return;
        const candidates = candidateKeysBySubId.get(id) || [];
        let tags = [];
        for (const cand of candidates) {
          const key = String(cand || '').trim().toLowerCase();
          if (key && tagsByUserLower.has(key)) {
            tags = tagsByUserLower.get(key) || [];
            if (tags && tags.length) break;
          }
        }
        if (!tags.length) unmatched++;
        try {
          stmt.run(JSON.stringify(tags), now, id);
          updated++;
        } catch (_) {
          // ignore
        }
      });

      stmt.finalize((err) => {
        if (err) return reject(err);
        resolve({ total: list.length, updated, unmatched, days: d || null });
      });
    });
  });

  return result;
}

async function maybeAutoRecomputeSubscriberTagsBeforeSend() {
  const cfg = getSubscriberTaggingConfig();
  if (!cfg.beforeSend) return;
  if (subscriberTagRecomputeInFlight) return;
  const cooldownMs = cfg.cooldownMinutes * 60 * 1000;
  const now = Date.now();
  if (lastSubscriberTagRecomputeAtMs && (now - lastSubscriberTagRecomputeAtMs) < cooldownMs) return;

  subscriberTagRecomputeInFlight = true;
  try {
    const stats = await recomputeSubscriberServerTags({ days: cfg.days });
    lastSubscriberTagRecomputeAtMs = Date.now();
    console.log('[OmniStream] Auto tag-by-server before send complete:', stats);
  } finally {
    subscriberTagRecomputeInFlight = false;
  }
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
    if (!baseUrl) {
      console.warn('[OmniStream] Newsletter schedule: publicBaseUrl is not set; email posters/links may not work. Set it in System → Public base URL.');
    }
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
    const groups = groupEpisodesByShow(episodes);
    if (groups.length) {
      for (const g of groups) {
        const showTitle = String(g.showTitle || '').trim();
        if (!showTitle) continue;
        const serverSuffix = (!scopeServerName && g.rep && g.rep.serverName) ? ` · ${String(g.rep.serverName)}` : '';
        textParts.push(showTitle + serverSuffix);
        const lines = (Array.isArray(g.episodes) ? g.episodes : []).map(episodeLineFor).filter(Boolean);
        lines.forEach(l => textParts.push('  - ' + l));
        textParts.push('');
      }
    } else {
      episodes.forEach(e => textParts.push('- ' + formatLine(e)));
      textParts.push('');
    }
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
      const relative = (rel.startsWith('/') ? rel : '/' + rel);
      // If this is a poster proxy, sign it for email clients.
      if (relative.startsWith('/api/poster?')) {
        try {
          const u = new URL(base + relative);
          const sid = u.searchParams.get('serverId') || '';
          const p = u.searchParams.get('path') || '';
          const hasSig = Boolean(u.searchParams.get('sig') && u.searchParams.get('exp'));
          if (sid && p && !hasSig) {
            return buildSignedNewsletterPosterUrl({ publicBaseUrl: base, serverId: sid, path: p });
          }
        } catch (_) {
          // ignore
        }
      }
      // If this is the Plex newsletter thumb proxy without a signature, sign it.
      if (relative.startsWith('/api/newsletter/plex/thumb?')) {
        try {
          const u = new URL(base + relative);
          const sid = u.searchParams.get('serverId') || '';
          const th = u.searchParams.get('thumb') || '';
          const hasSig = Boolean(u.searchParams.get('sig') && u.searchParams.get('exp'));
          if (sid && th && !hasSig) {
            return buildSignedNewsletterThumbUrl({ publicBaseUrl: base, serverId: sid, thumb: th });
          }
        } catch (_) {
          // ignore
        }
      }
      return base + relative;
    }
    if (!it || !it.serverId || !it.thumb) return '';
    return buildSignedNewsletterThumbUrl({ publicBaseUrl: base, serverId: String(it.serverId), thumb: String(it.thumb) });
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

  function episodeLineFor(it) {
    if (!it) return '';
    const seasonNum = (typeof it.seasonNumber === 'number' && Number.isFinite(it.seasonNumber)) ? it.seasonNumber : null;
    const epNum = (typeof it.episodeNumber === 'number' && Number.isFinite(it.episodeNumber)) ? it.episodeNumber : null;
    let epLabel = '';
    if (seasonNum !== null && epNum !== null) {
      epLabel = `S${String(seasonNum).padStart(2, '0')}E${String(epNum).padStart(2, '0')}`;
    } else if (epNum !== null) {
      epLabel = `E${String(epNum).padStart(2, '0')}`;
    }

    const show = it.showTitle ? String(it.showTitle).trim() : '';
    let epName = String(it.title || '').trim();
    if (show && epName.toLowerCase().startsWith(show.toLowerCase() + ' - ')) {
      epName = epName.slice(show.length + 3).trim();
    }
    if (epLabel && epName.toUpperCase().startsWith(epLabel.toUpperCase() + ' - ')) {
      epName = epName.slice(epLabel.length + 3).trim();
    }
    if (epLabel && epName.toUpperCase() === epLabel.toUpperCase()) {
      epName = '';
    }

    if (epLabel && epName) return `${epLabel} - ${epName}`;
    if (epLabel) return epLabel;
    return String(it.title || '').trim();
  }

  function groupEpisodesByShow(eps) {
    const arr = Array.isArray(eps) ? eps : [];
    const keyFor = (it) => {
      const show = it && it.showTitle ? String(it.showTitle).trim() : '';
      if (!show) return '';
      // Avoid mixing identical show names across different servers unless we're already scoped.
      const serverPart = scopeServerName ? '' : `|${String(it.serverId || '')}`;
      return `${show}${serverPart}`;
    };

    const map = new Map();
    for (const it of arr) {
      const k = keyFor(it);
      if (!k) continue;
      if (!map.has(k)) {
        map.set(k, {
          showTitle: String(it.showTitle || '').trim(),
          rep: it,
          episodes: []
        });
      }
      map.get(k).episodes.push(it);
    }

    const groups = Array.from(map.values());
    // Newest group first
    groups.sort((a, b) => {
      const ta = a && a.rep && a.rep.addedAt ? (Date.parse(a.rep.addedAt) || 0) : 0;
      const tb = b && b.rep && b.rep.addedAt ? (Date.parse(b.rep.addedAt) || 0) : 0;
      return tb - ta;
    });

    // Sort episodes within each group for readability.
    for (const g of groups) {
      g.episodes.sort((a, b) => {
        const sa = (typeof a.seasonNumber === 'number' && Number.isFinite(a.seasonNumber)) ? a.seasonNumber : null;
        const sb = (typeof b.seasonNumber === 'number' && Number.isFinite(b.seasonNumber)) ? b.seasonNumber : null;
        const ea = (typeof a.episodeNumber === 'number' && Number.isFinite(a.episodeNumber)) ? a.episodeNumber : null;
        const eb = (typeof b.episodeNumber === 'number' && Number.isFinite(b.episodeNumber)) ? b.episodeNumber : null;
        if (sa !== null && sb !== null && sa !== sb) return sa - sb;
        if (ea !== null && eb !== null && ea !== eb) return ea - eb;
        const ta = a && a.addedAt ? (Date.parse(a.addedAt) || 0) : 0;
        const tb = b && b.addedAt ? (Date.parse(b.addedAt) || 0) : 0;
        return tb - ta;
      });
    }

    return groups;
  }

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
      ? `<img src="${escapeHtml(thumbUrl)}" width="100" height="150" alt="" style="display:block;margin:0 auto;width:100px;height:150px;border-radius:6px;object-fit:cover;background:#3F4245;" />`
      : `<div style="margin:0 auto;width:100px;height:150px;border-radius:6px;background:#3F4245;"></div>`;

    return (
      `<div style="background:#0b1226;border-radius:10px;padding:14px 14px;box-shadow:0 2px 4px rgba(0,0,0,0.25);margin:10px 0;" class="dark-mode-card">` +
        `<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">` +
          `<tr><td style="padding:0 0 12px 0;text-align:center;">${img}</td></tr>` +
          `<tr><td style="vertical-align:top;">` +
            `<div style="font-size:18px;line-height:1.25;font-weight:700;color:#e5e7eb;text-align:left;" class="dark-mode-text">${escapeHtml(it.title || '')}</div>` +
            (meta ? `<div style="margin:6px 0 0 0;font-size:13px;line-height:1.3;color:#94a3b8;" class="dark-mode-muted">${escapeHtml(meta)}</div>` : '') +
            (genres ? `<div style="margin:6px 0 0 0;font-size:13px;line-height:1.3;color:#94a3b8;" class="dark-mode-muted">${escapeHtml(genres)}</div>` : '') +
            (summary ? `<div style="margin:10px 0 0 0;font-size:13px;line-height:1.45;color:#94a3b8;" class="dark-mode-muted">${escapeHtml(summary)}</div>` : '') +
          `</td></tr>` +
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
  if (episodes.length) {
    htmlParts.push(`<div style="margin: 18px 0 10px 0; font-weight: 600; font-size: 16px; color:#e5e7eb;" class="dark-mode-text">${escapeHtml(tvTitle)}</div>`);
    const groups = groupEpisodesByShow(episodes);
    if (groups.length) {
      for (const g of groups) {
        const rep = g && g.rep ? g.rep : null;
        if (!rep) continue;
        const title = String(g.showTitle || rep.showTitle || rep.title || '').trim();
        if (!title) continue;

        const thumbUrl = thumbUrlFor(rep);
        const meta = (!scopeServerName && rep.serverName) ? String(rep.serverName) : '';
        const episodeLines = (Array.isArray(g.episodes) ? g.episodes : []).map(episodeLineFor).filter(Boolean);

        const img = thumbUrl
          ? `<img src="${escapeHtml(thumbUrl)}" width="100" height="150" alt="" style="display:block;margin:0 auto;width:100px;height:150px;border-radius:6px;object-fit:cover;background:#3F4245;" />`
          : `<div style="margin:0 auto;width:100px;height:150px;border-radius:6px;background:#3F4245;"></div>`;

        const listHtml = episodeLines.length
          ? `<div style="margin:10px 0 0 0;color:#94a3b8;font-size:13px;line-height:1.45;" class="dark-mode-muted">` +
              episodeLines.map(l => `<div style="margin:0 0 4px 0;">• ${escapeHtml(l)}</div>`).join('') +
            `</div>`
          : '';

        htmlParts.push(
          `<div style="background:#0b1226;border-radius:10px;padding:14px 14px;box-shadow:0 2px 4px rgba(0,0,0,0.25);margin:10px 0;" class="dark-mode-card">` +
            `<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">` +
              `<tr><td style="padding:0 0 12px 0;text-align:center;">${img}</td></tr>` +
              `<tr><td style="vertical-align:top;">` +
                `<div style="font-size:18px;line-height:1.25;font-weight:800;color:#e5e7eb;text-align:left;" class="dark-mode-text">${escapeHtml(title)}</div>` +
                (meta ? `<div style="margin:6px 0 0 0;font-size:13px;line-height:1.3;color:#94a3b8;" class="dark-mode-muted">${escapeHtml(meta)}</div>` : '') +
                listHtml +
              `</td></tr>` +
            `</table>` +
          `</div>`
        );
      }
    } else {
      episodes.forEach(it => {
        htmlParts.push(cardHtml(it));
      });
    }
  }
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
        const includedLibraries = normalizeNewsletterIncludedLibraries(options && options.includedLibraries);
        // Fetch more than we display so counts reflect the full date window.
        const items = await fetchRecentlyAdded({ perServer: 50, serverId: scopeServerId, includedLibraries });
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

// Track state transitions used for event-style notifications. These are only
// updated from the poll loop (triggerNotifiers) so /api/notifications remains
// a pure snapshot.
let lastSessionSnapshot = new Map(); // sessionKey -> { serverId, serverName, user, title, transcoding, location, bandwidth }
let lastServerOnlineSnapshot = new Map(); // serverId -> boolean

// Track global polling health/metadata
let lastPollAt = null;           // ISO string of last completed pollAll
let lastPollDurationMs = null;   // Duration of last pollAll in milliseconds
let lastPollError = null;        // Last top-level pollAll error message, if any
let pollAllInFlight = false;     // Prevent overlapping pollAll runs when one poll takes longer than the interval

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
  if (kind === 'serverBackUp') return triggers.serverBackUp !== false;
  if (kind === 'wanTranscode') return triggers.wanTranscodes !== false;
  if (kind === 'highBandwidth') return triggers.highBandwidth !== false;
  if (kind === 'anyWan') return triggers.anyWan !== false;
  if (kind === 'highWanBandwidth') return triggers.highWanBandwidth !== false;
  if (kind === 'historyDbBackup') return triggers.historyDbBackups !== false;
  // Chatty triggers are opt-in
  if (kind === 'playbackStart') return triggers.playbackStart === true;
  if (kind === 'playbackStop') return triggers.playbackStop === true;
  return true;
}

function buildEventNotificationsFromSnapshots() {
  try {
    const notifications = [];
    const nowIso = new Date().toISOString();

    // Only include enabled servers
    const enabledServerIds = new Set((Array.isArray(servers) ? servers : [])
      .filter(s => s && !s.disabled && s.id != null)
      .map(s => String(s.id)));

    // Build current online snapshot + current session snapshot
    const currentOnline = new Map();
    const currentSessions = new Map();

    Object.values(statuses).forEach(st => {
      const stId = st && st.id != null ? String(st.id) : null;
      if (!stId || !enabledServerIds.has(stId)) return;

      const online = !!st.online;
      currentOnline.set(stId, online);

      if (!online || !Array.isArray(st.sessions)) return;
      st.sessions.forEach(sess => {
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

        const seriesTitle = (sess.seriesTitle || '').toString();
        const episodeTitle = (sess.episode || sess.episodeTitle || '').toString();
        const channel = (sess.channel || '').toString();
        const title = seriesTitle
          ? `${seriesTitle} - ${episodeTitle || sess.title || ''}`.replace(/\s+-\s*$/, '')
          : (sess.title || channel || 'Playback');

        const user = sess.user || sess.userName || 'Unknown';
        const transcoding = typeof sess.transcoding === 'boolean'
          ? sess.transcoding
          : (sess.stream && typeof sess.stream === 'string' && sess.stream.toLowerCase().includes('transcode'));
        const location = sess.location || '';
        const bandwidth = typeof sess.bandwidth === 'number' ? sess.bandwidth : null;

        currentSessions.set(sessionKey, {
          serverId: stId,
          serverName: st.name || 'Server',
          user,
          title,
          transcoding,
          location,
          bandwidth
        });
      });
    });

    // Server back up events
    for (const [serverId, online] of currentOnline.entries()) {
      const wasOnline = lastServerOnlineSnapshot.has(serverId)
        ? !!lastServerOnlineSnapshot.get(serverId)
        : online;
      if (!wasOnline && online) {
        // Find server name from statuses if possible
        const st = statuses[serverId];
        const name = st && st.name ? st.name : 'Server';
        notifications.push({
          id: `server-back-up-${serverId}-${Date.now()}`,
          level: 'info',
          serverId,
          serverName: name,
          time: nowIso,
          kind: 'serverBackUp',
          message: `${name} is back online`
        });
      }
    }

    // Playback start/stop events
    for (const [sessionKey, meta] of currentSessions.entries()) {
      if (lastSessionSnapshot.has(sessionKey)) continue;
      const details = [
        meta.user ? `User: ${meta.user}` : '',
        meta.location ? `Location: ${meta.location}` : '',
        meta.transcoding ? 'Transcoding' : '',
        (typeof meta.bandwidth === 'number') ? `BW: ${meta.bandwidth.toFixed(1)} Mbps` : ''
      ].filter(Boolean).join(' • ');
      notifications.push({
        id: `playback-start-${sessionKey}`,
        level: 'info',
        serverId: meta.serverId,
        serverName: meta.serverName,
        time: nowIso,
        kind: 'playbackStart',
        message: `Playback started on ${meta.serverName}: ${meta.title}${details ? ` (${details})` : ''}`
      });
    }

    for (const [sessionKey, meta] of lastSessionSnapshot.entries()) {
      if (currentSessions.has(sessionKey)) continue;
      const details = [
        meta.user ? `User: ${meta.user}` : '',
        meta.location ? `Location: ${meta.location}` : '',
        meta.transcoding ? 'Transcoding' : ''
      ].filter(Boolean).join(' • ');
      notifications.push({
        id: `playback-stop-${sessionKey}-${Date.now()}`,
        level: 'info',
        serverId: meta.serverId,
        serverName: meta.serverName,
        time: nowIso,
        kind: 'playbackStop',
        message: `Playback stopped on ${meta.serverName}: ${meta.title}${details ? ` (${details})` : ''}`
      });
    }

    // Update snapshots
    lastSessionSnapshot = currentSessions;
    lastServerOnlineSnapshot = currentOnline;

    return notifications;
  } catch (e) {
    console.error('[OmniStream] Failed to build event notifications:', e.message);
    return [];
  }
}

function getNotifierAgents() {
  const raw = appConfig && appConfig.notifiers && appConfig.notifiers.agents;
  const agents = Array.isArray(raw) ? raw : [];
  return agents
    .map(a => (a && typeof a === 'object' ? a : null))
    .filter(Boolean);
}

function normalizeNotifierAgentId(input) {
  const n = Number(input);
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  if (i < 1) return null;
  if (i > 1_000_000_000) return null;
  return i;
}

function allocateNextNotifierAgentId(existingAgents) {
  const ids = (Array.isArray(existingAgents) ? existingAgents : [])
    .map(a => normalizeNotifierAgentId(a && a.id))
    .filter(Boolean);
  const max = ids.length ? Math.max(...ids) : 0;
  return max + 1;
}

function normalizeEmailRecipientList(input) {
  // Accept array, comma/semicolon/newline-separated string, or single string.
  if (Array.isArray(input)) {
    const cleaned = input
      .map(v => String(v || '').trim())
      .filter(Boolean);
    return Array.from(new Set(cleaned)).slice(0, 200);
  }

  const s = input != null ? String(input) : '';
  const parts = s
    .split(/[;,\n]+/g)
    .map(v => String(v || '').trim())
    .filter(Boolean);
  return Array.from(new Set(parts)).slice(0, 200);
}

function normalizeEmailEncryptionMode(input) {
  const s = String(input || '').trim().toLowerCase();
  if (s === 'ssl' || s === 'ssltls' || s === 'ssl/tls') return 'ssl';
  if (s === 'none') return 'none';
  return 'starttls';
}

function sanitizeEmailNotifierAgent(agent) {
  const a = agent && typeof agent === 'object' ? agent : {};
  const id = normalizeNotifierAgentId(a.id);
  const enabled = a.enabled !== false;
  const type = 'email';
  const cfg = (a.config && typeof a.config === 'object') ? a.config : {};
  const smtp = (cfg.smtp && typeof cfg.smtp === 'object') ? cfg.smtp : {};
  const auth = (smtp.auth && typeof smtp.auth === 'object') ? smtp.auth : {};
  const triggers = (a.triggers && typeof a.triggers === 'object') ? a.triggers : {};
  const text = (a.text && typeof a.text === 'object') ? a.text : {};

  const encryption = normalizeEmailEncryptionMode(cfg.encryption || smtp.encryption);
  const secure = encryption === 'ssl' ? true : false;
  const requireTLS = encryption === 'starttls' ? true : false;

  return {
    id,
    type,
    enabled,
    config: {
      fromName: cfg.fromName != null ? String(cfg.fromName).trim().slice(0, 200) : '',
      from: cfg.from != null ? String(cfg.from).trim() : '',
      // Back-compat: previously this was stored as a single string.
      to: normalizeEmailRecipientList(cfg.to),
      cc: normalizeEmailRecipientList(cfg.cc),
      bcc: normalizeEmailRecipientList(cfg.bcc),
      encryption,
      allowHtml: cfg.allowHtml === true,
      smtp: {
        host: smtp.host != null ? String(smtp.host).trim() : '',
        port: smtp.port != null ? Number(smtp.port) : undefined,
        secure,
        requireTLS,
        auth: {
          user: auth.user != null ? String(auth.user).trim() : '',
          pass: auth.pass != null ? String(auth.pass) : ''
        }
      }
    },
    triggers: {
      offline: triggers.offline !== false,
      serverBackUp: triggers.serverBackUp !== false,
      wanTranscodes: triggers.wanTranscodes !== false,
      highBandwidth: triggers.highBandwidth !== false,
      anyWan: triggers.anyWan !== false,
      highWanBandwidth: triggers.highWanBandwidth !== false,
      historyDbBackups: triggers.historyDbBackups !== false
      ,
      playbackStart: triggers.playbackStart === true,
      playbackStop: triggers.playbackStop === true
    },
    text: {
      subject: text.subject != null ? String(text.subject).slice(0, 200) : '',
      body: text.body != null ? String(text.body).slice(0, 5000) : ''
    }
  };
}

function setNotifierAgents(nextAgents) {
  if (!appConfig.notifiers || typeof appConfig.notifiers !== 'object') {
    appConfig.notifiers = {};
  }
  appConfig.notifiers.agents = Array.isArray(nextAgents) ? nextAgents : [];
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(appConfig, null, 2));
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
    const notifications = buildNotificationsSnapshot().concat(buildEventNotificationsFromSnapshots());
    const currentIds = new Set(notifications.map(n => n.id));
    // Only notify on newly-appearing notifications compared to previous poll
    const newlyActive = notifications.filter(n => !lastNotificationIds.has(n.id));
    if (!newlyActive.length) {
      lastNotificationIds = currentIds;
      return;
    }
    const notifierCfg = (appConfig && appConfig.notifiers) || {};
    const agents = getNotifierAgents();
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

      // Notifier Agents (email)
      agents.forEach(agent => {
        try {
          if (!agent || agent.type !== 'email' || agent.enabled === false) return;
          // Reuse the same trigger semantics as legacy channels.
          if (!shouldSendNotificationToChannel(n, { triggers: agent.triggers })) return;
          sendEmailNotificationWithConfig(n, agent.config, {
            subject: agent.text && agent.text.subject ? agent.text.subject : '',
            body: agent.text && agent.text.body ? agent.text.body : ''
          });
        } catch (e) {
          console.error('[OmniStream] Notifier agent failure:', e.message);
          recordNotifierError('notifier-agent', e.message);
        }
      });
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

function sendEmailNotificationWithConfig(notification, emailCfg, overrides) {
  if (!emailCfg || emailCfg.enabled === false || !nodemailer) return;
  const fromName = emailCfg.fromName != null ? String(emailCfg.fromName).trim() : '';
  const fromAddr = emailCfg.from != null ? String(emailCfg.from).trim() : '';
  const toList = normalizeEmailRecipientList(emailCfg.to);
  const ccList = normalizeEmailRecipientList(emailCfg.cc);
  const bccList = normalizeEmailRecipientList(emailCfg.bcc);
  if (!fromAddr || !toList.length) return;
  try {
    const transport = nodemailer.createTransport(emailCfg.smtp || {});
    const level = (notification.level || 'info').toUpperCase();
    const fallbackSubject = `[OmniStream] ${level}: ${notification.message}`;
    const textLines = [
      `Server: ${notification.serverName || 'Server'}`,
      `Time: ${notification.time || new Date().toISOString()}`,
      '',
      notification.message
    ];

    const overrideSubject = overrides && overrides.subject != null ? String(overrides.subject).trim() : '';
    const overrideBody = overrides && overrides.body != null ? String(overrides.body) : '';
    const subject = overrideSubject || fallbackSubject;
    const body = overrideBody ? overrideBody : textLines.join('\n');

    const mailOptions = {
      from: fromName ? `${fromName} <${fromAddr}>` : fromAddr,
      to: toList,
      subject,
      text: body
    };

    if (ccList.length) mailOptions.cc = ccList;
    if (bccList.length) mailOptions.bcc = bccList;

    const allowHtml = emailCfg.allowHtml === true;
    const looksLikeHtml = /<\w[\s\S]*>/i.test(body);
    if (allowHtml && looksLikeHtml) {
      mailOptions.html = body;
      const stripped = stripHtmlToText(body);
      if (stripped) mailOptions.text = stripped;
    }

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

function sendEmailNotification(notification) {
  const emailCfg = appConfig?.notifiers?.email;
  sendEmailNotificationWithConfig(notification, emailCfg, null);
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
const HISTORY_BACKUPS_DIR = path.join(__dirname, 'backups');
let historyDb;
let historyDbReady = false;
const openHistoryDb = () => {
  historyDbReady = false;
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
        '  userKey TEXT,\n' +
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
          { name: 'userAvatar', ddl: 'ALTER TABLE history ADD COLUMN userAvatar TEXT' },
          { name: 'userKey', ddl: 'ALTER TABLE history ADD COLUMN userKey TEXT' }
        ].filter(c => !existing.has(c.name));

        const finalizeReady = () => {
          const finalizeDone = () => {
            historyDbReady = true;
          };

          const backfillLegacyImportedRows = (cb) => {
            try {
              historyDb.run(
                `UPDATE history
                    SET mediaType = CASE
                          WHEN LOWER(COALESCE(stream,'')) = 'movie' THEN 'movie'
                          WHEN LOWER(COALESCE(stream,'')) = 'episode' THEN 'episode'
                          WHEN COALESCE(NULLIF(seriesTitle,''), NULLIF(episodeTitle,'')) IS NOT NULL THEN 'episode'
                          ELSE 'movie'
                        END,
                        seriesTitle = CASE
                          WHEN (seriesTitle IS NULL OR seriesTitle = '')
                               AND LOWER(COALESCE(stream,'')) = 'episode'
                               AND INSTR(title, ' - ') > 0
                          THEN SUBSTR(title, 1, INSTR(title, ' - ') - 1)
                          ELSE seriesTitle
                        END,
                        episodeTitle = CASE
                          WHEN (episodeTitle IS NULL OR episodeTitle = '')
                               AND LOWER(COALESCE(stream,'')) = 'episode'
                               AND INSTR(title, ' - ') > 0
                          THEN SUBSTR(title, INSTR(title, ' - ') + 3)
                          ELSE episodeTitle
                        END
                  WHERE (mediaType IS NULL OR mediaType = '')`,
                () => cb && cb()
              );
            } catch (e) {
              console.error('[OmniStream] Legacy history backfill failed:', e.message);
              cb && cb();
            }
          };

          // sessionKey index is only valid after the column exists
          if (existing.has('sessionKey') || !toAdd.find(c => c.name === 'sessionKey')) {
            historyDb.run('CREATE INDEX IF NOT EXISTS idx_history_sessionKey ON history(sessionKey)', () => {
              backfillLegacyImportedRows(finalizeDone);
            });
          } else {
            // sessionKey was attempted but might not exist; still mark ready.
            backfillLegacyImportedRows(finalizeDone);
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
        "  watchUserKey TEXT,\n" +
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
          { name: 'watchUserKey', ddl: 'ALTER TABLE newsletter_subscribers ADD COLUMN watchUserKey TEXT' },
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
    return true;
  } catch (e) {
    console.error('Failed to initialize history database:', e.message);
    historyDb = null;
    historyDbReady = false;
    return false;
  }
};

const closeHistoryDb = () => new Promise((resolve) => {
  try {
    historyDbReady = false;
    if (!historyDb) return resolve();
    historyDb.close(() => {
      historyDb = null;
      resolve();
    });
  } catch (_) {
    historyDb = null;
    historyDbReady = false;
    resolve();
  }
});

openHistoryDb();

const defaultPathForType = (t) => {
  if (t === 'plex') return '/status/sessions';
  if (t === 'jellyfin') return '/Sessions';
  if (t === 'emby') return '/Sessions';
  return '/';
};

// History DB backups (automated + manual)
let historyDbBackupTimer = null;
let lastHistoryDbBackupAt = null;
let lastHistoryDbBackupError = null;
let lastHistoryDbBackupErrorAt = null;
let lastHistoryDbBackupName = null;
let lastHistoryDbBackupSizeBytes = null;
let nextHistoryDbBackupAt = null;

function normalizeHistoryDbBackupInterval(v) {
  const s = String(v || '').trim().toLowerCase();
  if (s === 'hourly' || s === 'daily' || s === 'weekly') return s;
  return 'off';
}

function getHistoryDbBackupConfig() {
  const cfg = appConfig && appConfig.backups && appConfig.backups.historyDb ? appConfig.backups.historyDb : {};
  const interval = normalizeHistoryDbBackupInterval(cfg.interval);
  let keep = Number(cfg.keep);
  if (!Number.isFinite(keep) || keep < 1) keep = 30;
  if (keep > 365) keep = 365;
  return { interval, keep };
}

function historyDbBackupIntervalMs(interval) {
  if (interval === 'hourly') return 60 * 60 * 1000;
  if (interval === 'daily') return 24 * 60 * 60 * 1000;
  if (interval === 'weekly') return 7 * 24 * 60 * 60 * 1000;
  return 0;
}

function ensureHistoryBackupsDir() {
  try {
    fs.mkdirSync(HISTORY_BACKUPS_DIR, { recursive: true });
    return true;
  } catch (e) {
    console.error('[OmniStream] Failed to create backups directory:', e.message);
    return false;
  }
}

function safeBackupFilenameBase(str) {
  return String(str || '')
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function listHistoryDbBackups({ limit = 50 } = {}) {
  try {
    if (!fs.existsSync(HISTORY_BACKUPS_DIR)) return [];
    const files = fs.readdirSync(HISTORY_BACKUPS_DIR);
    const items = [];
    for (const f of files) {
      if (!f || typeof f !== 'string') continue;
      if (!f.toLowerCase().endsWith('.db')) continue;
      if (!f.toLowerCase().startsWith('history-')) continue;
      const p = path.join(HISTORY_BACKUPS_DIR, f);
      let st;
      try { st = fs.statSync(p); } catch (_) { continue; }
      if (!st || !st.isFile()) continue;
      items.push({ name: f, sizeBytes: st.size, mtimeMs: st.mtimeMs });
    }
    items.sort((a, b) => (b.mtimeMs - a.mtimeMs));
    return items.slice(0, Math.max(1, Math.min(200, limit)));
  } catch (e) {
    console.error('[OmniStream] Failed to list history DB backups:', e.message);
    return [];
  }
}

async function verifySqliteDbFile(filePath) {
  return await new Promise((resolve) => {
    try {
      const db = new sqlite3.Database(filePath, sqlite3.OPEN_READONLY, (err) => {
        if (err) return resolve(false);
        db.get('PRAGMA integrity_check', [], (e2, row) => {
          try { db.close(() => {}); } catch (_) {}
          if (e2) return resolve(false);
          const v = row && (row.integrity_check || row[Object.keys(row)[0]]);
          resolve(String(v || '').toLowerCase() === 'ok');
        });
      });
    } catch (_) {
      resolve(false);
    }
  });
}

async function createHistoryDbBackup({ reason = 'manual' } = {}) {
  if (!historyDb || !historyDbReady || !fs.existsSync(HISTORY_DB_FILE)) {
    throw new Error('History database not ready');
  }
  if (!ensureHistoryBackupsDir()) {
    throw new Error('Failed to create backups directory');
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = safeBackupFilenameBase(reason || 'manual') || 'manual';
  const name = `history-${ts}-${suffix}.db`;
  const outPath = path.join(HISTORY_BACKUPS_DIR, name);

  // Prefer an online-consistent backup method.
  const tryVacuumInto = () => new Promise((resolve, reject) => {
    try {
      // SQLite VACUUM INTO requires a literal string in many builds.
      const sqlitePath = outPath.replace(/'/g, "''");
      historyDb.run(`VACUUM INTO '${sqlitePath}'`, (err) => {
        if (err) reject(err);
        else resolve();
      });
    } catch (e) {
      reject(e);
    }
  });

  const tryNativeBackup = () => new Promise((resolve, reject) => {
    try {
      if (!historyDb || typeof historyDb.backup !== 'function') {
        return reject(new Error('sqlite3 backup() not available'));
      }
      historyDb.backup(outPath, (err) => {
        if (err) reject(err);
        else resolve();
      });
    } catch (e) {
      reject(e);
    }
  });

  const tryCopyFile = () => new Promise((resolve, reject) => {
    try {
      fs.copyFile(HISTORY_DB_FILE, outPath, (err) => {
        if (err) reject(err);
        else resolve();
      });
    } catch (e) {
      reject(e);
    }
  });

  let lastErr = null;
  for (const attempt of [tryVacuumInto, tryNativeBackup, tryCopyFile]) {
    try {
      await attempt();
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (lastErr) throw lastErr;

  const ok = await verifySqliteDbFile(outPath);
  if (!ok) {
    try { fs.unlinkSync(outPath); } catch (_) {}
    throw new Error('Backup created but failed integrity_check');
  }

  // Prune old backups
  const { keep } = getHistoryDbBackupConfig();
  try {
    const all = listHistoryDbBackups({ limit: 500 });
    const toDelete = all.slice(keep);
    toDelete.forEach(it => {
      try { fs.unlinkSync(path.join(HISTORY_BACKUPS_DIR, it.name)); } catch (_) {}
    });
  } catch (_) {}

  const st = fs.statSync(outPath);
  lastHistoryDbBackupAt = new Date().toISOString();
  lastHistoryDbBackupError = null;
  lastHistoryDbBackupErrorAt = null;
  lastHistoryDbBackupName = name;
  lastHistoryDbBackupSizeBytes = st.size;
  return { name, sizeBytes: st.size, createdAt: lastHistoryDbBackupAt };
}

function scheduleHistoryDbBackups() {
  try {
    if (historyDbBackupTimer) {
      clearInterval(historyDbBackupTimer);
      historyDbBackupTimer = null;
    }
    nextHistoryDbBackupAt = null;
    const { interval } = getHistoryDbBackupConfig();
    const ms = historyDbBackupIntervalMs(interval);
    if (!ms) return;

    nextHistoryDbBackupAt = new Date(Date.now() + ms).toISOString();
    historyDbBackupTimer = setInterval(async () => {
      try {
        if (!historyDb || !historyDbReady) return;
        await createHistoryDbBackup({ reason: 'auto' });
      } catch (e) {
        lastHistoryDbBackupError = e && e.message ? String(e.message) : 'Auto backup failed';
        lastHistoryDbBackupErrorAt = new Date().toISOString();
        console.error('[OmniStream] Auto history DB backup failed:', lastHistoryDbBackupError);
      } finally {
        nextHistoryDbBackupAt = new Date(Date.now() + ms).toISOString();
      }
    }, ms);
  } catch (e) {
    console.error('[OmniStream] Failed to schedule history DB backups:', e.message);
  }
}

async function restoreHistoryDbFromBackupName(name) {
  const base = path.basename(String(name || ''));
  if (!base || base !== name) {
    throw new Error('Invalid backup name');
  }
  if (!base.toLowerCase().endsWith('.db') || !base.toLowerCase().startsWith('history-')) {
    throw new Error('Invalid backup file');
  }
  const srcPath = path.join(HISTORY_BACKUPS_DIR, base);
  if (!fs.existsSync(srcPath)) {
    throw new Error('Backup not found');
  }

  // Safety snapshot of current DB (best-effort)
  try {
    await createHistoryDbBackup({ reason: 'pre-restore' });
  } catch (_) {}

  const ok = await verifySqliteDbFile(srcPath);
  if (!ok) throw new Error('Backup failed integrity_check');

  await closeHistoryDb();
  fs.copyFileSync(srcPath, HISTORY_DB_FILE);
  openHistoryDb();
  return true;
}

scheduleHistoryDbBackups();

// Import watch history helpers
// Jellyfin/Emby: pull per-user played movies/episodes
async function importJellyfinHistory(server, { limitPerUser = 100 } = {}) {
  if (!historyDb) return { serverId: server.id, type: server.type, imported: 0, error: 'history DB not available' };
  const base = (server.baseUrl || '').replace(/\/$/, '');
  if (!server.token) {
    return { serverId: server.id, type: server.type, imported: 0, error: 'no token configured' };
  }
  const headers = {};
  const authParams = {};
  const tokenLoc = server.tokenLocation || 'header';
  if (tokenLoc === 'query') {
    if (server.type === 'jellyfin') {
      authParams.api_key = server.token;
    } else {
      authParams['X-Emby-Token'] = server.token;
    }
  } else {
    if (server.type === 'jellyfin') {
      headers['X-MediaBrowser-Token'] = server.token;
    } else {
      headers['X-Emby-Token'] = server.token;
    }
  }
  try {
    // Get all visible users
    const usersResp = await axios.get(base + '/Users', { headers, params: authParams, timeout: 15000 });
    const users = Array.isArray(usersResp.data) ? usersResp.data : [];
    let imported = 0;
    // For each user, pull recently played movies/episodes
    for (const u of users) {
      if (!u || !u.Id) continue;
      const itemsResp = await axios.get(base + `/Users/${encodeURIComponent(u.Id)}/Items`, {
        headers,
        timeout: 20000,
        params: {
          ...(authParams || {}),
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
            'INSERT INTO history (time, endedAt, lastSeenAt, sessionKey, serverId, serverName, type, user, userKey, userAvatar, title, mediaType, seriesTitle, episodeTitle, year, channel, isLive, poster, background, stream, transcoding, location, bandwidth, platform, product, player, quality, duration, progress, ip, completed) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
          );
          items.forEach(it => {
            const rawType = it.Type || it.MediaType || '';
            // Ignore Jellyfin library views / folders (CollectionFolder, UserView, etc.)
            if (rawType !== 'Movie' && rawType !== 'Episode') {
              return;
            }

            const time = (it.UserData && it.UserData.LastPlayedDate) || it.DatePlayed || new Date().toISOString();

            const mediaType = rawType.toLowerCase() === 'episode' ? 'episode' : 'movie';
            const seriesTitle = (mediaType === 'episode' ? (it.SeriesName || '') : '');
            const episodeTitle = (mediaType === 'episode' ? (it.Name || '') : '');

            // Display title similar to live sessions.
            const title = seriesTitle
              ? `${seriesTitle} - ${episodeTitle || ''}`.replace(/\s+-\s*$/, '')
              : (it.Name || it.OriginalTitle || 'Unknown');

            // Use a stable session key so repeated imports don't explode row count.
            const itemId = it.Id || it.ItemId || it.ProviderIds?.Imdb || it.ProviderIds?.Tmdb || '';
            const sessionKey = `import|${String(server.id)}|${String(u.Id)}|${String(itemId)}|${String(time)}`;

            // Artwork (prefer series art for episodes)
            let poster = '/live_tv_placeholder.svg';
            let background = '/live_tv_placeholder.svg';
            if (server && server.id && it) {
              const seriesId = it.SeriesId;
              const posterItemId = (mediaType === 'episode' && seriesId) ? seriesId : it.Id;
              if (posterItemId) {
                const p = `/Items/${posterItemId}/Images/Primary`;
                poster = `/api/poster?serverId=${encodeURIComponent(server.id)}&path=${encodeURIComponent(p)}`;
                const b = `/Items/${posterItemId}/Images/Backdrop`;
                background = `/api/poster?serverId=${encodeURIComponent(server.id)}&path=${encodeURIComponent(b)}`;
              }
            }
            if (!background) background = poster;

            // Best-effort user avatar
            let userAvatar = '';
            if (server && server.id && u && u.Id) {
              const avatarPath = `/Users/${u.Id}/Images/Primary`;
              userAvatar = `/api/poster?serverId=${encodeURIComponent(server.id)}&path=${encodeURIComponent(avatarPath)}`;
            }

            const stream = mediaType === 'movie' ? 'Movie' : 'Episode';
            const userDisplay = u.Username || u.Name || 'Unknown';
            const stableUserKey = u && u.Id ? `${String(server.type || '').toLowerCase()}:${String(u.Id)}` : '';
            const userKey = stableUserKey || u.Username || u.Id || u.Name || '';

            const runTimeTicks = typeof it.RunTimeTicks === 'number' ? it.RunTimeTicks : null;
            const duration = runTimeTicks && Number.isFinite(runTimeTicks) ? Math.round(runTimeTicks / 10000 / 1000) : null;

            stmt.run(
              time,
              time,
              time,
              sessionKey,
              server.id,
              server.name || server.baseUrl,
              server.type,
              userDisplay,
              userKey,
              userAvatar,
              title,
              mediaType,
              seriesTitle,
              episodeTitle,
              typeof it.ProductionYear === 'number' ? it.ProductionYear : null,
              '',
              0,
              poster,
              background,
              stream,
              null,
              '',
              0
              ,
              '',
              '',
              '',
              '',
              duration,
              100,
              '',
              1
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
  const historyPaths = ['/status/sessions/history/all', '/status/sessions/history'];
  const headers = {
    // Plex frequently defaults to XML; we expect JSON throughout the app.
    Accept: 'application/json'
  };

  try {
    let imported = 0;
    let lastError = '';
    const tokenLoc = server.tokenLocation || 'query';
    if (tokenLoc === 'header') {
      headers['X-Plex-Token'] = server.token;
    }

    const runImportForUrl = async (url) => {
      let start = 0;
      const pageSize = 200;

      await new Promise((resolve) => {
        historyDb.serialize(async () => {
          const stmt = historyDb.prepare(
            'INSERT INTO history (time, endedAt, lastSeenAt, sessionKey, serverId, serverName, type, user, userKey, userAvatar, title, mediaType, seriesTitle, episodeTitle, year, channel, isLive, poster, background, stream, transcoding, location, bandwidth, platform, product, player, quality, duration, progress, ip, completed) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
          );

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
              const status = err && err.response && typeof err.response.status === 'number' ? err.response.status : null;
              lastError = status ? `HTTP ${status} from Plex history endpoint` : (err && err.message ? err.message : 'Plex request failed');
              console.error(`Plex history page fetch failed for ${server.name || server.baseUrl}:`, lastError);
              break;
            }

            const data = resp ? resp.data : null;
            if (!data || typeof data !== 'object') {
              lastError = 'Unexpected Plex response (not JSON). Check Plex baseUrl/token/tokenLocation.';
              break;
            }

            const mc = data && data.MediaContainer ? data.MediaContainer : null;
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

          const mediaType = rawType;

          const seriesTitle = (mediaType === 'episode' ? (m.grandparentTitle || '') : '');
          const episodeTitle = (mediaType === 'episode' ? (m.title || '') : '');
          const year = typeof m.year === 'number' ? m.year : null;

          // Display title similar to live sessions.
          let title;
          if (mediaType === 'episode' || m.grandparentTitle) {
            const series = seriesTitle;
            const epName = episodeTitle;
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
          let userKey = '';
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

          // Best-effort stable user key (prefer Plex numeric id when available)
          const plexUserIdRaw = (m.User && (m.User.id ?? m.User.ID ?? m.User.userId ?? m.User.userID)) ?? null;
          const plexUserId = plexUserIdRaw != null ? String(plexUserIdRaw) : '';
          if (plexUserId) {
            userKey = `plex:${plexUserId}`;
          } else if (m.User && typeof m.User.username === 'string') {
            userKey = m.User.username;
          } else if (typeof m.username === 'string') {
            userKey = m.username;
          } else if (m.user && typeof m.user === 'string') {
            userKey = m.user;
          } else if (m.user && typeof m.user.title === 'string') {
            userKey = m.user.title;
          }
          if (!userKey) userKey = user;
          if (user === 'Unknown') {
            console.log('[OmniStream] Plex history item has unknown user; available user fields:', {
              user: m.user,
              username: m.username,
              Account: m.Account,
              account: m.account,
              User: m.User
            });
          }
          const duration = typeof m.duration === 'number' ? Math.round(m.duration / 1000) : null;

          // Best-effort artwork (proxy through our poster route when possible)
          let poster = '/live_tv_placeholder.svg';
          let background = '/live_tv_placeholder.svg';
          const rawThumb = (mediaType === 'episode' && (m.grandparentThumb || m.parentThumb)) ? (m.grandparentThumb || m.parentThumb) : (m.thumb || m.grandparentThumb || m.parentThumb || '');
          if (rawThumb && typeof rawThumb === 'string') {
            if (/^https?:\/\//i.test(rawThumb)) {
              poster = rawThumb;
            } else {
              poster = `/api/poster?serverId=${encodeURIComponent(server.id)}&path=${encodeURIComponent(rawThumb)}`;
            }
          }
          const rawArt = m.art || '';
          if (rawArt && typeof rawArt === 'string') {
            if (/^https?:\/\//i.test(rawArt)) {
              background = rawArt;
            } else {
              background = `/api/poster?serverId=${encodeURIComponent(server.id)}&path=${encodeURIComponent(rawArt)}`;
            }
          }
          if (!background) background = poster;

          // Best-effort user avatar
          let userAvatar = '';
          const rawUserThumb =
            (m.User && (m.User.thumb || m.User.avatar)) ||
            (Array.isArray(m.Account) && m.Account[0] && (m.Account[0].thumb || m.Account[0].avatar)) ||
            (m.Account && (m.Account.thumb || m.Account.avatar)) ||
            (Array.isArray(m.account) && m.account[0] && (m.account[0].thumb || m.account[0].avatar)) ||
            (m.account && (m.account.thumb || m.account.avatar)) ||
            null;
          if (rawUserThumb && typeof rawUserThumb === 'string') {
            if (/^https?:\/\//i.test(rawUserThumb)) userAvatar = rawUserThumb;
            else userAvatar = `/api/poster?serverId=${encodeURIComponent(server.id)}&path=${encodeURIComponent(rawUserThumb)}`;
          }

          const stream = mediaType === 'movie' ? 'Movie' : (mediaType === 'episode' ? 'Episode' : '');
          const sessionKey = `import|${String(server.id)}|${String(userKey)}|${String(m.ratingKey || m.key || m.guid || title)}|${String(timeIso)}`;

          stmt.run(
            timeIso,
            timeIso,
            timeIso,
            sessionKey,
            server.id,
            server.name || server.baseUrl,
            server.type,
            user,
            userKey,
            userAvatar,
            title,
            mediaType,
            seriesTitle,
            episodeTitle,
            year,
            '',
            0,
            poster,
            background,
            stream,
            null,
            '',
            0,
            '',
            '',
            '',
            '',
            duration,
            100,
            '',
            1
          );
          imported++;
        });

            if (items.length < size) break;
            start += items.length;
          }

          stmt.finalize(() => resolve());
        });
      });
    };

    for (const p of historyPaths) {
      // eslint-disable-next-line no-await-in-loop
      await runImportForUrl(base + p);
      if (imported > 0) break;
      // If Plex endpoint is missing, try the fallback path.
      if (!lastError || /404/i.test(lastError)) {
        continue;
      }
      break;
    }

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

    if (!imported && lastError) {
      return { serverId: server.id, type: server.type, imported: 0, error: lastError };
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

        const userDisplay = m.User?.title || m.user || 'Unknown';
        const userName = m.User?.username || m.username || (typeof m.user === 'string' ? m.user : '') || '';
        const plexUserIdRaw = (m.User && (m.User.id ?? m.User.ID ?? m.User.userId ?? m.User.userID)) ?? null;
        const plexUserId = plexUserIdRaw != null ? String(plexUserIdRaw) : '';
        const stableUserKey = plexUserId ? `plex:${plexUserId}` : '';
        const sessionIdRaw = m.sessionKey ?? (m.Session && (m.Session.id ?? m.Session.key ?? m.Session.uuid)) ?? null;
        const sessionId = sessionIdRaw != null ? String(sessionIdRaw) : '';

        return {
          sessionId,
          user: userDisplay,
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
          userName: userName || userDisplay,
          userId: plexUserId,
          userKey: stableUserKey || userName || userDisplay,
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
      const serverTypeRaw = resp && resp.config && resp.config.serverConfig ? resp.config.serverConfig.type : '';
      const serverType = typeof serverTypeRaw === 'string' ? serverTypeRaw.toLowerCase() : '';
      const keyPrefix = (serverType === 'jellyfin' || serverType === 'emby') ? serverType : '';
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
          const userIdRaw = s.UserId ?? s.userId ?? (s.User && (s.User.Id || s.User.id)) ?? null;
          const userId = userIdRaw != null ? String(userIdRaw) : '';
          const stableKey = (keyPrefix && userId) ? `${keyPrefix}:${userId}` : '';
          return {
            sessionId: s.sessionId || s.sessionKey || s.Id || s.id || '',
            user: s.user || s.UserName || 'Unknown',
            userName: s.UserName || s.user || '',
            userId,
            userKey: stableKey || (s.UserName || s.user || ''),
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
          const userIdRaw = s.UserId || (s.User && (s.User.Id || s.User.id)) || null;
          const userId = userIdRaw != null ? String(userIdRaw) : '';
          const stableKey = (keyPrefix && userId) ? `${keyPrefix}:${userId}` : '';
          return {
            sessionId: s.Id || s.id || '',
            user: s.UserName || 'Unknown',
            userName: s.UserName || '',
            userId,
            userKey: stableKey || (s.UserName || ''),
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

  // Plex frequently defaults to XML unless JSON is requested.
  if (s.type === 'plex') {
    headers['Accept'] = 'application/json';
  }

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
        // Emby commonly uses api_key in query (some setups may also accept X-Emby-Token).
        finalUrl += `${sep}api_key=${encodeURIComponent(s.token)}&X-Emby-Token=${encodeURIComponent(s.token)}`;
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
  if (pollAllInFlight) return;
  pollAllInFlight = true;
  try {
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
        const stType = st && st.type ? String(st.type).toLowerCase() : '';
        const stableFromId = (stType && sess.userId) ? `${stType}:${String(sess.userId)}` : '';
        const userKeyRaw = sess.userKey || stableFromId || sess.userName || sess.username || '';
        const userKey = userKeyRaw ? String(userKeyRaw) : '';
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
            'INSERT INTO history (time, sessionKey, lastSeenAt, serverId, serverName, type, user, userKey, userAvatar, title, mediaType, seriesTitle, episodeTitle, year, channel, isLive, poster, background, stream, transcoding, location, bandwidth, platform, product, player, quality, duration, progress, ip, completed) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
            [
              timestamp,
              sessionKey,
              timestamp,
              st.id,
              st.name,
              st.type,
              user,
              userKey,
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
            'UPDATE history SET lastSeenAt = ?, serverName = ?, user = ?, userKey = ?, userAvatar = ?, title = ?, mediaType = ?, seriesTitle = ?, episodeTitle = ?, year = ?, channel = ?, isLive = ?, poster = ?, background = ?, stream = ?, transcoding = ?, location = ?, bandwidth = ?, platform = ?, product = ?, player = ?, quality = ?, duration = ?, progress = ?, ip = ? WHERE id = ?',
            [
              timestamp,
              st.name,
              user,
              userKey,
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
  } finally {
    pollAllInFlight = false;
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

// Library inventory reports (Plex/Jellyfin/Emby).
// Note: genre/codec/resolution/storage are computed over the *recently added* window for safety.
const libraryInventoryCache = new Map();
const LIBRARY_INVENTORY_CACHE_TTL_MS = 10 * 60 * 1000;

// Full-scan jobs can take a long time on large libraries.
// We run them async and let the UI poll for progress/results.
const libraryInventoryScanJobs = new Map();
const LIBRARY_INVENTORY_JOB_TTL_MS = 6 * 60 * 60 * 1000;

function newJobId() {
  return `${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`;
}

function getJobPublicView(job) {
  if (!job || typeof job !== 'object') return null;
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    server: job.server,
    days: job.days,
    progress: job.progress || null,
    error: job.error || null,
    result: job.status === 'done' ? (job.result || null) : null
  };
}

function cleanupOldLibraryJobs() {
  const now = Date.now();
  for (const [id, job] of libraryInventoryScanJobs.entries()) {
    const updatedMs = job && job.updatedAt ? Date.parse(job.updatedAt) : NaN;
    const ageMs = Number.isFinite(updatedMs) ? (now - updatedMs) : (now - now);
    if (!Number.isFinite(ageMs) || ageMs > LIBRARY_INVENTORY_JOB_TTL_MS) {
      libraryInventoryScanJobs.delete(id);
    }
  }
}

setInterval(cleanupOldLibraryJobs, 10 * 60 * 1000);

function topKFromMap(map, k) {
  if (!map || typeof map !== 'object') return [];
  const arr = [];
  for (const [name, count] of map.entries()) {
    arr.push({ name, count });
  }
  arr.sort((a, b) => (b.count - a.count) || String(a.name).localeCompare(String(b.name)));
  return arr.slice(0, Math.max(0, Math.floor(k || 0)));
}

function formatResolutionLabel(heightOrString) {
  if (heightOrString == null) return '';
  if (typeof heightOrString === 'string') {
    const s = heightOrString.trim();
    if (!s) return '';
    // Plex often returns '1080' as a string.
    if (/^\d+$/.test(s)) return `${s}p`;
    return s;
  }
  const h = Number(heightOrString);
  if (!Number.isFinite(h) || h <= 0) return '';
  return `${Math.round(h)}p`;
}

function addCount(map, key, inc = 1) {
  const k = String(key || '').trim();
  if (!k) return;
  map.set(k, (map.get(k) || 0) + (Number(inc) || 0));
}

function serverBaseUrl(server) {
  const base = (server && server.baseUrl ? String(server.baseUrl) : '').replace(/\/$/, '');
  return base;
}

async function plexGet(server, relPath, params = {}) {
  const base = serverBaseUrl(server);
  const headers = { Accept: 'application/json' };
  const requestParams = { ...(params || {}) };
  if (server && server.token) {
    const tokenLoc = server.tokenLocation || 'query';
    if (tokenLoc === 'header') headers['X-Plex-Token'] = server.token;
    else requestParams['X-Plex-Token'] = server.token;
  }
  return axios.get(base + relPath, { headers, params: requestParams, timeout: 20000 });
}

async function jfEmbyGet(server, relPath, params = {}) {
  const base = serverBaseUrl(server);
  const headers = {};
  const requestParams = { ...(params || {}) };
  if (server && server.token) {
    const tokenLoc = server.tokenLocation || 'header';
    if (tokenLoc === 'header') {
      if (server.type === 'jellyfin') headers['X-MediaBrowser-Token'] = server.token;
      else headers['X-Emby-Token'] = server.token;
    } else {
      if (server.type === 'jellyfin') {
        requestParams.api_key = server.token;
      } else {
        // Emby: prefer api_key in query, but also include X-Emby-Token for compatibility.
        requestParams.api_key = server.token;
        requestParams['X-Emby-Token'] = server.token;
      }
    }
  }
  return axios.get(base + relPath, { headers, params: requestParams, timeout: 25000 });
}

async function buildPlexLibraryReport(server, { days = 7, onProgress } = {}) {
  const nowMs = Date.now();
  const cutoffEpochSec = Math.floor((nowMs - (Math.max(1, Math.floor(days)) * 24 * 60 * 60 * 1000)) / 1000);
  const libsResp = await plexGet(server, '/library/sections');
  const mc = libsResp && libsResp.data && libsResp.data.MediaContainer ? libsResp.data.MediaContainer : null;
  const dirs = mc && Array.isArray(mc.Directory) ? mc.Directory : [];

  const libraries = [];
  for (let libraryIndex = 0; libraryIndex < dirs.length; libraryIndex++) {
    const d = dirs[libraryIndex];
    if (!d) continue;
    const key = d.key != null ? String(d.key) : '';
    if (!key) continue;
    const name = d.title != null ? String(d.title) : (d.name != null ? String(d.name) : `Library ${key}`);
    const libType = d.type != null ? String(d.type) : '';

    if (onProgress) {
      onProgress({
        phase: 'building',
        libraryIndex,
        librariesTotal: dirs.length,
        libraryId: key,
        libraryName: name,
        scanned: 0,
        total: null
      });
    }

    const normalizeRelPath = (v) => {
      if (v == null) return null;
      const s = String(v).trim();
      if (!s) return null;
      if (s.startsWith('/')) return s;
      // If Plex returns a relative path without a leading slash, treat it as relative to server root.
      if (s.includes('://')) return null;
      if (s.startsWith('library/') || s.startsWith(':/') || s.startsWith('photo/')) return `/${s}`;
      return `/${s}`;
    };

    const thumbPath = normalizeRelPath(d.thumb);
    const artPath = normalizeRelPath(d.art);
    // Some Plex setups do not include section-level thumb/art/composite in /library/sections.
    // Only trust the composite path if Plex provided one.
    const compositePath = normalizeRelPath(d.composite);

    const posterFromItem = (item, { preferSeriesPoster = false } = {}) => {
      if (!item || typeof item !== 'object') return null;
      const cand = preferSeriesPoster
        ? (item.grandparentThumb || item.parentThumb || item.thumb || item.art)
        : (item.thumb || item.parentThumb || item.grandparentThumb || item.art);
      return normalizeRelPath(cand);
    };

    const typeLower = libType.toLowerCase();

    // Lightweight timestamps for UI (library age + last added) without requiring a full scan.
    // For TV libraries we consider episodes (type=4) so "last added" aligns with Plex.
    let earliestItemAt = null;
    let latestItemAt = null;
    let earliestPosterPath = null;
    let latestPosterPath = null;

    let totalItems = null;
    let unwatchedItems = null;
    let watchedItems = null;
    let storageBytes = null;

    let movieCount = null;
    let showCount = null;
    let episodeCount = null;

    if (d.totalSize != null) {
      const b = Number(d.totalSize);
      if (Number.isFinite(b) && b >= 0) storageBytes = Math.floor(b);
    }

    try {
      const typeParams = typeLower === 'show' ? { type: 4 } : {};
      const earliestResp = await plexGet(server, `/library/sections/${encodeURIComponent(key)}/all`, {
        sort: 'addedAt:asc',
        'X-Plex-Container-Start': 0,
        'X-Plex-Container-Size': 1,
        ...typeParams
      });
      const emc = earliestResp && earliestResp.data && earliestResp.data.MediaContainer ? earliestResp.data.MediaContainer : null;
      const item = emc && Array.isArray(emc.Metadata) && emc.Metadata[0] ? emc.Metadata[0] : null;
      const addedAt = item && item.addedAt != null ? Number(item.addedAt) : NaN;
      if (Number.isFinite(addedAt) && addedAt > 0) earliestItemAt = new Date(addedAt * 1000).toISOString();
      earliestPosterPath = posterFromItem(item, { preferSeriesPoster: typeLower === 'show' });
    } catch (_) {}

    try {
      const typeParams = typeLower === 'show' ? { type: 4 } : {};
      const latestResp = await plexGet(server, `/library/sections/${encodeURIComponent(key)}/all`, {
        sort: 'addedAt:desc',
        'X-Plex-Container-Start': 0,
        'X-Plex-Container-Size': 1,
        ...typeParams
      });
      const lmc = latestResp && latestResp.data && latestResp.data.MediaContainer ? latestResp.data.MediaContainer : null;
      const item = lmc && Array.isArray(lmc.Metadata) && lmc.Metadata[0] ? lmc.Metadata[0] : null;
      const addedAt = item && item.addedAt != null ? Number(item.addedAt) : NaN;
      if (Number.isFinite(addedAt) && addedAt > 0) latestItemAt = new Date(addedAt * 1000).toISOString();
      latestPosterPath = posterFromItem(item, { preferSeriesPoster: typeLower === 'show' });
    } catch (_) {}

    // Prefer a real item poster if section artwork isn't present.
    const posterPath = latestPosterPath || earliestPosterPath || thumbPath || artPath || compositePath || null;

    try {
      const totals = await plexGet(server, `/library/sections/${encodeURIComponent(key)}/all`, {
        'X-Plex-Container-Start': 0,
        'X-Plex-Container-Size': 0
      });
      const tmc = totals && totals.data && totals.data.MediaContainer ? totals.data.MediaContainer : null;
      const n = tmc && tmc.totalSize != null ? Number(tmc.totalSize) : null;
      if (Number.isFinite(n) && n >= 0) totalItems = Math.floor(n);
    } catch (_) {}

    if (typeLower === 'movie') {
      if (Number.isFinite(totalItems)) movieCount = totalItems;
    } else if (typeLower === 'show') {
      if (Number.isFinite(totalItems)) showCount = totalItems;
      try {
        // Plex: count episodes in a TV library.
        // type=4 filters to episodes.
        const epTotals = await plexGet(server, `/library/sections/${encodeURIComponent(key)}/all`, {
          'X-Plex-Container-Start': 0,
          'X-Plex-Container-Size': 0,
          type: 4
        });
        const emc = epTotals && epTotals.data && epTotals.data.MediaContainer ? epTotals.data.MediaContainer : null;
        const n = emc && emc.totalSize != null ? Number(emc.totalSize) : null;
        if (Number.isFinite(n) && n >= 0) episodeCount = Math.floor(n);
      } catch (_) {}
    }

    try {
      const un = await plexGet(server, `/library/sections/${encodeURIComponent(key)}/all`, {
        'X-Plex-Container-Start': 0,
        'X-Plex-Container-Size': 0,
        unwatched: 1
      });
      const umc = un && un.data && un.data.MediaContainer ? un.data.MediaContainer : null;
      const n = umc && umc.totalSize != null ? Number(umc.totalSize) : null;
      if (Number.isFinite(n) && n >= 0) {
        unwatchedItems = Math.floor(n);
        if (Number.isFinite(totalItems)) watchedItems = Math.max(0, totalItems - unwatchedItems);
      }
    } catch (_) {}

    const genreCounts = new Map();
    const codecCounts = new Map();
    const resolutionCounts = new Map();
    let recentlyAddedCount = 0;
    let recentlyAddedBytes = 0;
    let recentlyLatestEpochSec = null;

    const fullGenreCounts = new Map();
    const fullCodecCounts = new Map();
    const fullResolutionCounts = new Map();
    let fullScanned = 0;
    let fullBytes = 0;
    let fullEarliestEpochSec = null;
    let fullLatestEpochSec = null;

    try {
      let start = 0;
      const pageSize = 200;
      const maxPages = 40;
      const maxScanned = 5000;
      let scanned = 0;
      let done = false;

      const enumerateParams = typeLower === 'show' ? { type: 4 } : {};

      for (let page = 0; page < maxPages && !done; page++) {
        const resp = await plexGet(server, `/library/sections/${encodeURIComponent(key)}/all`, {
          sort: 'addedAt:desc',
          'X-Plex-Container-Start': start,
          'X-Plex-Container-Size': pageSize
          ,
          ...enumerateParams
        });
        const pmc = resp && resp.data && resp.data.MediaContainer ? resp.data.MediaContainer : null;
        const items = pmc && Array.isArray(pmc.Metadata) ? pmc.Metadata : [];
        if (!items.length) break;

        for (const it of items) {
          if (!it) continue;
          const addedAt = typeof it.addedAt === 'number' ? it.addedAt : (typeof it.addedAt === 'string' ? parseInt(it.addedAt, 10) : 0);
          if (!addedAt || addedAt < cutoffEpochSec) {
            done = true;
            break;
          }

          if (Number.isFinite(addedAt) && addedAt > 0) {
            if (recentlyLatestEpochSec == null || addedAt > recentlyLatestEpochSec) recentlyLatestEpochSec = addedAt;
          }

          recentlyAddedCount++;
          scanned++;
          if (scanned >= maxScanned) {
            done = true;
            break;
          }

          const genres = Array.isArray(it.Genre) ? it.Genre : [];
          for (const g of genres) {
            const tag = g && g.tag != null ? String(g.tag) : '';
            addCount(genreCounts, tag, 1);
          }

          const medias = Array.isArray(it.Media) ? it.Media : [];
          for (const m of medias) {
            if (!m) continue;
            addCount(codecCounts, m.videoCodec, 1);
            const resLabel = formatResolutionLabel(m.videoResolution || m.height);
            addCount(resolutionCounts, resLabel, 1);
            const parts = Array.isArray(m.Part) ? m.Part : [];
            for (const p of parts) {
              const sz = p && p.size != null ? Number(p.size) : null;
              if (Number.isFinite(sz) && sz > 0) recentlyAddedBytes += Math.floor(sz);
            }
          }
        }

        start += pageSize;
      }
    } catch (_) {}

    // Full scan: walk every item in the library.
    // This can take a long time; intended to be run via the job runner.
    const runFullScan = async (onProgress) => {
      try {
        let start = 0;
        const pageSize = 200;
        const enumerateParams = typeLower === 'show' ? { type: 4 } : {};
        // Iterate until Plex returns no more items.
        while (true) {
          const resp = await plexGet(server, `/library/sections/${encodeURIComponent(key)}/all`, {
            'X-Plex-Container-Start': start,
            'X-Plex-Container-Size': pageSize,
            ...enumerateParams
          });
          const pmc = resp && resp.data && resp.data.MediaContainer ? resp.data.MediaContainer : null;
          const items = pmc && Array.isArray(pmc.Metadata) ? pmc.Metadata : [];
          const total = pmc && pmc.totalSize != null ? Number(pmc.totalSize) : null;
          if (onProgress) {
            onProgress({
              libraryId: key,
              libraryName: name,
              scanned: fullScanned,
              total: Number.isFinite(total) ? Math.floor(total) : null
            });
          }
          if (!items.length) break;
          for (const it of items) {
            if (!it) continue;
            fullScanned++;
            const addedAt = typeof it.addedAt === 'number' ? it.addedAt : (typeof it.addedAt === 'string' ? parseInt(it.addedAt, 10) : NaN);
            if (Number.isFinite(addedAt) && addedAt > 0) {
              if (fullEarliestEpochSec == null || addedAt < fullEarliestEpochSec) fullEarliestEpochSec = addedAt;
              if (fullLatestEpochSec == null || addedAt > fullLatestEpochSec) fullLatestEpochSec = addedAt;
            }
            const genres = Array.isArray(it.Genre) ? it.Genre : [];
            for (const g of genres) {
              const tag = g && g.tag != null ? String(g.tag) : '';
              addCount(fullGenreCounts, tag, 1);
            }
            const medias = Array.isArray(it.Media) ? it.Media : [];
            for (const m of medias) {
              if (!m) continue;
              addCount(fullCodecCounts, m.videoCodec, 1);
              const resLabel = formatResolutionLabel(m.videoResolution || m.height);
              addCount(fullResolutionCounts, resLabel, 1);
              const parts = Array.isArray(m.Part) ? m.Part : [];
              for (const p of parts) {
                const sz = p && p.size != null ? Number(p.size) : null;
                if (Number.isFinite(sz) && sz > 0) fullBytes += Math.floor(sz);
              }
            }
          }
          start += pageSize;
        }
      } catch (_) {
        // Best-effort; leave fullScan fields empty on failure.
      }
    };

    libraries.push({
      id: key,
      name,
      type: libType,
      thumbPath,
      artPath,
      compositePath,
      posterPath,
      earliestItemAt,
      latestItemAt,
      totalItems,
      movieCount,
      showCount,
      episodeCount,
      unwatchedItems,
      watchedItems,
      recentlyAddedCount,
      recentlyAdded: {
        topGenres: topKFromMap(genreCounts, 5),
        topVideoCodecs: topKFromMap(codecCounts, 5),
        topResolutions: topKFromMap(resolutionCounts, 5),
        bytes: recentlyAddedBytes,
        latestItemAt: recentlyLatestEpochSec ? new Date(recentlyLatestEpochSec * 1000).toISOString() : null
      },
      storageBytes,
      _fullScanRunner: runFullScan,
      _fullScanState: {
        scannedItems: () => fullScanned,
        bytes: () => fullBytes,
        earliestItemAt: () => fullEarliestEpochSec ? new Date(fullEarliestEpochSec * 1000).toISOString() : null,
        latestItemAt: () => fullLatestEpochSec ? new Date(fullLatestEpochSec * 1000).toISOString() : null,
        topGenres: () => topKFromMap(fullGenreCounts, 5),
        topVideoCodecs: () => topKFromMap(fullCodecCounts, 5),
        topResolutions: () => topKFromMap(fullResolutionCounts, 5)
      }
    });
  }

  return { libraries, days: Math.max(1, Math.floor(days)) };
}

async function buildJellyfinEmbyLibraryReport(server, { days = 7, userId: userIdOverride, onProgress } = {}) {
  const nowMs = Date.now();
  const cutoffMs = nowMs - (Math.max(1, Math.floor(days)) * 24 * 60 * 60 * 1000);

  let userId = userIdOverride ? String(userIdOverride) : '';
  if (!userId) {
    const usersResp = await jfEmbyGet(server, '/Users');
    const users = Array.isArray(usersResp.data) ? usersResp.data : [];
    const u = users.find(x => x && x.Id) || users[0];
    userId = u && u.Id ? String(u.Id) : '';
  }

  if (!userId) {
    return {
      days: Math.max(1, Math.floor(days)),
      userId: '',
      libraries: [],
      warning: 'No user available to enumerate libraries.'
    };
  }

  const viewsResp = await jfEmbyGet(server, `/Users/${encodeURIComponent(userId)}/Views`);
  const viewItems = viewsResp && viewsResp.data && Array.isArray(viewsResp.data.Items) ? viewsResp.data.Items : [];

  const views = viewItems.filter(v => v && v.Id);

  const libraries = [];
  for (let libraryIndex = 0; libraryIndex < views.length; libraryIndex++) {
    const v = views[libraryIndex];
    const libId = String(v.Id);
    const name = v.Name != null ? String(v.Name) : `Library ${libId}`;
    const libType = v.CollectionType != null ? String(v.CollectionType) : (v.Type != null ? String(v.Type) : '');

    if (onProgress) {
      onProgress({
        phase: 'building',
        libraryIndex,
        librariesTotal: views.length,
        libraryId: libId,
        libraryName: name,
        scanned: 0,
        total: null
      });
    }

    // Jellyfin/Emby: library views usually support /Items/:id/Images/Primary
    // (may 404 if the server has no image for that view; the UI will fall back).
    const thumbPath = `/Items/${libId}/Images/Primary?maxWidth=96&maxHeight=96&quality=90`;
    const posterPath = thumbPath;

    // Lightweight timestamps for UI (library age + last added) without requiring a full scan.
    let earliestItemAt = null;
    let latestItemAt = null;
    try {
      const earliestResp = await jfEmbyGet(server, `/Users/${encodeURIComponent(userId)}/Items`, {
        ParentId: libId,
        Recursive: true,
        IncludeItemTypes: 'Movie,Episode',
        SortBy: 'DateCreated',
        SortOrder: 'Ascending',
        StartIndex: 0,
        Limit: 1
      });
      const items = earliestResp && earliestResp.data && Array.isArray(earliestResp.data.Items) ? earliestResp.data.Items : [];
      const it = items && items[0] ? items[0] : null;
      const raw = it && (it.DateCreated || it.PremiereDate || it.ProductionDate);
      const ms = raw ? Date.parse(raw) : NaN;
      if (Number.isFinite(ms)) earliestItemAt = new Date(ms).toISOString();
    } catch (_) {}
    try {
      const latestResp = await jfEmbyGet(server, `/Users/${encodeURIComponent(userId)}/Items`, {
        ParentId: libId,
        Recursive: true,
        IncludeItemTypes: 'Movie,Episode',
        SortBy: 'DateCreated',
        SortOrder: 'Descending',
        StartIndex: 0,
        Limit: 1
      });
      const items = latestResp && latestResp.data && Array.isArray(latestResp.data.Items) ? latestResp.data.Items : [];
      const it = items && items[0] ? items[0] : null;
      const raw = it && (it.DateCreated || it.PremiereDate || it.ProductionDate);
      const ms = raw ? Date.parse(raw) : NaN;
      if (Number.isFinite(ms)) latestItemAt = new Date(ms).toISOString();
    } catch (_) {}

    let movieCount = null;
    let showCount = null;
    let episodeCount = null;

    const genreCounts = new Map();
    const codecCounts = new Map();
    const resolutionCounts = new Map();
    let recentlyAddedCount = 0;
    let recentlyAddedBytes = 0;
    let recentlyLatestMs = null;

    const fullGenreCounts = new Map();
    const fullCodecCounts = new Map();
    const fullResolutionCounts = new Map();
    let fullScanned = 0;
    let fullBytes = 0;
    let fullEarliestMs = null;
    let fullLatestMs = null;

    let totalPlayableItems = null;
    let unplayedItems = null;
    let playedItems = null;
    let totalItems = null;

    // Type-specific counts for summary UIs.
    try {
      const movieResp = await jfEmbyGet(server, `/Users/${encodeURIComponent(userId)}/Items`, {
        ParentId: libId,
        Recursive: true,
        IncludeItemTypes: 'Movie',
        Limit: 1
      });
      const total = movieResp && movieResp.data && movieResp.data.TotalRecordCount != null ? Number(movieResp.data.TotalRecordCount) : null;
      if (Number.isFinite(total) && total >= 0) movieCount = Math.floor(total);
    } catch (_) {}

    try {
      const showResp = await jfEmbyGet(server, `/Users/${encodeURIComponent(userId)}/Items`, {
        ParentId: libId,
        Recursive: true,
        IncludeItemTypes: 'Series',
        Limit: 1
      });
      const total = showResp && showResp.data && showResp.data.TotalRecordCount != null ? Number(showResp.data.TotalRecordCount) : null;
      if (Number.isFinite(total) && total >= 0) showCount = Math.floor(total);
    } catch (_) {}

    try {
      const epResp = await jfEmbyGet(server, `/Users/${encodeURIComponent(userId)}/Items`, {
        ParentId: libId,
        Recursive: true,
        IncludeItemTypes: 'Episode',
        Limit: 1
      });
      const total = epResp && epResp.data && epResp.data.TotalRecordCount != null ? Number(epResp.data.TotalRecordCount) : null;
      if (Number.isFinite(total) && total >= 0) episodeCount = Math.floor(total);
    } catch (_) {}

    try {
      const totalResp = await jfEmbyGet(server, `/Users/${encodeURIComponent(userId)}/Items`, {
        ParentId: libId,
        Recursive: true,
        IncludeItemTypes: 'Movie,Episode',
        Limit: 1
      });
      const total = totalResp && totalResp.data && totalResp.data.TotalRecordCount != null ? Number(totalResp.data.TotalRecordCount) : null;
      if (Number.isFinite(total) && total >= 0) totalPlayableItems = Math.floor(total);
    } catch (_) {}

    try {
      const totalAnyResp = await jfEmbyGet(server, `/Users/${encodeURIComponent(userId)}/Items`, {
        ParentId: libId,
        Recursive: true,
        Limit: 1
      });
      const total = totalAnyResp && totalAnyResp.data && totalAnyResp.data.TotalRecordCount != null ? Number(totalAnyResp.data.TotalRecordCount) : null;
      if (Number.isFinite(total) && total >= 0) totalItems = Math.floor(total);
    } catch (_) {}

    try {
      const unResp = await jfEmbyGet(server, `/Users/${encodeURIComponent(userId)}/Items`, {
        ParentId: libId,
        Recursive: true,
        IncludeItemTypes: 'Movie,Episode',
        Filters: 'IsUnplayed',
        Limit: 1
      });
      const total = unResp && unResp.data && unResp.data.TotalRecordCount != null ? Number(unResp.data.TotalRecordCount) : null;
      if (Number.isFinite(total) && total >= 0) {
        unplayedItems = Math.floor(total);
        if (Number.isFinite(totalPlayableItems)) playedItems = Math.max(0, totalPlayableItems - unplayedItems);
      }
    } catch (_) {}

    try {
      let startIndex = 0;
      const pageSize = 200;
      const maxPages = 40;
      const maxScanned = 5000;
      let scanned = 0;
      let done = false;

      for (let page = 0; page < maxPages && !done; page++) {
        const resp = await jfEmbyGet(server, `/Users/${encodeURIComponent(userId)}/Items`, {
          ParentId: libId,
          Recursive: true,
          IncludeItemTypes: 'Movie,Episode',
          SortBy: 'DateCreated',
          SortOrder: 'Descending',
          StartIndex: startIndex,
          Limit: pageSize
        });
        const items = resp && resp.data && Array.isArray(resp.data.Items) ? resp.data.Items : [];
        if (!items.length) break;

        for (const it of items) {
          if (!it) continue;
          const createdRaw = it.DateCreated || it.PremiereDate || it.ProductionDate;
          const createdMs = createdRaw ? Date.parse(createdRaw) : NaN;
          if (!Number.isFinite(createdMs) || createdMs < cutoffMs) {
            done = true;
            break;
          }

          if (Number.isFinite(createdMs)) {
            if (recentlyLatestMs == null || createdMs > recentlyLatestMs) recentlyLatestMs = createdMs;
          }

          recentlyAddedCount++;
          scanned++;
          if (scanned >= maxScanned) {
            done = true;
            break;
          }

          const genres = Array.isArray(it.Genres) ? it.Genres : [];
          for (const g of genres) addCount(genreCounts, g, 1);

          const mediaSources = Array.isArray(it.MediaSources) ? it.MediaSources : [];
          for (const src of mediaSources) {
            if (!src) continue;
            if (src.Size != null) {
              const sz = Number(src.Size);
              if (Number.isFinite(sz) && sz > 0) recentlyAddedBytes += Math.floor(sz);
            }

            const streams = Array.isArray(src.MediaStreams) ? src.MediaStreams : [];
            const video = streams.find(s => s && (s.Type === 'Video' || s.Type === 2)) || null;
            if (video) {
              addCount(codecCounts, video.Codec, 1);
              addCount(resolutionCounts, formatResolutionLabel(video.Height), 1);
            }
          }
        }

        startIndex += pageSize;
      }
    } catch (_) {}

    const runFullScan = async (onProgress) => {
      try {
        let startIndex = 0;
        const pageSize = 200;
        // Pull items in pages until there are no more.
        while (true) {
          const resp = await jfEmbyGet(server, `/Users/${encodeURIComponent(userId)}/Items`, {
            ParentId: libId,
            Recursive: true,
            IncludeItemTypes: 'Movie,Episode',
            SortBy: 'SortName',
            SortOrder: 'Ascending',
            StartIndex: startIndex,
            Limit: pageSize,
            Fields: 'Genres,MediaSources'
          });
          const items = resp && resp.data && Array.isArray(resp.data.Items) ? resp.data.Items : [];
          const total = resp && resp.data && resp.data.TotalRecordCount != null ? Number(resp.data.TotalRecordCount) : null;
          if (onProgress) {
            onProgress({
              libraryId: libId,
              libraryName: name,
              scanned: fullScanned,
              total: Number.isFinite(total) ? Math.floor(total) : null
            });
          }
          if (!items.length) break;

          for (const it of items) {
            if (!it) continue;
            fullScanned++;

            const createdRaw = it.DateCreated || it.PremiereDate || it.ProductionDate;
            const createdMs = createdRaw ? Date.parse(createdRaw) : NaN;
            if (Number.isFinite(createdMs)) {
              if (fullEarliestMs == null || createdMs < fullEarliestMs) fullEarliestMs = createdMs;
              if (fullLatestMs == null || createdMs > fullLatestMs) fullLatestMs = createdMs;
            }
            const genres = Array.isArray(it.Genres) ? it.Genres : [];
            for (const g of genres) addCount(fullGenreCounts, g, 1);

            const mediaSources = Array.isArray(it.MediaSources) ? it.MediaSources : [];
            for (const src of mediaSources) {
              if (!src) continue;
              if (src.Size != null) {
                const sz = Number(src.Size);
                if (Number.isFinite(sz) && sz > 0) fullBytes += Math.floor(sz);
              }

              const streams = Array.isArray(src.MediaStreams) ? src.MediaStreams : [];
              const video = streams.find(s => s && (s.Type === 'Video' || s.Type === 2)) || null;
              if (video) {
                addCount(fullCodecCounts, video.Codec, 1);
                addCount(fullResolutionCounts, formatResolutionLabel(video.Height), 1);
              }
            }
          }

          startIndex += pageSize;
        }
      } catch (_) {
        // Best-effort; leave fullScan fields empty on failure.
      }
    };

    libraries.push({
      id: libId,
      name,
      type: libType,
      thumbPath,
      posterPath,
      earliestItemAt,
      latestItemAt,
      totalItems,
      movieCount,
      showCount,
      episodeCount,
      totalPlayableItems,
      unwatchedItems: unplayedItems,
      watchedItems: playedItems,
      recentlyAddedCount,
      recentlyAdded: {
        topGenres: topKFromMap(genreCounts, 5),
        topVideoCodecs: topKFromMap(codecCounts, 5),
        topResolutions: topKFromMap(resolutionCounts, 5),
        bytes: recentlyAddedBytes,
        latestItemAt: Number.isFinite(recentlyLatestMs) ? new Date(recentlyLatestMs).toISOString() : null
      },
      _fullScanRunner: runFullScan,
      _fullScanState: {
        scannedItems: () => fullScanned,
        bytes: () => fullBytes,
        earliestItemAt: () => Number.isFinite(fullEarliestMs) ? new Date(fullEarliestMs).toISOString() : null,
        latestItemAt: () => Number.isFinite(fullLatestMs) ? new Date(fullLatestMs).toISOString() : null,
        topGenres: () => topKFromMap(fullGenreCounts, 5),
        topVideoCodecs: () => topKFromMap(fullCodecCounts, 5),
        topResolutions: () => topKFromMap(fullResolutionCounts, 5)
      }
    });
  }

  return {
    days: Math.max(1, Math.floor(days)),
    userId,
    libraries
  };
}

async function buildLibraryInventoryPayload({ server, days, userId, fullScan, onProgress } = {}) {
  const type = String(server && server.type ? server.type : '').toLowerCase();
  let report;
  if (type === 'plex') {
    report = await buildPlexLibraryReport(server, { days, onProgress: fullScan ? onProgress : null });
  } else if (type === 'jellyfin' || type === 'emby') {
    report = await buildJellyfinEmbyLibraryReport(server, { days, userId, onProgress: fullScan ? onProgress : null });
  } else {
    throw new Error('Unsupported server type for library inventory reports');
  }

  if (fullScan) {
    const libs = Array.isArray(report.libraries) ? report.libraries : [];
    for (let i = 0; i < libs.length; i++) {
      const lib = libs[i];
      if (onProgress) {
        onProgress({
          phase: 'scanning',
          libraryIndex: i,
          librariesTotal: libs.length,
          libraryId: lib && lib.id != null ? String(lib.id) : '',
          libraryName: lib && lib.name != null ? String(lib.name) : ''
        });
      }
      if (lib && typeof lib._fullScanRunner === 'function') {
        await lib._fullScanRunner((p) => {
          if (onProgress) {
            onProgress({
              phase: 'library',
              libraryIndex: i,
              librariesTotal: libs.length,
              ...p
            });
          }
        });
      }

      // Attach fullScan summary.
      if (lib && lib._fullScanState && typeof lib._fullScanState === 'object') {
        try {
          lib.fullScan = {
            scannedItems: Number(lib._fullScanState.scannedItems && lib._fullScanState.scannedItems()) || 0,
            bytes: Number(lib._fullScanState.bytes && lib._fullScanState.bytes()) || 0,
            earliestItemAt: lib._fullScanState.earliestItemAt ? lib._fullScanState.earliestItemAt() : null,
            latestItemAt: lib._fullScanState.latestItemAt ? lib._fullScanState.latestItemAt() : null,
            topGenres: lib._fullScanState.topGenres ? lib._fullScanState.topGenres() : [],
            topVideoCodecs: lib._fullScanState.topVideoCodecs ? lib._fullScanState.topVideoCodecs() : [],
            topResolutions: lib._fullScanState.topResolutions ? lib._fullScanState.topResolutions() : []
          };
        } catch (_) {
          // ignore
        }
      }

      // Remove internal fields.
      delete lib._fullScanRunner;
      delete lib._fullScanState;
    }
  } else {
    // Strip internal fields if present.
    const libs = Array.isArray(report.libraries) ? report.libraries : [];
    for (const lib of libs) {
      if (lib && typeof lib === 'object') {
        delete lib._fullScanRunner;
        delete lib._fullScanState;
      }
    }
  }

  return {
    server: {
      id: String(server.id),
      name: server.name || server.baseUrl,
      type
    },
    generatedAt: new Date().toISOString(),
    days,
    mode: fullScan ? 'full' : 'recent',
    ...report
  };
}

app.get('/api/reports/library-inventory', async (req, res) => {
  try {
    const serverIdRaw = req.query.serverId;
    const serverId = serverIdRaw != null ? String(serverIdRaw) : '';
    if (!serverId) return res.status(400).json({ error: 'serverId is required' });

    const server = (Array.isArray(servers) ? servers : []).find(s => s && String(s.id) === serverId);
    if (!server || !server.baseUrl) return res.status(404).json({ error: 'Server not found' });
    if (server.disabled) return res.status(404).json({ error: 'Server is disabled' });

    const daysRaw = Number(req.query.days ?? 7);
    const days = Number.isFinite(daysRaw) ? Math.max(1, Math.min(365, Math.floor(daysRaw))) : 7;
    const userId = req.query.userId != null ? String(req.query.userId) : '';

    const cacheKey = `${String(server.id)}|${String(server.type || '')}|${days}|${userId}`;
    const cached = libraryInventoryCache.get(cacheKey);
    const now = Date.now();
    if (cached && cached.atMs && (now - cached.atMs) < LIBRARY_INVENTORY_CACHE_TTL_MS && cached.data) {
      return res.json({ ...cached.data, cached: true });
    }

    const payload = await buildLibraryInventoryPayload({ server, days, userId, fullScan: false });

    libraryInventoryCache.set(cacheKey, { atMs: now, data: payload });
    res.json(payload);
  } catch (e) {
    const status = e && e.response && typeof e.response.status === 'number' ? e.response.status : null;
    const detail = e && e.message ? String(e.message) : 'Library inventory failed';
    console.error('[OmniStream] Reports library-inventory failed:', detail);
    if (status && status >= 400 && status < 600) {
      return res.status(status).json({ error: 'Failed to build library report', detail, status });
    }
    res.status(500).json({ error: 'Failed to build library report', detail });
  }
});

app.post('/api/reports/library-inventory/full-scan', async (req, res) => {
  try {
    const body = (req && req.body && typeof req.body === 'object') ? req.body : {};
    const serverId = body.serverId != null ? String(body.serverId) : '';
    if (!serverId) return res.status(400).json({ error: 'serverId is required' });

    const server = (Array.isArray(servers) ? servers : []).find(s => s && String(s.id) === serverId);
    if (!server || !server.baseUrl) return res.status(404).json({ error: 'Server not found' });
    if (server.disabled) return res.status(404).json({ error: 'Server is disabled' });

    const daysRaw = Number(body.days ?? 7);
    const days = Number.isFinite(daysRaw) ? Math.max(1, Math.min(365, Math.floor(daysRaw))) : 7;
    const userId = body.userId != null ? String(body.userId) : '';

    const id = newJobId();
    const job = {
      id,
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      server: {
        id: String(server.id),
        name: server.name || server.baseUrl,
        type: String(server.type || '').toLowerCase()
      },
      days,
      progress: {
        phase: 'starting',
        libraryIndex: 0,
        librariesTotal: 0,
        libraryId: '',
        libraryName: '',
        scanned: 0,
        total: null
      },
      error: null,
      result: null
    };
    libraryInventoryScanJobs.set(id, job);

    // Fire and forget.
    (async () => {
      try {
        const payload = await buildLibraryInventoryPayload({
          server,
          days,
          userId,
          fullScan: true,
          onProgress: (p) => {
            job.progress = { ...(job.progress || {}), ...(p || {}) };
            job.updatedAt = new Date().toISOString();
          }
        });
        job.result = payload;
        job.status = 'done';
        job.updatedAt = new Date().toISOString();
      } catch (e) {
        job.status = 'error';
        job.error = e && e.message ? String(e.message) : 'Full scan failed';
        job.updatedAt = new Date().toISOString();
      }
    })();

    res.status(202).json(getJobPublicView(job));
  } catch (e) {
    const status = e && e.response && typeof e.response.status === 'number' ? e.response.status : null;
    const detail = e && e.message ? String(e.message) : 'Failed to start full scan';
    console.error('[OmniStream] Reports library full-scan start failed:', detail);
    if (status && status >= 400 && status < 600) {
      return res.status(status).json({ error: 'Failed to start full scan', detail, status });
    }
    res.status(500).json({ error: 'Failed to start full scan', detail });
  }
});

app.get('/api/reports/library-inventory/full-scan/:id', async (req, res) => {
  try {
    const id = req && req.params && req.params.id ? String(req.params.id) : '';
    const job = id ? libraryInventoryScanJobs.get(id) : null;
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(getJobPublicView(job));
  } catch (e) {
    res.status(500).json({ error: 'Failed to load job', detail: e.message });
  }
});

app.get('/api/reports/watch-statistics', async (req, res) => {
  try {
    if (!historyDb || !historyDbReady) {
      return res.status(503).json({ error: 'History database not ready' });
    }

    const knownServerIds = new Set((Array.isArray(servers) ? servers : [])
      .filter(s => s && typeof s.id !== 'undefined' && s.id !== null)
      .map(s => String(s.id)));

    const sanitizeArtworkValue = (v) => {
      if (!v) return null;
      const s = String(v);
      if (!s || s === '/live_tv_placeholder.svg') return null;
      if (!s.startsWith('/api/poster?')) return s;
      try {
        const u = new URL(s, 'http://localhost');
        const serverId = u.searchParams.get('serverId');
        if (!serverId) return null;
        return knownServerIds.has(String(serverId)) ? s : null;
      } catch (_) {
        return null;
      }
    };

    const sanitizeArtworkRows = (rows) => {
      if (!Array.isArray(rows)) return rows;
      return rows.map(r => {
        if (r && typeof r === 'object') {
          r.poster = sanitizeArtworkValue(r.poster);
          r.background = sanitizeArtworkValue(r.background);
        }
        return r;
      });
    };

    const metricRaw = (req.query.metric || 'count').toString().toLowerCase();
    const metric = metricRaw === 'duration' ? 'duration' : 'count';
    const daysRaw = Number(req.query.days ?? 1000);
    const days = Number.isFinite(daysRaw) ? Math.max(1, Math.min(5000, Math.floor(daysRaw))) : 1000;

    const parseDateYmd = (s) => {
      const raw = String(s || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
      const [y, m, d] = raw.split('-').map(n => parseInt(n, 10));
      if (!y || !m || !d) return null;
      return { y, m, d };
    };
    const fromRaw = req.query.from;
    const toRaw = req.query.to;
    const fromYmd = parseDateYmd(fromRaw);
    const toYmd = parseDateYmd(toRaw);

    const nowMs = Date.now();
    const defaultEndIso = new Date(nowMs).toISOString();

    const isValidLocalYmd = ({ y, m, d }) => {
      const dt = new Date(y, m - 1, d);
      return dt.getFullYear() === y && dt.getMonth() === (m - 1) && dt.getDate() === d;
    };

    let startIso;
    let endIso;
    if (fromYmd && toYmd && isValidLocalYmd(fromYmd) && isValidLocalYmd(toYmd)) {
      // Interpret YYYY-MM-DD as a *local* date range, then convert to ISO (UTC) for storage/compare.
      // This avoids off-by-one-day issues when the UI is using local dates but stored timestamps are UTC ISO strings.
      startIso = new Date(fromYmd.y, fromYmd.m - 1, fromYmd.d, 0, 0, 0, 0).toISOString();
      endIso = new Date(toYmd.y, toYmd.m - 1, toYmd.d, 23, 59, 59, 999).toISOString();
    } else {
      startIso = new Date(nowMs - days * 24 * 60 * 60 * 1000).toISOString();
      endIso = defaultEndIso;
    }
    const eventTimeExpr = 'COALESCE(endedAt, lastSeenAt, time)';
    const userIdentityExpr = "COALESCE(NULLIF(userKey,''), NULLIF(user,''))";
    // SQLite MAX(text) chooses the lexicographically-greatest string.
    // Our placeholder '/live_tv_placeholder.svg' sorts *after* '/api/poster?...',
    // so MAX(poster) can incorrectly prefer the placeholder even when real artwork exists.
    const posterAggExpr = "MAX(NULLIF(NULLIF(poster,''), '/live_tv_placeholder.svg'))";
    const backgroundAggExpr = "MAX(NULLIF(NULLIF(background,''), '/live_tv_placeholder.svg'))";
    const watchSecondsExpr = `CASE
      WHEN duration IS NULL THEN 0
      WHEN progress IS NULL THEN duration
      WHEN progress < 0 THEN 0
      WHEN progress > 100 THEN duration
      ELSE CAST(duration * (progress / 100.0) AS INTEGER)
    END`;

    const uniqueTitleKeyExpr = `CASE
      WHEN isLive = 1 THEN 'lv|' || COALESCE(NULLIF(channel,''), NULLIF(title,''), 'Unknown')
      WHEN mediaType = 'episode' THEN 'ep|' || COALESCE(NULLIF(seriesTitle,''), NULLIF(title,''), 'Unknown') || '|' || COALESCE(NULLIF(episodeTitle,''), '')
      WHEN mediaType = 'movie' THEN 'mv|' || COALESCE(NULLIF(title,''), 'Unknown') || '|' || COALESCE(CAST(year AS TEXT), '')
      WHEN mediaType = 'track' THEN 'tr|' || COALESCE(NULLIF(seriesTitle,''), 'Unknown') || '|' || COALESCE(NULLIF(title,''), 'Unknown')
      ELSE 'ot|' || COALESCE(NULLIF(title,''), 'Unknown')
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
      summaryRows,
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
        `SELECT
           COUNT(*) AS totalPlays,
           SUM(${watchSecondsExpr}) AS watchTimeSeconds,
           COUNT(DISTINCT ${userIdentityExpr}) AS uniqueUsers,
           COUNT(DISTINCT ${uniqueTitleKeyExpr}) AS uniqueTitles
         FROM history
         WHERE ${eventTimeExpr} >= ?
           AND ${eventTimeExpr} <= ?`,
        [startIso, endIso]
      ),
      dbAll(
        `SELECT title AS name, year, ${posterAggExpr} AS poster, ${backgroundAggExpr} AS background, ${valueExpr} AS value
         FROM history
         WHERE mediaType = 'movie' AND ${eventTimeExpr} >= ? AND ${eventTimeExpr} <= ?
         GROUP BY title, year
         ORDER BY value DESC
         LIMIT ?`,
        [startIso, endIso, topLimit]
      ),
      dbAll(
        `SELECT title AS name, year, ${posterAggExpr} AS poster, ${backgroundAggExpr} AS background, COUNT(DISTINCT ${userIdentityExpr}) AS value
         FROM history
         WHERE mediaType = 'movie' AND ${eventTimeExpr} >= ? AND ${eventTimeExpr} <= ?
         GROUP BY title, year
         ORDER BY value DESC
         LIMIT ?`,
        [startIso, endIso, topLimit]
      ),
      dbAll(
        `SELECT COALESCE(NULLIF(seriesTitle,''), title) AS name, ${posterAggExpr} AS poster, ${backgroundAggExpr} AS background, ${valueExpr} AS value
         FROM history
         WHERE mediaType = 'episode' AND ${eventTimeExpr} >= ? AND ${eventTimeExpr} <= ?
         GROUP BY name
         ORDER BY value DESC
         LIMIT ?`,
        [startIso, endIso, topLimit]
      ),
      dbAll(
        `SELECT COALESCE(NULLIF(seriesTitle,''), title) AS name, ${posterAggExpr} AS poster, ${backgroundAggExpr} AS background, COUNT(DISTINCT ${userIdentityExpr}) AS value
         FROM history
         WHERE mediaType = 'episode' AND ${eventTimeExpr} >= ? AND ${eventTimeExpr} <= ?
         GROUP BY name
         ORDER BY value DESC
         LIMIT ?`,
        [startIso, endIso, topLimit]
      ),
      dbAll(
        `SELECT COALESCE(NULLIF(seriesTitle,''), 'Unknown') AS name, ${posterAggExpr} AS poster, ${backgroundAggExpr} AS background, ${valueExpr} AS value
         FROM history
         WHERE mediaType = 'track' AND ${eventTimeExpr} >= ? AND ${eventTimeExpr} <= ?
         GROUP BY name
         ORDER BY value DESC
         LIMIT ?`,
        [startIso, endIso, topLimit]
      ),
      dbAll(
        `SELECT COALESCE(NULLIF(seriesTitle,''), 'Unknown') AS name, ${posterAggExpr} AS poster, ${backgroundAggExpr} AS background, COUNT(DISTINCT ${userIdentityExpr}) AS value
         FROM history
         WHERE mediaType = 'track' AND ${eventTimeExpr} >= ? AND ${eventTimeExpr} <= ?
         GROUP BY name
         ORDER BY value DESC
         LIMIT ?`,
        [startIso, endIso, topLimit]
      ),
      dbAll(
        `SELECT ${eventTimeExpr} AS eventTime, user, userAvatar, title, mediaType, seriesTitle, episodeTitle, year, poster, background
         FROM history
         WHERE ${eventTimeExpr} >= ? AND ${eventTimeExpr} <= ?
         ORDER BY ${eventTimeExpr} DESC
         LIMIT ?`,
        [startIso, endIso, topLimit]
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
         WHERE ${eventTimeExpr} >= ? AND ${eventTimeExpr} <= ?
         GROUP BY name
         ORDER BY value DESC
         LIMIT ?`,
        [startIso, endIso, topLimit]
      ),
      dbAll(
        `SELECT
           ${userIdentityExpr} AS userKey,
           COALESCE(NULLIF(MAX(user),''), ${userIdentityExpr}, 'Unknown') AS name,
           MAX(userAvatar) AS avatar,
           ${valueExpr} AS value
         FROM history
         WHERE ${eventTimeExpr} >= ? AND ${eventTimeExpr} <= ?
         GROUP BY ${userIdentityExpr}
         ORDER BY value DESC
         LIMIT ?`,
        [startIso, endIso, topLimit]
      ),
      dbAll(
        `SELECT COALESCE(NULLIF(platform,''), 'Unknown') AS name, ${valueExpr} AS value
         FROM history
         WHERE ${eventTimeExpr} >= ? AND ${eventTimeExpr} <= ?
         GROUP BY name
         ORDER BY value DESC
         LIMIT ?`,
        [startIso, endIso, topLimit]
      )
    ]);

    // Peak concurrency (max) over the selected window, based on history intervals.
    // IMPORTANT: match the dashboard behavior by excluding disabled servers.
    const enabledIds = new Set((Array.isArray(servers) ? servers : [])
      .filter(s => s && !s.disabled)
      .map(s => String(s.id)));

    const computePeakConcurrencyFromHistory = async () => {
      const rangeStartMs = Date.parse(startIso);
      const rangeEndIso = endIso;
      const rangeEndMs = Date.parse(endIso);
      if (!Number.isFinite(rangeStartMs) || !Number.isFinite(rangeEndMs) || rangeEndMs <= rangeStartMs) {
        return { streams: 0, transcodes: 0, directStreams: 0, directPlays: 0 };
      }

      const enabledIdList = Array.from(enabledIds);
      if (!enabledIdList.length) return { streams: 0, transcodes: 0, directStreams: 0, directPlays: 0 };
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
        const isDirectStream = isDirect && (
          streamTxt.includes('direct stream') ||
          streamTxt.includes('directstream') ||
          streamTxt.includes('copy')
        );
        const isDirectPlay = isDirect && !isDirectStream;

        // Use [start, end) intervals. Apply end before start at the same timestamp.
        events.push({
          t: startMs,
          order: 1,
          all: +1,
          trans: isTranscoding ? +1 : 0,
          ds: isDirectStream ? +1 : 0,
          dp: isDirectPlay ? +1 : 0
        });
        events.push({
          t: endMs,
          order: 0,
          all: -1,
          trans: isTranscoding ? -1 : 0,
          ds: isDirectStream ? -1 : 0,
          dp: isDirectPlay ? -1 : 0
        });
      }

      events.sort((a, b) => (a.t - b.t) || (a.order - b.order));
      let curAll = 0, curTrans = 0, curDs = 0, curDp = 0;
      let peakAll = 0, peakTrans = 0, peakDs = 0, peakDp = 0;
      for (const ev of events) {
        curAll += ev.all;
        curTrans += ev.trans;
        curDs += ev.ds;
        curDp += ev.dp;
        if (curAll > peakAll) peakAll = curAll;
        if (curTrans > peakTrans) peakTrans = curTrans;
        if (curDs > peakDs) peakDs = curDs;
        if (curDp > peakDp) peakDp = curDp;
      }

      return {
        streams: peakAll,
        transcodes: peakTrans,
        directStreams: peakDs,
        directPlays: peakDp
      };
    };

    const peakConcurrentWindow = await computePeakConcurrencyFromHistory();

    // Persist an all-time max so the displayed peak never decreases.
    // (e.g. if it ever hit 12 streams, it stays 12 until it hits 13.)
    const toInt = (v) => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    };
    const storedFromConfig = (appConfig && appConfig.reports && appConfig.reports.peakConcurrentStreams && typeof appConfig.reports.peakConcurrentStreams === 'object')
      ? appConfig.reports.peakConcurrentStreams
      : { streams: 0, transcodes: 0, directStreams: 0, directPlays: 0 };

    const storedFromMem = (peakConcurrentStreamsAllTime && typeof peakConcurrentStreamsAllTime === 'object')
      ? peakConcurrentStreamsAllTime
      : { streams: 0, transcodes: 0, directStreams: 0, directPlays: 0 };

    const storedNorm = {
      streams: Math.max(toInt(storedFromConfig.streams), toInt(storedFromMem.streams)),
      transcodes: Math.max(toInt(storedFromConfig.transcodes), toInt(storedFromMem.transcodes)),
      directStreams: Math.max(toInt(storedFromConfig.directStreams), toInt(storedFromMem.directStreams)),
      directPlays: Math.max(toInt(storedFromConfig.directPlays), toInt(storedFromMem.directPlays))
    };

    const peakConcurrent = {
      streams: Math.max(toInt(peakConcurrentWindow.streams), storedNorm.streams),
      transcodes: Math.max(toInt(peakConcurrentWindow.transcodes), storedNorm.transcodes),
      directStreams: Math.max(toInt(peakConcurrentWindow.directStreams), storedNorm.directStreams),
      directPlays: Math.max(toInt(peakConcurrentWindow.directPlays), storedNorm.directPlays)
    };

    const changed =
      peakConcurrent.streams !== storedNorm.streams ||
      peakConcurrent.transcodes !== storedNorm.transcodes ||
      peakConcurrent.directStreams !== storedNorm.directStreams ||
      peakConcurrent.directPlays !== storedNorm.directPlays;

    if (changed) {
      peakConcurrentStreamsAllTime = {
        ...peakConcurrent,
        updatedAt: new Date().toISOString()
      };
      try {
        if (!appConfig || typeof appConfig !== 'object') appConfig = {};
        if (!appConfig.reports || typeof appConfig.reports !== 'object') appConfig.reports = {};
        appConfig.reports.peakConcurrentStreams = {
          ...peakConcurrent,
          updatedAt: new Date().toISOString()
        };
        saveAppConfigToDisk();
      } catch (e) {
        console.error('[OmniStream] Failed to persist peakConcurrentStreams:', e.message);
      }
    }

    res.json({
      metric,
      days,
      startIso,
      endIso,
      generatedAt: new Date().toISOString(),
      summary: (() => {
        const row = Array.isArray(summaryRows) && summaryRows[0] ? summaryRows[0] : {};
        const toNum = (v) => {
          const n = Number(v);
          return Number.isFinite(n) ? n : 0;
        };
        return {
          totalPlays: Math.max(0, Math.floor(toNum(row.totalPlays))),
          watchTimeSeconds: Math.max(0, Math.floor(toNum(row.watchTimeSeconds))),
          uniqueUsers: Math.max(0, Math.floor(toNum(row.uniqueUsers))),
          uniqueTitles: Math.max(0, Math.floor(toNum(row.uniqueTitles)))
        };
      })(),
      sections: {
        mostWatchedMovies: sanitizeArtworkRows(mostWatchedMovies),
        mostPopularMovies: sanitizeArtworkRows(mostPopularMovies),
        mostWatchedTvShows: sanitizeArtworkRows(mostWatchedTvShows),
        mostPopularTvShows: sanitizeArtworkRows(mostPopularTvShows),
        mostPlayedArtists: sanitizeArtworkRows(mostPlayedArtists),
        mostPopularArtists: sanitizeArtworkRows(mostPopularArtists),
        recentlyWatched: sanitizeArtworkRows(recentlyWatched),
        mostActiveLibraries,
        mostActiveUsers,
        mostActivePlatforms,
        mostConcurrentStreams: {
          streams: peakConcurrent.streams,
          transcodes: peakConcurrent.transcodes,
          directStreams: peakConcurrent.directStreams,
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

    const sess = internalAuthEnabled() ? getSessionForReq(req) : null;
    const authed = !internalAuthEnabled() || Boolean(sess && sess.username);

    const relRaw = String(artworkPath);
    if (!relRaw.startsWith('/') || relRaw.includes('..') || relRaw.includes('://')) {
      return res.status(400).end();
    }

    if (!authed) {
      const exp = req.query.exp;
      const sig = req.query.sig;
      const ok = verifyNewsletterPosterSignature({ serverId: String(serverId), path: relRaw, exp, sig });
      if (!ok) {
        return res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHENTICATED' });
      }
    }

    const server = servers.find(s => String(s.id) === String(serverId));
    if (!server || !server.baseUrl) {
      return res.status(404).end();
    }
    let base = server.baseUrl;
    if (base.endsWith('/')) base = base.slice(0, -1);
    const rel = relRaw;
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
          url += `${sep}api_key=${encodeURIComponent(server.token)}&X-Emby-Token=${encodeURIComponent(server.token)}`;
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
    res.setHeader('Cache-Control', 'public, max-age=3600');
    resp.data.pipe(res);
  } catch (e) {
    const status = e && e.response && typeof e.response.status === 'number' ? e.response.status : null;
    console.error('[OmniStream] Poster proxy failed:', e && e.message ? e.message : String(e));
    if (status && status >= 400 && status < 600) {
      return res.status(status).end();
    }
    res.status(502).end();
  }
});

// Signed-only poster proxy endpoint for newsletter emails.
// Intended to be safely exposed without interactive auth at the reverse proxy.
app.get('/api/poster/signed', async (req, res) => {
  try {
    const { serverId, path: artworkPath, exp, sig } = req.query;
    if (!serverId || !artworkPath || !exp || !sig) {
      return res.status(400).end();
    }

    const relRaw = String(artworkPath);
    if (!relRaw.startsWith('/') || relRaw.includes('..') || relRaw.includes('://')) {
      return res.status(400).end();
    }

    const ok = verifyNewsletterPosterSignature({ serverId: String(serverId), path: relRaw, exp, sig });
    if (!ok) {
      return res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHENTICATED' });
    }

    const server = servers.find(s => String(s.id) === String(serverId));
    if (!server || !server.baseUrl) {
      return res.status(404).end();
    }
    let base = server.baseUrl;
    if (base.endsWith('/')) base = base.slice(0, -1);
    const rel = relRaw;
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
          url += `${sep}api_key=${encodeURIComponent(server.token)}&X-Emby-Token=${encodeURIComponent(server.token)}`;
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
    res.setHeader('Cache-Control', 'public, max-age=3600');
    resp.data.pipe(res);
  } catch (e) {
    console.error('[OmniStream] Signed poster proxy failed:', e.message);
    res.status(502).end();
  }
});

// Simple history API - backed by SQLite
app.get('/api/history', (req, res) => {
  if (!historyDb) return res.json({ history: [] });
  let sql = 'SELECT time, endedAt, lastSeenAt, sessionKey, serverId, serverName, type, user, userKey, title, stream, transcoding, location, bandwidth, platform, product, player, quality, duration, progress, ip, completed FROM history ORDER BY id DESC';
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
      userKey: r.userKey || undefined,
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

// History DB backups (files stored under ./backups)
app.get('/api/system/history-db-backups/config', (req, res) => {
  const cfg = getHistoryDbBackupConfig();
  res.json({
    ...cfg,
    backupsDir: HISTORY_BACKUPS_DIR,
    lastBackupAt: lastHistoryDbBackupAt,
    lastError: lastHistoryDbBackupError,
    nextBackupAt: nextHistoryDbBackupAt
  });
});

app.put('/api/system/history-db-backups/config', (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const interval = normalizeHistoryDbBackupInterval(body.interval);
    if (!appConfig.backups || typeof appConfig.backups !== 'object') appConfig.backups = {};
    if (!appConfig.backups.historyDb || typeof appConfig.backups.historyDb !== 'object') appConfig.backups.historyDb = { interval: 'off', keep: 30 };
    appConfig.backups.historyDb.interval = interval;
    saveAppConfigToDisk();
    scheduleHistoryDbBackups();
    const cfg = getHistoryDbBackupConfig();
    res.json({
      ...cfg,
      backupsDir: HISTORY_BACKUPS_DIR,
      lastBackupAt: lastHistoryDbBackupAt,
      lastError: lastHistoryDbBackupError,
      nextBackupAt: nextHistoryDbBackupAt
    });
  } catch (e) {
    console.error('[OmniStream] Failed to update history DB backup config:', e.message);
    res.status(500).json({ error: 'Failed to update backup config' });
  }
});

app.get('/api/system/history-db-backups/list', (req, res) => {
  const items = listHistoryDbBackups({ limit: 100 });
  res.json({
    items,
    lastBackupAt: lastHistoryDbBackupAt,
    lastError: lastHistoryDbBackupError,
    nextBackupAt: nextHistoryDbBackupAt
  });
});

app.post('/api/system/history-db-backups/run', async (req, res) => {
  try {
    const backup = await createHistoryDbBackup({ reason: 'manual' });
    res.json({ ok: true, backup });
  } catch (e) {
    const msg = e && e.message ? String(e.message) : 'Backup failed';
    lastHistoryDbBackupError = msg;
    lastHistoryDbBackupErrorAt = new Date().toISOString();
    console.error('[OmniStream] Manual history DB backup failed:', msg);
    res.status(500).json({ error: 'Backup failed', detail: msg });
  }
});

app.get('/api/system/history-db-backups/download', (req, res) => {
  try {
    const name = String(req.query.name || '');
    const base = path.basename(name);
    if (!base || base !== name) return res.status(400).json({ error: 'Invalid name' });
    const filePath = path.join(HISTORY_BACKUPS_DIR, base);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
    res.download(filePath, base);
  } catch (e) {
    console.error('[OmniStream] Failed to download history DB backup:', e.message);
    res.status(500).json({ error: 'Failed to download backup' });
  }
});

app.post('/api/system/history-db-backups/restore', async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const name = String(body.name || '');
    await restoreHistoryDbFromBackupName(name);
    res.json({ ok: true });
  } catch (e) {
    const msg = e && e.message ? String(e.message) : 'Restore failed';
    console.error('[OmniStream] Restore history DB failed:', msg);
    res.status(500).json({ error: 'Restore failed', detail: msg });
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
    const plexUser = u && u.plexUser && typeof u.plexUser === 'object' ? u.plexUser : null;
    const email = u.email || u.emailAddress || u.userEmail || null;
    const username = u.username || u.userName || (plexUser && plexUser.username) || u.plexUsername || u.plexUserName || null;
    const displayName = u.displayName || u.name || u.fullName || (plexUser && plexUser.title) || null;
    const plexIdRaw = u.plexId ?? u.plexUserId ?? (plexUser && (plexUser.id ?? plexUser.plexId)) ?? null;
    const plexId = plexIdRaw != null ? String(plexIdRaw) : null;
    const name = displayName || username || email || null;
    return {
      id: u.id ?? u.userId ?? null,
      name,
      email,
      username,
      displayName,
      plexId
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
        "  watchUserKey TEXT,\n" +
        "  email TEXT NOT NULL,\n" +
        "  createdAt TEXT NOT NULL,\n" +
        "  updatedAt TEXT NOT NULL,\n" +
        "  active INTEGER NOT NULL DEFAULT 1,\n" +
        "  serverTags TEXT,\n" +
        '  UNIQUE(source, externalId)\n' +
        ')'
      );

      // Older DBs may not have the column even if the CREATE TABLE above is newer.
      historyDb.run('ALTER TABLE newsletter_subscribers ADD COLUMN watchUserKey TEXT', (e) => {
        if (e && !/duplicate column name/i.test(String(e.message || ''))) {
          console.error('[OmniStream] Failed to migrate newsletter_subscribers schema (add watchUserKey):', e.message);
        }
      });

      const stmt = historyDb.prepare(
        'INSERT INTO newsletter_subscribers (source, externalId, name, watchUser, watchUserKey, email, createdAt, updatedAt, active) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1) ' +
        'ON CONFLICT(source, externalId) DO UPDATE SET ' +
        '  name = excluded.name, ' +
        '  watchUser = excluded.watchUser, ' +
        '  watchUserKey = excluded.watchUserKey, ' +
        '  email = excluded.email, ' +
        '  updatedAt = excluded.updatedAt, ' +
        '  active = 1'
      );

      let processed = 0;
      withEmail.forEach(u => {
        const externalId = u.id != null ? String(u.id) : null;
        const name = (u.displayName || u.name || u.username || u.email || '').trim();
        // Tag-by-server matches subscriber.watchUser to history.userKey (preferred) and falls back
        // to history.user (friendly display name) for older rows.
        // Overseerr's stable identifier is typically username (often matches Plex/Jellyfin username),
        // while displayName may be a friendly name and not match watch history.
        const watchUser = (u.username || '').trim() || name;
        const plexId = u.plexId != null ? String(u.plexId).trim() : '';
        const watchUserKey = plexId ? `plex:${plexId}` : '';
        stmt.run('overseerr', externalId, name, watchUser, watchUserKey, u.email, now, now, (err) => {
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
  // Tags are derived by matching subscriber.watchUser (or subscriber.name) to history.userKey (preferred)
  // and falling back to history.user (case-insensitive).
  app.post('/api/subscribers/tag-by-server', (req, res) => {
    if (!historyDb) {
      return res.status(500).json({ error: 'history DB not available' });
    }
    if (!historyDbReady) {
      return res.status(503).json({ error: 'History database not ready' });
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    let days = Number(body.days);
    if (!Number.isFinite(days) || days <= 0) days = 0;
    if (days > 3650) days = 3650;

    recomputeSubscriberServerTags({ days })
      .then((stats) => res.json(stats))
      .catch((e) => {
        console.error('[OmniStream] Failed to recompute subscriber tags:', e && e.message ? e.message : String(e));
        res.status(500).json({ error: 'Failed to compute tags' });
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
      const sess = internalAuthEnabled() ? getSessionForReq(req) : null;
      const authed = !internalAuthEnabled() || Boolean(sess && sess.username);

      const serverId = String(req.query.serverId || '').trim();
      let thumb = String(req.query.thumb || '').trim();
      if (!serverId || !thumb) {
        return res.status(400).json({ error: 'serverId and thumb are required' });
      }
      if (!thumb.startsWith('/') || thumb.includes('..') || thumb.includes('://')) {
        return res.status(400).json({ error: 'Invalid thumb path' });
      }

      if (!authed) {
        const exp = req.query.exp;
        const sig = req.query.sig;
        const ok = verifyNewsletterThumbSignature({ serverId, thumb, exp, sig });
        if (!ok) {
          return res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHENTICATED' });
        }
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

  // Signed-only Plex thumbnail proxy endpoint for newsletter emails.
  // Intended to be safely exposed without interactive auth at the reverse proxy.
  app.get('/api/newsletter/plex/thumb/signed', async (req, res) => {
    try {
      const serverId = String(req.query.serverId || '').trim();
      let thumb = String(req.query.thumb || '').trim();
      const exp = req.query.exp;
      const sig = req.query.sig;

      if (!serverId || !thumb || !exp || !sig) {
        return res.status(400).json({ error: 'serverId, thumb, exp, and sig are required' });
      }
      if (!thumb.startsWith('/') || thumb.includes('..') || thumb.includes('://')) {
        return res.status(400).json({ error: 'Invalid thumb path' });
      }

      const ok = verifyNewsletterThumbSignature({ serverId, thumb, exp, sig });
      if (!ok) {
        return res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHENTICATED' });
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
      console.error('[OmniStream] Signed newsletter thumb proxy failed:', e.message);
      res.status(500).json({ error: 'Failed to proxy thumb' });
    }
  });

  // Sent newsletter history (saved to disk under sent_newsletters/)
  app.get('/api/newsletter/sent', (req, res) => {
    try {
      const limitRaw = Number(req.query.limit ?? 200);
      const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, Math.floor(limitRaw))) : 200;

      if (!fs.existsSync(SENT_NEWSLETTERS_DIR)) {
        return res.json({ items: [] });
      }

      const entries = fs.readdirSync(SENT_NEWSLETTERS_DIR, { withFileTypes: true })
        .filter(d => d && d.isFile && d.isFile())
        .map(d => d.name)
        .filter(name => typeof name === 'string' && name.toLowerCase().endsWith('.json'))
        .map(name => {
          const id = name.slice(0, -'.json'.length);
          const metaPath = resolveSentNewsletterPath(id, 'json');
          if (!metaPath || !fs.existsSync(metaPath)) return null;

          let meta = null;
          try {
            const raw = fs.readFileSync(metaPath, 'utf8');
            const txt = raw ? String(raw).replace(/^\uFEFF/, '').trim() : '';
            meta = txt ? JSON.parse(txt) : null;
          } catch (_) {
            meta = null;
          }

          const textPath = resolveSentNewsletterPath(id, 'txt');
          const htmlPath = resolveSentNewsletterPath(id, 'html');
          const hasText = Boolean(textPath && fs.existsSync(textPath));
          const hasHtml = Boolean(htmlPath && fs.existsSync(htmlPath));

          const savedAt = (meta && typeof meta.savedAt === 'string' && meta.savedAt) ? meta.savedAt : null;
          let sortTs = 0;
          if (savedAt) {
            const t = Date.parse(savedAt);
            sortTs = Number.isFinite(t) ? t : 0;
          }
          if (!sortTs) {
            try {
              const st = fs.statSync(metaPath);
              sortTs = st && st.mtimeMs ? st.mtimeMs : 0;
            } catch (_) {
              sortTs = 0;
            }
          }

          return {
            id,
            savedAt: savedAt || (sortTs ? new Date(sortTs).toISOString() : null),
            subject: meta && typeof meta.subject === 'string' ? meta.subject : '',
            hasHtml,
            hasText,
            placeholders: meta && typeof meta.placeholders === 'object' ? meta.placeholders : null
          };
        })
        .filter(Boolean)
        .sort((a, b) => {
          const ta = a && a.savedAt ? (Date.parse(a.savedAt) || 0) : 0;
          const tb = b && b.savedAt ? (Date.parse(b.savedAt) || 0) : 0;
          return tb - ta;
        })
        .slice(0, limit);

      res.json({ items: entries });
    } catch (e) {
      console.error('[OmniStream] Failed to list sent newsletters:', e.message);
      res.status(500).json({ error: 'Failed to list sent newsletters' });
    }
  });

  app.get('/api/newsletter/sent/:id/meta', (req, res) => {
    try {
      const id = String(req.params.id || '').trim();
      const p = resolveSentNewsletterPath(id, 'json');
      if (!p || !fs.existsSync(p)) return res.status(404).json({ error: 'Not found' });
      const raw = fs.readFileSync(p, 'utf8');
      const txt = raw ? String(raw).replace(/^\uFEFF/, '').trim() : '';
      const meta = txt ? JSON.parse(txt) : {};
      res.json(meta);
    } catch (e) {
      res.status(500).json({ error: 'Failed to read meta' });
    }
  });

  app.get('/api/newsletter/sent/:id/text', (req, res) => {
    try {
      const id = String(req.params.id || '').trim();
      const p = resolveSentNewsletterPath(id, 'txt');
      if (!p || !fs.existsSync(p)) return res.status(404).send('Not found');
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'private, max-age=0, no-store');
      res.status(200).send(fs.readFileSync(p, 'utf8'));
    } catch (e) {
      res.status(500).send('Failed to read text');
    }
  });

  app.get('/api/newsletter/sent/:id/html', (req, res) => {
    try {
      const id = String(req.params.id || '').trim();
      const p = resolveSentNewsletterPath(id, 'html');
      if (!p || !fs.existsSync(p)) return res.status(404).send('Not found');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'private, max-age=0, no-store');
      res.status(200).send(fs.readFileSync(p, 'utf8'));
    } catch (e) {
      res.status(500).send('Failed to read html');
    }
  });

  // Helper: fetch recently added items from enabled Plex servers
  async function fetchPlexRecentlyAdded({ perServer = 10, serverId = '', includedLibraries = [] } = {}) {
    const wantedId = serverId != null ? String(serverId).trim() : '';
    const wantedLibraries = wantedId ? normalizeNewsletterIncludedLibraries(includedLibraries) : [];
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
      const headers = { Accept: 'application/json' };
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

        let sections = sectionDirs
          .map(d => ({
            key: d && d.key != null ? String(d.key) : '',
            type: d && d.type ? String(d.type).toLowerCase() : ''
          }))
          .filter(s => s.key && (s.type === 'movie' || s.type === 'show'));

        if (wantedLibraries.length) {
          const allow = new Set(wantedLibraries);
          sections = sections.filter(s => allow.has(String(s.key)));
        }

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

  async function fetchUnifiedRecentlyAdded({ perServer = 10, serverId = '', includedLibraries = [] } = {}) {
    const wantedId = serverId != null ? String(serverId).trim() : '';
    const wantedLibraries = wantedId ? normalizeNewsletterIncludedLibraries(includedLibraries) : [];

    if (wantedId) {
      const server = servers.find(s => s && String(s.id) === wantedId);
      if (!server || server.disabled) return [];
      if (server.type === 'plex') {
        return fetchPlexRecentlyAdded({ perServer, serverId: wantedId, includedLibraries: wantedLibraries });
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
    where.push('(LOWER(user) LIKE ? OR LOWER(userKey) LIKE ?)');
    const needle = `%${String(user).toLowerCase()}%`;
    params.push(needle, needle);
  }
  if (q) {
    const needle = `%${String(q).toLowerCase()}%`;
    where.push('(LOWER(title) LIKE ? OR LOWER(stream) LIKE ? OR LOWER(user) LIKE ? OR LOWER(userKey) LIKE ? OR LOWER(serverName) LIKE ?)');
    params.push(needle, needle, needle, needle, needle);
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

  const selectCols = 'time, endedAt, lastSeenAt, sessionKey, serverId, serverName, type, user, userKey, userAvatar, title, stream, transcoding, location, bandwidth, platform, product, player, quality, duration, progress, ip, completed';

  const baseParams = [...params];
  let querySql;
  let queryParams;
  if (isUnique) {
    const userGroupExpr = `COALESCE(NULLIF(userKey,''), NULLIF(user,''))`;
    const uniqueSub = `SELECT MAX(id) AS id FROM history ${whereSql} GROUP BY serverId, ${userGroupExpr}, title, stream, location, COALESCE(ip,'')`;
    querySql = `SELECT ${selectCols} FROM history h INNER JOIN (${uniqueSub}) u ON h.id = u.id ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
    queryParams = [...baseParams, size + 1, offset];
  } else {
    querySql = `SELECT ${selectCols} FROM history ${whereSql} ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
    queryParams = [...baseParams, size + 1, offset];
  }

  const statsSqlForMode = () => {
    const userIdentityExpr = `LOWER(COALESCE(NULLIF(userKey,''), NULLIF(user,'')))`;
    const watchedExpr = `CASE
      WHEN duration IS NOT NULL AND duration > 0 AND progress IS NOT NULL AND progress > 0
      THEN CASE
        WHEN CAST(ROUND(duration * (progress / 100.0)) AS INTEGER) > duration THEN duration
        ELSE CAST(ROUND(duration * (progress / 100.0)) AS INTEGER)
      END
      ELSE 0
    END`;

    if (isUnique) {
      const userGroupExpr = `COALESCE(NULLIF(userKey,''), NULLIF(user,''))`;
      const uniqueSub = `SELECT MAX(id) AS id FROM history ${whereSql} GROUP BY serverId, ${userGroupExpr}, title, stream, location, COALESCE(ip,'')`;
      return {
        sql: `SELECT
                COUNT(*) AS total,
                COUNT(DISTINCT ${userIdentityExpr}) AS uniqueUsers,
                COUNT(DISTINCT LOWER(h.title)) AS uniqueTitles,
                SUM(${watchedExpr}) AS watchSeconds
              FROM history h INNER JOIN (${uniqueSub}) u ON h.id = u.id`,
        params: [...baseParams]
      };
    }

    return {
      sql: `SELECT
              COUNT(*) AS total,
              COUNT(DISTINCT ${userIdentityExpr}) AS uniqueUsers,
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
      userKey: r.userKey || undefined,
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
  const enabledServerIds = new Set((Array.isArray(servers) ? servers : [])
    .filter(s => s && !s.disabled && s.id != null)
    .map(s => String(s.id)));
  const rules = (appConfig.notifiers && appConfig.notifiers.rules) || {};
  const offlineRule = rules.offline || {};
  const wanRule = rules.wanTranscodes || {};
  const highRule = rules.highBandwidth || {};
   const anyWanRule = rules.anyWan || {};
   const highWanRule = rules.highWanBandwidth || {};
  const backupsRule = rules.historyDbBackups || {};
  const offlineEnabled = offlineRule.enabled !== false;
  const wanEnabled = wanRule.enabled !== false;
  const highEnabled = highRule.enabled !== false;
   const anyWanEnabled = anyWanRule.enabled === true; // opt-in to avoid noise
  const backupsEnabled = backupsRule.enabled !== false;
  const highThreshold = typeof highRule.thresholdMbps === 'number' && !Number.isNaN(highRule.thresholdMbps)
    ? highRule.thresholdMbps
    : 50;
   const highWanThreshold = typeof highWanRule.thresholdMbps === 'number' && !Number.isNaN(highWanRule.thresholdMbps)
    ? highWanRule.thresholdMbps
    : 30;
  Object.values(statuses).forEach(st => {
    // Never generate server-scoped notifications for disabled servers.
    // (Disabled servers may still have stale entries in the statuses map.)
    const stId = st && st.id != null ? String(st.id) : null;
    if (!stId || !enabledServerIds.has(stId)) return;
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

  // History DB backup notifications (success + failure)
  // System-level (not tied to any specific server).
  if (backupsEnabled) {
    const windowMs = 5 * 60 * 1000; // keep success visible briefly so notifier loop can pick it up
    const parseIsoMs = (iso) => {
      const ms = Date.parse(String(iso || ''));
      return Number.isFinite(ms) ? ms : null;
    };

    const okMs = parseIsoMs(lastHistoryDbBackupAt);
    if (okMs && (Date.now() - okMs) <= windowMs) {
      const name = lastHistoryDbBackupName ? String(lastHistoryDbBackupName) : 'history.db';
      const size = typeof lastHistoryDbBackupSizeBytes === 'number' ? lastHistoryDbBackupSizeBytes : null;
      const sizeMb = size != null ? (size / (1024 * 1024)) : null;
      notifications.push({
        id: `historydb-backup-ok-${lastHistoryDbBackupAt}`,
        level: 'info',
        serverId: 'omnistream',
        serverName: 'OmniStream',
        time: lastHistoryDbBackupAt,
        kind: 'historyDbBackup',
        message: `History DB backup succeeded: ${name}${sizeMb != null ? ` (${sizeMb.toFixed(1)} MB)` : ''}`
      });
    }

    if (lastHistoryDbBackupError) {
      const when = lastHistoryDbBackupErrorAt || now;
      notifications.push({
        id: `historydb-backup-error-${when}`,
        level: 'error',
        serverId: 'omnistream',
        serverName: 'OmniStream',
        time: when,
        kind: 'historyDbBackup',
        message: `History DB backup failed: ${String(lastHistoryDbBackupError)}`
      });
    }
  }

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
    const overrideSubject = body && body.subjectLine != null ? String(body.subjectLine).trim() : '';
    const overrideBody = body && body.messageBody != null ? String(body.messageBody) : '';
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
      sendEmailNotificationWithConfig(notification, notifierCfg.email, {
        subject: overrideSubject,
        body: overrideBody
      });
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

// Notifier Agents (Tautulli-style)
app.get('/api/notifier-agents', (req, res) => {
  const agents = getNotifierAgents();
  // Only email agents are currently supported.
  const cleaned = agents
    .filter(a => a && a.type === 'email')
    .map(a => sanitizeEmailNotifierAgent(a))
    .filter(a => a && a.id != null);
  res.json({ agents: cleaned });
});

app.post('/api/notifier-agents', (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const type = body.type != null ? String(body.type).trim().toLowerCase() : 'email';
    if (type !== 'email') {
      return res.status(400).json({ error: 'Only email notifier agents are supported right now.' });
    }

    const existing = getNotifierAgents();
    const id = allocateNextNotifierAgentId(existing);
    const created = sanitizeEmailNotifierAgent({
      id,
      type: 'email',
      enabled: true,
      config: {
        fromName: '',
        from: '',
        to: [],
        cc: [],
        bcc: [],
        encryption: 'starttls',
        allowHtml: false,
        smtp: { host: '', port: 587, secure: false, auth: { user: '', pass: '' } }
      },
      triggers: {
        offline: true,
        serverBackUp: true,
        wanTranscodes: true,
        highBandwidth: true,
        anyWan: true,
        highWanBandwidth: true,
        historyDbBackups: true,
        playbackStart: false,
        playbackStop: false
      },
      text: { subject: '', body: '' }
    });
    const next = existing.concat([created]);
    setNotifierAgents(next);
    res.json({ ok: true, agent: created });
  } catch (e) {
    console.error('[OmniStream] Failed to create notifier agent:', e.message);
    res.status(500).json({ error: 'Failed to create notifier agent' });
  }
});

app.put('/api/notifier-agents/:id', (req, res) => {
  try {
    const id = normalizeNotifierAgentId(req.params && req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid agent id' });
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const incoming = body.agent && typeof body.agent === 'object' ? body.agent : body;

    const existing = getNotifierAgents();
    const idx = existing.findIndex(a => normalizeNotifierAgentId(a && a.id) === id);
    if (idx < 0) return res.status(404).json({ error: 'Agent not found' });

    const nextAgent = sanitizeEmailNotifierAgent({ ...existing[idx], ...incoming, id });
    const next = existing.slice();
    next[idx] = nextAgent;
    setNotifierAgents(next);
    res.json({ ok: true, agent: nextAgent });
  } catch (e) {
    console.error('[OmniStream] Failed to update notifier agent:', e.message);
    res.status(500).json({ error: 'Failed to update notifier agent' });
  }
});

app.delete('/api/notifier-agents/:id', (req, res) => {
  try {
    const id = normalizeNotifierAgentId(req.params && req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid agent id' });
    const existing = getNotifierAgents();
    const next = existing.filter(a => normalizeNotifierAgentId(a && a.id) !== id);
    if (next.length === existing.length) return res.status(404).json({ error: 'Agent not found' });
    setNotifierAgents(next);
    res.json({ ok: true });
  } catch (e) {
    console.error('[OmniStream] Failed to delete notifier agent:', e.message);
    res.status(500).json({ error: 'Failed to delete notifier agent' });
  }
});

app.post('/api/notifier-agents/:id/duplicate', (req, res) => {
  try {
    const id = normalizeNotifierAgentId(req.params && req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid agent id' });
    const existing = getNotifierAgents();
    const agent = existing.find(a => normalizeNotifierAgentId(a && a.id) === id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const nextId = allocateNextNotifierAgentId(existing);
    const copy = sanitizeEmailNotifierAgent({ ...agent, id: nextId });
    const next = existing.concat([copy]);
    setNotifierAgents(next);
    res.json({ ok: true, agent: copy });
  } catch (e) {
    console.error('[OmniStream] Failed to duplicate notifier agent:', e.message);
    res.status(500).json({ error: 'Failed to duplicate notifier agent' });
  }
});

app.post('/api/notifier-agents/:id/test', async (req, res) => {
  try {
    const id = normalizeNotifierAgentId(req.params && req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid agent id' });
    if (!nodemailer) return res.status(500).json({ error: 'Email sending not available (nodemailer not installed).' });

    const existing = getNotifierAgents();
    const agent = existing.find(a => normalizeNotifierAgentId(a && a.id) === id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const cleaned = sanitizeEmailNotifierAgent(agent);
    const fromName = cleaned.config && cleaned.config.fromName ? String(cleaned.config.fromName).trim() : '';
    const from = cleaned.config && cleaned.config.from ? String(cleaned.config.from).trim() : '';
    const toList = normalizeEmailRecipientList(cleaned.config && cleaned.config.to);
    const ccList = normalizeEmailRecipientList(cleaned.config && cleaned.config.cc);
    const bccList = normalizeEmailRecipientList(cleaned.config && cleaned.config.bcc);
    if (!from || !toList.length) return res.status(400).json({ error: 'Agent from/to must be configured.' });

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const subjectLine = body.subjectLine != null ? String(body.subjectLine).trim() : 'OmniStream Test Notification';
    const messageBody = body.messageBody != null ? String(body.messageBody) : 'Test Notification';
    const transport = nodemailer.createTransport(cleaned.config.smtp || {});
    const mailOptions = {
      from: fromName ? `${fromName} <${from}>` : from,
      to: toList,
      subject: subjectLine,
      text: messageBody
    };

    if (ccList.length) mailOptions.cc = ccList;
    if (bccList.length) mailOptions.bcc = bccList;
    if (cleaned.config.allowHtml === true && /<\w[\s\S]*>/i.test(messageBody)) {
      mailOptions.html = messageBody;
      const stripped = stripHtmlToText(messageBody);
      if (stripped) mailOptions.text = stripped;
    }

    const info = await transport.sendMail(mailOptions);
    res.json({ ok: true, messageId: info && info.messageId ? String(info.messageId) : '' });
  } catch (e) {
    console.error('[OmniStream] Failed to send notifier agent test:', e.message);
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
      newsletterEmail: sanitizeNewsletterEmailForClient(appConfig.newsletterEmail),
      newsletterSchedule: {
        enabled: appConfig.newsletterSchedule?.enabled === true,
        templateId: appConfig.newsletterSchedule?.templateId != null ? String(appConfig.newsletterSchedule.templateId) : DEFAULT_NEWSLETTER_TEMPLATE_ID,
        dayOfWeek: normalizeDayOfWeek(appConfig.newsletterSchedule?.dayOfWeek),
        time: normalizeTimeHHMM(appConfig.newsletterSchedule?.time) || '09:00',
        lastSentDate: appConfig.newsletterSchedule?.lastSentDate || ''
      },
      newsletterSchedules: normalizedSchedules,
      newsletterCustomSections: Array.isArray(appConfig.newsletterCustomSections)
        ? appConfig.newsletterCustomSections.map((s, idx) => {
          const header = s && typeof s.header === 'string' ? s.header : '';
          const headerSize = normalizeCustomHeaderSize(s && s.headerSize);
          const headerColor = normalizeHexColor(s && s.headerColor) || '#e5e7eb';

          const normalizeRowForApi = (r, rIdx) => {
            let cc = parseInt((r && r.columnCount != null) ? r.columnCount : 3, 10);
            if (![1, 2, 3].includes(cc)) cc = 3;
            const rowColor = normalizeHexColor(r && r.rowColor) || '#0b1226';
            const rowTextColor = normalizeHexColor(r && r.rowTextColor) || '#e5e7eb';
            const boxed = !(r && r.boxed === false);
            const cols = r && Array.isArray(r.columns)
              ? r.columns
              : (s && Array.isArray(s.columns) ? s.columns : []);
            return {
              id: r && r.id != null ? String(r.id) : `row-${rIdx + 1}`,
              columnCount: cc,
              rowColor,
              rowTextColor,
              boxed,
              columns: [
                normalizeCustomHeaderColumn(cols[0]),
                normalizeCustomHeaderColumn(cols[1]),
                normalizeCustomHeaderColumn(cols[2])
              ]
            };
          };

          const rawRows = s && Array.isArray(s.rows) ? s.rows : null;
          const rows = (rawRows && rawRows.length)
            ? rawRows.map(normalizeRowForApi)
            : [normalizeRowForApi({ columnCount: s && s.columnCount, rowColor: s && s.rowColor, rowTextColor: s && s.rowTextColor, boxed: s && s.boxed, columns: s && s.columns }, 0)];

          // Keep legacy fields populated for back-compat.
          const firstRow = rows[0] || {};
          const legacyColumnCount = (() => {
            let cc = parseInt((s && s.columnCount != null) ? s.columnCount : (firstRow.columnCount != null ? firstRow.columnCount : 3), 10);
            if (![1, 2, 3].includes(cc)) cc = 3;
            return cc;
          })();
          const legacyColumns = Array.isArray(s && s.columns)
            ? [
              normalizeCustomHeaderColumn(s.columns[0]),
              normalizeCustomHeaderColumn(s.columns[1]),
              normalizeCustomHeaderColumn(s.columns[2])
            ]
            : (Array.isArray(firstRow.columns)
              ? [
                normalizeCustomHeaderColumn(firstRow.columns[0]),
                normalizeCustomHeaderColumn(firstRow.columns[1]),
                normalizeCustomHeaderColumn(firstRow.columns[2])
              ]
              : [normalizeCustomHeaderColumn(''), normalizeCustomHeaderColumn(''), normalizeCustomHeaderColumn('')]);

          return {
            id: s && s.id != null ? String(s.id) : `sec-${idx + 1}`,
            header,
            headerSize,
            headerColor,
            rows,
            columnCount: legacyColumnCount,
            columns: legacyColumns
          };
        })
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
      // SMTP settings: merge to avoid clearing auth.pass when UI doesn't send it back.
      if (Object.prototype.hasOwnProperty.call(incomingNl, 'smtp')) {
        if (incomingNl.smtp === null) {
          delete nextNl.smtp;
        } else if (incomingNl.smtp && typeof incomingNl.smtp === 'object') {
          const currentSmtp = (currentNl.smtp && typeof currentNl.smtp === 'object') ? currentNl.smtp : {};
          const incomingSmtp = incomingNl.smtp;
          const nextSmtp = { ...currentSmtp };

          if (Object.prototype.hasOwnProperty.call(incomingSmtp, 'host')) {
            nextSmtp.host = typeof incomingSmtp.host === 'string' ? incomingSmtp.host.trim() : '';
          }
          if (Object.prototype.hasOwnProperty.call(incomingSmtp, 'port')) {
            const p = incomingSmtp.port;
            if (p === null || p === '') {
              delete nextSmtp.port;
            } else {
              const n = typeof p === 'number' ? p : Number(p);
              if (Number.isFinite(n) && n > 0) nextSmtp.port = n;
            }
          }
          if (Object.prototype.hasOwnProperty.call(incomingSmtp, 'secure')) {
            nextSmtp.secure = incomingSmtp.secure === true;
          }

          if (Object.prototype.hasOwnProperty.call(incomingSmtp, 'auth')) {
            if (incomingSmtp.auth === null) {
              delete nextSmtp.auth;
            } else if (incomingSmtp.auth && typeof incomingSmtp.auth === 'object') {
              const currentAuth = (currentSmtp.auth && typeof currentSmtp.auth === 'object') ? currentSmtp.auth : {};
              const incomingAuth = incomingSmtp.auth;
              const nextAuth = { ...currentAuth };

              if (Object.prototype.hasOwnProperty.call(incomingAuth, 'user')) {
                nextAuth.user = typeof incomingAuth.user === 'string' ? incomingAuth.user.trim() : '';
              }
              // Only update pass when explicitly provided.
              if (Object.prototype.hasOwnProperty.call(incomingAuth, 'pass')) {
                const pass = incomingAuth.pass;
                if (typeof pass === 'string') {
                  if (!pass.length) {
                    // empty string means clear
                    delete nextAuth.pass;
                  } else {
                    nextAuth.pass = pass;
                  }
                }
              }

              // Prune empty auth
              if (Object.keys(nextAuth).length) {
                nextSmtp.auth = nextAuth;
              } else {
                delete nextSmtp.auth;
              }
            }
          }

          nextNl.smtp = nextSmtp;
        }
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

          const normalizeRowFromApi = (r, rIdx, fallbackColumnCount, fallbackColumns) => {
            let cc = parseInt((r && r.columnCount != null) ? r.columnCount : fallbackColumnCount, 10);
            if (![1, 2, 3].includes(cc)) cc = 3;
            const rowColor = normalizeHexColor(r && r.rowColor) || '#0b1226';
            const rowTextColor = normalizeHexColor(r && r.rowTextColor) || '#e5e7eb';
            const boxed = !(r && r.boxed === false);
            const cols = r && Array.isArray(r.columns)
              ? r.columns
              : (Array.isArray(fallbackColumns) ? fallbackColumns : []);
            const c1 = normalizeCustomHeaderColumn(cols[0]);
            const c2 = normalizeCustomHeaderColumn(cols[1]);
            const c3 = normalizeCustomHeaderColumn(cols[2]);
            return {
              id: r && r.id != null ? String(r.id) : `row-${rIdx + 1}`,
              columnCount: cc,
              rowColor,
              rowTextColor,
              boxed,
              columns: [c1, c2, c3]
            };
          };

          // Legacy fallback (section-level columns + columnCount)
          let legacyColumnCount = parseInt((s && s.columnCount != null) ? s.columnCount : 3, 10);
          if (![1, 2, 3].includes(legacyColumnCount)) legacyColumnCount = 3;
          const legacyColumns = s && Array.isArray(s.columns) ? s.columns : [];

          const rawRows = s && Array.isArray(s.rows) ? s.rows : null;
          const rows = (rawRows && rawRows.length)
            ? rawRows.map((r, rIdx) => normalizeRowFromApi(r, rIdx, legacyColumnCount, legacyColumns))
            : [normalizeRowFromApi({ columnCount: legacyColumnCount, rowColor: s && s.rowColor, rowTextColor: s && s.rowTextColor, boxed: s && s.boxed, columns: legacyColumns }, 0, legacyColumnCount, legacyColumns)];

          // Keep legacy fields populated too.
          const firstRow = rows[0] || {};
          const finalColumnCount = (() => {
            let cc = legacyColumnCount;
            if (![1, 2, 3].includes(cc)) cc = parseInt(firstRow.columnCount != null ? firstRow.columnCount : 3, 10);
            if (![1, 2, 3].includes(cc)) cc = 3;
            return cc;
          })();
          const finalColumns = Array.isArray(legacyColumns) && legacyColumns.length
            ? [
              normalizeCustomHeaderColumn(legacyColumns[0]),
              normalizeCustomHeaderColumn(legacyColumns[1]),
              normalizeCustomHeaderColumn(legacyColumns[2])
            ]
            : (Array.isArray(firstRow.columns)
              ? [
                normalizeCustomHeaderColumn(firstRow.columns[0]),
                normalizeCustomHeaderColumn(firstRow.columns[1]),
                normalizeCustomHeaderColumn(firstRow.columns[2])
              ]
              : [normalizeCustomHeaderColumn(''), normalizeCustomHeaderColumn(''), normalizeCustomHeaderColumn('')]);

          return {
            id: s && s.id != null ? String(s.id) : `sec-${idx + 1}`,
            header,
            headerSize,
            headerColor,
            rows,
            columnCount: finalColumnCount,
            columns: finalColumns
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
            lastSentDate: normalizeDateInput(s && s.lastSentDate) || '',
            timeframeDays: normalizeNewsletterTimeframeDays(s && s.timeframeDays) || 7,
            includedLibraries: normalizeNewsletterIncludedLibraries(s && s.includedLibraries),
            saveOnly: s && s.saveOnly === true,
            saveFileName: normalizeNewsletterSaveFileName(s && s.saveFileName),
            sendAsHtml: !(s && s.sendAsHtml === false),
            groupThread: s && s.groupThread === true,
            emailAgent: normalizeNewsletterEmailAgent(s && s.emailAgent),
            lastMessageId: normalizeNewsletterLastMessageId(s && s.lastMessageId)
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
        lastSentDate: s && s.lastSentDate ? String(s.lastSentDate) : '',
        timeframeDays: normalizeNewsletterTimeframeDays(s && s.timeframeDays) || 7,
        includedLibraries: normalizeNewsletterIncludedLibraries(s && s.includedLibraries),
        saveOnly: s && s.saveOnly === true,
        saveFileName: normalizeNewsletterSaveFileName(s && s.saveFileName),
        sendAsHtml: !(s && s.sendAsHtml === false),
        groupThread: s && s.groupThread === true,
        emailAgent: normalizeNewsletterEmailAgent(s && s.emailAgent),
        lastMessageId: normalizeNewsletterLastMessageId(s && s.lastMessageId)
      }))
      : [
        {
          id: 'default',
          serverId: '',
          enabled: appConfig.newsletterSchedule?.enabled === true,
          templateId: appConfig.newsletterSchedule?.templateId != null ? String(appConfig.newsletterSchedule.templateId) : DEFAULT_NEWSLETTER_TEMPLATE_ID,
          dayOfWeek: normalizeDayOfWeek(appConfig.newsletterSchedule?.dayOfWeek),
          time: normalizeTimeHHMM(appConfig.newsletterSchedule?.time) || '09:00',
          lastSentDate: appConfig.newsletterSchedule?.lastSentDate || '',
          timeframeDays: 7,
          includedLibraries: [],
          saveOnly: false,
          saveFileName: '',
          sendAsHtml: true,
          groupThread: false,
          emailAgent: 'builtin-email-1',
          lastMessageId: ''
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
      newsletterEmail: sanitizeNewsletterEmailForClient(appConfig.newsletterEmail),
      newsletterSchedule: {
        enabled: appConfig.newsletterSchedule?.enabled === true,
        templateId: appConfig.newsletterSchedule?.templateId != null ? String(appConfig.newsletterSchedule.templateId) : DEFAULT_NEWSLETTER_TEMPLATE_ID,
        dayOfWeek: normalizeDayOfWeek(appConfig.newsletterSchedule?.dayOfWeek),
        time: normalizeTimeHHMM(appConfig.newsletterSchedule?.time) || '09:00',
        lastSentDate: appConfig.newsletterSchedule?.lastSentDate || ''
      },
      newsletterSchedules: normalizedSchedules,
      newsletterCustomSections: Array.isArray(appConfig.newsletterCustomSections)
        ? appConfig.newsletterCustomSections.map((s, idx) => {
          const header = s && typeof s.header === 'string' ? s.header : '';
          const headerSize = normalizeCustomHeaderSize(s && s.headerSize);
          const headerColor = normalizeHexColor(s && s.headerColor) || '#e5e7eb';

          const normalizeRowForApi = (r, rIdx) => {
            let cc = parseInt((r && r.columnCount != null) ? r.columnCount : 3, 10);
            if (![1, 2, 3].includes(cc)) cc = 3;
            const rowColor = normalizeHexColor(r && r.rowColor) || '#0b1226';
            const rowTextColor = normalizeHexColor(r && r.rowTextColor) || '#e5e7eb';
            const boxed = !(r && r.boxed === false);
            const cols = r && Array.isArray(r.columns)
              ? r.columns
              : (s && Array.isArray(s.columns) ? s.columns : []);
            return {
              id: r && r.id != null ? String(r.id) : `row-${rIdx + 1}`,
              columnCount: cc,
              rowColor,
              rowTextColor,
              boxed,
              columns: [
                normalizeCustomHeaderColumn(cols[0]),
                normalizeCustomHeaderColumn(cols[1]),
                normalizeCustomHeaderColumn(cols[2])
              ]
            };
          };

          const rawRows = s && Array.isArray(s.rows) ? s.rows : null;
          const rows = (rawRows && rawRows.length)
            ? rawRows.map(normalizeRowForApi)
            : [normalizeRowForApi({ columnCount: s && s.columnCount, rowColor: s && s.rowColor, rowTextColor: s && s.rowTextColor, boxed: s && s.boxed, columns: s && s.columns }, 0)];

          const firstRow = rows[0] || {};
          const legacyColumnCount = (() => {
            let cc = parseInt((s && s.columnCount != null) ? s.columnCount : (firstRow.columnCount != null ? firstRow.columnCount : 3), 10);
            if (![1, 2, 3].includes(cc)) cc = 3;
            return cc;
          })();
          const legacyColumns = Array.isArray(s && s.columns)
            ? [
              normalizeCustomHeaderColumn(s.columns[0]),
              normalizeCustomHeaderColumn(s.columns[1]),
              normalizeCustomHeaderColumn(s.columns[2])
            ]
            : (Array.isArray(firstRow.columns)
              ? [
                normalizeCustomHeaderColumn(firstRow.columns[0]),
                normalizeCustomHeaderColumn(firstRow.columns[1]),
                normalizeCustomHeaderColumn(firstRow.columns[2])
              ]
              : [normalizeCustomHeaderColumn(''), normalizeCustomHeaderColumn(''), normalizeCustomHeaderColumn('')]);

          return {
            id: s && s.id != null ? String(s.id) : `sec-${idx + 1}`,
            header,
            headerSize,
            headerColor,
            rows,
            columnCount: legacyColumnCount,
            columns: legacyColumns
          };
        })
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
