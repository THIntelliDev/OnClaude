const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');
const fs = require('fs');
const webpush = require('web-push');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const helmet = require('helmet');

const PTYManager = require('./lib/pty-manager');
const { Watcher } = require('./lib/watcher');
const Notifier = require('./lib/notifier');

// Configuration from environment
const config = {
  port: process.env.PORT || 3000,
  domain: process.env.DOMAIN || 'localhost',
  auth: {
    user: process.env.AUTH_USER || 'admin',
    passHash: process.env.AUTH_PASS_HASH || '',
  },
  ntfy: {
    server: process.env.NTFY_SERVER || 'https://ntfy.sh',
    topic: process.env.NTFY_TOPIC,
    token: process.env.NTFY_TOKEN || null,
    debounceSeconds: parseInt(process.env.DEBOUNCE_SECONDS, 10) || 30,
  },
  claude: {
    command: 'claude',
    opts: process.env.CLAUDE_OPTS
      ? process.env.CLAUDE_OPTS.split(' ')
      : ['--settings', '{"theme":"dark"}'],  // Default to dark mode
  },
  mockMode: process.env.MOCK_MODE === 'true',
  vapid: {
    publicKey: process.env.VAPID_PUBLIC_KEY,
    privateKey: process.env.VAPID_PRIVATE_KEY,
    email: process.env.VAPID_EMAIL || 'mailto:admin@example.com',
  },
};

// Session management
const sessions = new Map(); // token -> { created: Date }
const SESSION_DURATION = 24 * 60 * 60 * 1000; // 24 hours
const CLAUDE_HOME = '/home/node_user/.claude';

// Ensure Claude settings exist with defaults (skip onboarding)
function initClaudeSettings() {
  const settingsPath = path.join(CLAUDE_HOME, 'settings.json');
  try {
    // Create .claude directory if it doesn't exist
    if (!fs.existsSync(CLAUDE_HOME)) {
      fs.mkdirSync(CLAUDE_HOME, { recursive: true });
    }

    // Check if settings file exists
    if (!fs.existsSync(settingsPath)) {
      const defaultSettings = {
        theme: 'dark',
        permissions: {},
        hasCompletedOnboarding: true
      };
      fs.writeFileSync(settingsPath, JSON.stringify(defaultSettings, null, 2));
      console.log('[Init] Created default Claude settings');
    } else {
      // Ensure hasCompletedOnboarding is set
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      if (!settings.hasCompletedOnboarding) {
        settings.hasCompletedOnboarding = true;
        settings.theme = settings.theme || 'dark';
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
        console.log('[Init] Updated Claude settings with onboarding flag');
      }
    }
  } catch (err) {
    console.error('[Init] Failed to initialize Claude settings:', err.message);
  }
}

// Initialize settings on startup
initClaudeSettings();

function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { created: Date.now() });
  return token;
}

function validateSession(token) {
  if (!token) return false;
  const session = sessions.get(token);
  if (!session) return false;
  if (Date.now() - session.created > SESSION_DURATION) {
    sessions.delete(token);
    return false;
  }
  return true;
}

// Cleanup expired sessions every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions.entries()) {
    if (now - session.created > SESSION_DURATION) {
      sessions.delete(token);
    }
  }
}, 5 * 60 * 1000);

function getSessionFromRequest(req) {
  // Check cookie first
  const cookies = req.headers.cookie || '';
  const match = cookies.match(/session=([^;]+)/);
  return match ? match[1] : null;
}

// CSRF token generation
function generateCsrfToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Web Push setup
let vapidKeys = null;
const pushSubscriptions = new Set();
const MAX_PUSH_SUBSCRIPTIONS = 100;

function setupWebPush() {
  // Check for environment variables first
  if (config.vapid.publicKey && config.vapid.privateKey) {
    vapidKeys = {
      publicKey: config.vapid.publicKey,
      privateKey: config.vapid.privateKey,
    };
  } else {
    // Store in mounted .claude directory for persistence across rebuilds
    const keysFile = path.join(CLAUDE_HOME, '.vapid-keys.json');

    if (fs.existsSync(keysFile)) {
      vapidKeys = JSON.parse(fs.readFileSync(keysFile, 'utf8'));
      console.log('[WebPush] Loaded existing VAPID keys');
    } else {
      vapidKeys = webpush.generateVAPIDKeys();
      try {
        fs.writeFileSync(keysFile, JSON.stringify(vapidKeys, null, 2));
        console.log('[WebPush] Generated and saved new VAPID keys');
      } catch (err) {
        console.log('[WebPush] Generated new VAPID keys (could not save)');
      }
    }
  }

  webpush.setVapidDetails(
    config.vapid.email,
    vapidKeys.publicKey,
    vapidKeys.privateKey
  );

  console.log('[WebPush] Initialized');
}

async function sendWebPush(title, body) {
  const payload = JSON.stringify({ title, body, url: '/' });
  const deadSubscriptions = [];

  for (const sub of pushSubscriptions) {
    try {
      await webpush.sendNotification(sub, payload);
    } catch (error) {
      if (error.statusCode === 410 || error.statusCode === 404) {
        deadSubscriptions.push(sub);
      } else {
        console.error('[WebPush] Error:', error.message);
      }
    }
  }

  // Clean up dead subscriptions
  for (const sub of deadSubscriptions) {
    pushSubscriptions.delete(sub);
  }
}

// Initialize Web Push
setupWebPush();

// Initialize components
const app = express();

// Trust first proxy only (Caddy) - more secure than 'trust proxy: true'
// This allows rate limiting to work while preventing IP spoofing
app.set('trust proxy', 1);

const server = http.createServer(app);
const wss = new WebSocketServer({
  server,
  maxPayload: 65536, // 64KB - reject at WebSocket level before buffering
  perMessageDeflate: false, // Disable compression to prevent zip bombs
});

server.on('upgrade', (req, socket, head) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
  console.log(`[Server] Upgrade request from ${ip}`);
});

// Security headers with helmet
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: [
        "'self'",
        "https://cdn.jsdelivr.net",  // For xterm.js
      ],
      styleSrc: [
        "'self'",
        "'unsafe-inline'",  // Required for xterm.js
        "https://cdn.jsdelivr.net",
      ],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: [
        "'self'",
        "wss:",  // WebSocket connections
        "ws:",   // For local development
      ],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,  // Required for some CDN resources
  crossOriginOpenerPolicy: { policy: "same-origin" },
  crossOriginResourcePolicy: { policy: "same-origin" },
  dnsPrefetchControl: { allow: false },
  frameguard: { action: "deny" },
  hsts: {
    maxAge: 31536000,  // 1 year
    includeSubDomains: true,
    preload: true,
  },
  ieNoOpen: true,
  noSniff: true,
  originAgentCluster: true,
  permittedCrossDomainPolicies: { permittedPolicies: "none" },
  referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  xssFilter: true,
}));

// Rate limiting: 100 requests per minute
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  message: { error: 'Too many requests' },
});
app.use(limiter);

// WebSocket rate limiting
const wsConnections = new Map(); // IP -> timestamp[]
const WS_RATE_LIMIT = 10; // max connections per minute per IP
const WS_WINDOW = 60 * 1000;

const ptyManager = new PTYManager({ cols: 120, rows: 40 });
const watcher = new Watcher({
  onTrigger: (result) => {
    // Send ntfy notification
    notifier.notify({ prompt: result.prompt });
    // Send web push notification
    sendWebPush('Claude Code - Input Needed', result.prompt);
  },
});

const notifier = new Notifier({
  server: config.ntfy.server,
  topic: config.ntfy.topic,
  token: config.ntfy.token,
  debounceSeconds: config.ntfy.debounceSeconds,
  clickUrl: `https://${config.domain}/`,
});

// Connected WebSocket clients
const clients = new Set();

// Serve static files (public, no auth required)
app.use(express.static(path.join(__dirname, 'public')));

// JSON body parser with strict Content-Type validation
app.use(express.json({
  strict: true, // Only accept arrays and objects
  type: 'application/json', // Only parse if Content-Type matches
}));

// Middleware to enforce Content-Type on POST/PUT/PATCH requests with body
app.use((req, res, next) => {
  const methodsWithBody = ['POST', 'PUT', 'PATCH'];

  if (methodsWithBody.includes(req.method) && req.path.startsWith('/api')) {
    const contentType = req.headers['content-type'];

    // Allow requests without body
    if (req.headers['content-length'] === '0') {
      return next();
    }

    // Require application/json for API requests with body
    if (!contentType || !contentType.includes('application/json')) {
      return res.status(415).json({
        error: 'Unsupported Media Type',
        message: 'Content-Type must be application/json'
      });
    }
  }
  next();
});

// CSRF token endpoint - provides token for login form
app.get('/api/csrf-token', (req, res) => {
  const token = generateCsrfToken();
  // Set CSRF token in cookie
  const isProduction = process.env.NODE_ENV === 'production' || process.env.FORCE_SECURE_COOKIES === 'true';
  res.cookie('csrf_token', token, {
    httpOnly: false, // Must be readable by JavaScript
    secure: isProduction,
    sameSite: 'strict',
    maxAge: 60 * 60 * 1000, // 1 hour
  });
  res.json({ token });
});

// CSRF validation middleware
function validateCsrf(req, res, next) {
  const cookieToken = req.cookies?.csrf_token ||
    (req.headers.cookie?.match(/csrf_token=([^;]+)/)?.[1]);
  const headerToken = req.headers['x-csrf-token'];

  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    return res.status(403).json({ error: 'Invalid CSRF token' });
  }
  next();
}

// Login endpoint with CSRF protection
app.post('/api/login', validateCsrf, async (req, res) => {
  const { username, password } = req.body;

  if (!config.auth.passHash) {
    console.error('[Auth] AUTH_PASS_HASH not configured');
    res.status(500).json({ error: 'Server auth not configured' });
    return;
  }

  try {
    const userMatch = username === config.auth.user;
    const passMatch = await bcrypt.compare(password, config.auth.passHash);

    if (userMatch && passMatch) {
      const token = createSession();
      // Use secure cookies in production (HTTPS), allow insecure for local dev
      const isProduction = process.env.NODE_ENV === 'production' || process.env.FORCE_SECURE_COOKIES === 'true';
      res.cookie('session', token, {
        httpOnly: true,
        secure: isProduction, // true in production (HTTPS required)
        sameSite: 'lax', // lax for better mobile compatibility
        maxAge: SESSION_DURATION,
      });
      console.log(`[Auth] Login successful for user: ${username}`);
      res.json({ success: true });
    } else {
      console.log(`[Auth] Login failed for user: ${username}`);
      res.status(401).json({ error: 'Invalid credentials' });
    }
  } catch (err) {
    console.error('[Auth] Error during login:', err.message);
    res.status(500).json({ error: 'Login error' });
  }
});

// Auth check endpoint
app.get('/api/auth-check', (req, res) => {
  const token = getSessionFromRequest(req);
  if (validateSession(token)) {
    res.json({ authenticated: true });
  } else {
    res.status(401).json({ authenticated: false });
  }
});

// Logout endpoint
app.post('/api/logout', (req, res) => {
  const token = getSessionFromRequest(req);

  if (token) {
    sessions.delete(token);
    console.log('[Auth] Session invalidated');
  }

  // Clear the session cookie
  const isProduction = process.env.NODE_ENV === 'production' || process.env.FORCE_SECURE_COOKIES === 'true';
  res.cookie('session', '', {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    maxAge: 0, // Expire immediately
  });

  res.json({ success: true });
});

// Auth middleware for protected API routes
function requireAuth(req, res, next) {
  const token = getSessionFromRequest(req);
  if (validateSession(token)) {
    next();
  } else {
    res.status(401).json({ error: 'Unauthorized' });
  }
}

// Web Push API endpoints (protected)
app.get('/api/vapid-public-key', requireAuth, (req, res) => {
  if (vapidKeys) {
    res.json({ publicKey: vapidKeys.publicKey });
  } else {
    res.status(503).json({ error: 'Web Push not configured' });
  }
});

app.post('/api/push-subscribe', requireAuth, (req, res) => {
  const subscription = req.body;
  if (subscription && subscription.endpoint) {
    // Limit max subscriptions to prevent memory leak
    if (pushSubscriptions.size >= MAX_PUSH_SUBSCRIPTIONS) {
      // Remove oldest (first) entry
      const oldest = pushSubscriptions.values().next().value;
      pushSubscriptions.delete(oldest);
    }
    pushSubscriptions.add(subscription);
    console.log(`[WebPush] New subscription (total: ${pushSubscriptions.size})`);
    res.json({ success: true });
  } else {
    res.status(400).json({ error: 'Invalid subscription' });
  }
});

// Basic health check endpoint (for load balancers/Docker - no auth required)
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: Date.now()
  });
});

// Detailed health endpoint (protected)
app.get('/api/health', requireAuth, (req, res) => {
  res.json({
    status: 'ok',
    timestamp: Date.now(),
    pty: ptyManager.getState(),
    notifications: notifier.getStats(),
    clients: clients.size,
  });
});

// API endpoint to get current state (protected)
app.get('/api/state', requireAuth, (req, res) => {
  res.json({
    pty: ptyManager.getState(),
    buffer: ptyManager.getBuffer(),
    lastTrigger: watcher.getLastTrigger(),
    config: {
      mockMode: config.mockMode,
      domain: config.domain,
    },
  });
});

// WebSocket abuse tracking
const bannedIps = new Map(); // IP -> ban expiry timestamp
const MAX_VIOLATIONS = 5; // Disconnect after this many violations
const BAN_DURATION = 5 * 60 * 1000; // 5 minute ban for severe abuse

// Clean up expired bans every minute
setInterval(() => {
  const now = Date.now();
  for (const [ip, expiry] of bannedIps.entries()) {
    if (now > expiry) {
      bannedIps.delete(ip);
      console.log(`[WS] Ban expired for IP: ${ip}`);
    }
  }
}, 60 * 1000);

// Get real client IP (supports reverse proxy)
function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    // Take the first IP (original client) from comma-separated list
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress;
}

// WebSocket handling
wss.on('connection', (ws, req) => {
  const ip = getClientIp(req);

  // Check if IP is banned
  if (bannedIps.has(ip) && Date.now() < bannedIps.get(ip)) {
    console.log(`[WS] Rejected banned IP: ${ip}`);
    ws.close(4403, 'Temporarily banned');
    return;
  }
  // Check for valid session token
  const token = getSessionFromRequest(req);
  if (!validateSession(token)) {
    console.log('[WS] Rejected - no valid session');
    ws.close(4001, 'Unauthorized');
    return;
  }

  // WebSocket rate limiting (ip already declared above)
  const now = Date.now();
  const connections = (wsConnections.get(ip) || []).filter(t => now - t < WS_WINDOW);
  if (connections.length >= WS_RATE_LIMIT) {
    console.log(`[WS] Rejected - rate limited (${ip})`);
    ws.close(4029, 'Rate limited');
    return;
  }
  connections.push(now);
  wsConnections.set(ip, connections);

  console.log('[WS] Client connected');
  clients.add(ws);

  // Initialize violation tracking
  ws.violations = 0;
  ws.messageTimestamps = [];

  // Send current state to new client
  ws.send(
    JSON.stringify({
      type: 'state',
      pty: ptyManager.getState(),
      buffer: ptyManager.getBuffer(),
      lastTrigger: watcher.getLastTrigger(),
    })
  );

  // WebSocket message rate limiting config
  const MESSAGE_RATE_LIMIT = 30; // messages per second
  const MESSAGE_WINDOW = 1000;

  ws.on('message', (message) => {
    // Secondary check (primary is WebSocket maxPayload)
    // Buffer.byteLength handles both string and Buffer
    const size = Buffer.isBuffer(message) ? message.length : Buffer.byteLength(message);
    if (size > 65536) {
      console.log('[WS] Rejected oversized message:', size);
      ws.close(1009, 'Message too large'); // 1009 = Message Too Big
      return;
    }

    // Per-connection message rate limiting with violation tracking
    const now = Date.now();
    ws.messageTimestamps = ws.messageTimestamps.filter(t => now - t < MESSAGE_WINDOW);

    if (ws.messageTimestamps.length >= MESSAGE_RATE_LIMIT) {
      ws.violations++;
      console.log(`[WS] Rate limited - violation ${ws.violations}/${MAX_VIOLATIONS}`);

      if (ws.violations >= MAX_VIOLATIONS) {
        // Ban the IP
        bannedIps.set(ip, Date.now() + BAN_DURATION);
        console.log(`[WS] IP banned for abuse: ${ip}`);
        ws.close(4429, 'Rate limit exceeded - temporarily banned');
        return;
      }
      return;
    }
    ws.messageTimestamps.push(now);

    try {
      const data = JSON.parse(message);
      handleClientMessage(ws, data);
    } catch (error) {
      console.error('[WS] Invalid message:', error.message);
    }
  });

  ws.on('close', () => {
    console.log('[WS] Client disconnected');
    clients.delete(ws);
  });

  ws.on('error', (error) => {
    console.error('[WS] Error:', error.message);
    clients.delete(ws);
  });
});

/**
 * Handle messages from WebSocket clients
 */
function handleClientMessage(ws, data) {
  switch (data.type) {
    case 'start':
      startClaude(data.args || [], data.cwd || '');
      break;

    case 'input':
      console.log('[WS] Input received, length:', data.data?.length || 0);
      if (ptyManager.isRunning()) {
        console.log('[PTY] Writing to PTY, length:', data.data?.length || 0);
        ptyManager.write(data.data);
        // Reset watcher when user sends Enter (submitted input)
        if (data.data === '\r' || data.data.includes('\r')) {
          watcher.reset();
          // Tell clients to hide options
          broadcast({ type: 'hideOptions' });
        }
        // Reset notification debounce on user input
        notifier.resetDebounce();
      } else {
        console.log('[PTY] Not running, ignoring input');
      }
      break;

    case 'resize':
      if (data.cols && data.rows) {
        ptyManager.resize(data.cols, data.rows);
      }
      break;

    case 'stop':
      ptyManager.kill();
      break;

    case 'getState':
      ws.send(
        JSON.stringify({
          type: 'state',
          pty: ptyManager.getState(),
          buffer: ptyManager.getBuffer(),
          lastTrigger: watcher.getLastTrigger(),
        })
      );
      break;

    default:
      console.log('[WS] Unknown message type:', data.type);
  }
}

/**
 * Start Claude Code process
 */
// Whitelist of allowed Claude CLI arguments with value patterns
const ALLOWED_CLAUDE_ARGS = {
  // Flags that take string values
  '--model': /^[a-zA-Z0-9_-]+$/,          // Model names: claude-3-opus, sonnet, etc.
  '--max-turns': /^\d{1,3}$/,              // Integer 1-999
  '--output-format': /^(json|text|stream)$/,
  '--input-format': /^(json|text)$/,

  // Boolean flags (no value)
  '--verbose': null,
  '--print': null,
  '--yes': null,
  '-y': null,
  '--no-cache': null,
  '--continue': null,
  '-c': null,
  '--resume': null,
  '-r': null,
};

// Maximum number of arguments to prevent abuse
const MAX_ARGS = 10;

// Dangerous patterns that should never appear anywhere
const DANGEROUS_PATTERNS = /[;&|`$(){}[\]<>\\'"!#*?~]/;

function validateArgs(args) {
  if (!Array.isArray(args)) return [];

  const validated = [];
  let i = 0;

  while (i < args.length && validated.length < MAX_ARGS) {
    const arg = String(args[i]).trim();
    i++;

    // Skip empty args
    if (!arg) continue;

    // Reject any arg containing dangerous characters
    if (DANGEROUS_PATTERNS.test(arg)) {
      console.log(`[Claude] Rejected argument with dangerous characters: ${arg}`);
      continue;
    }

    // Handle --flag=value format
    if (arg.includes('=')) {
      const [flag, ...valueParts] = arg.split('=');
      const value = valueParts.join('='); // Rejoin in case value contains =

      if (!(flag in ALLOWED_CLAUDE_ARGS)) {
        console.log(`[Claude] Rejected disallowed argument: ${flag}`);
        continue;
      }

      const pattern = ALLOWED_CLAUDE_ARGS[flag];
      if (pattern === null) {
        // Boolean flag shouldn't have =value
        console.log(`[Claude] Boolean flag ${flag} should not have value`);
        continue;
      }

      if (!pattern.test(value)) {
        console.log(`[Claude] Invalid value for ${flag}: ${value}`);
        continue;
      }

      validated.push(`${flag}=${value}`);
      continue;
    }

    // Handle standalone flag
    if (arg.startsWith('-')) {
      if (!(arg in ALLOWED_CLAUDE_ARGS)) {
        console.log(`[Claude] Rejected disallowed argument: ${arg}`);
        continue;
      }

      validated.push(arg);

      // Check if next arg is a value for this flag
      const pattern = ALLOWED_CLAUDE_ARGS[arg];
      if (pattern !== null && i < args.length) {
        const nextArg = String(args[i]).trim();

        // Value must not start with - and must match pattern
        if (!nextArg.startsWith('-') && !DANGEROUS_PATTERNS.test(nextArg)) {
          if (pattern.test(nextArg)) {
            validated.push(nextArg);
            i++;
          } else {
            console.log(`[Claude] Invalid value for ${arg}: ${nextArg}`);
          }
        }
      }
    }
    // Ignore non-flag arguments that don't follow a flag
  }

  if (args.length > MAX_ARGS) {
    console.log(`[Claude] Argument count limited from ${args.length} to ${MAX_ARGS}`);
  }

  return validated;
}

function startClaude(extraArgs = [], customCwd = '') {
  if (ptyManager.isRunning()) {
    broadcast({ type: 'error', message: 'Claude Code is already running' });
    return;
  }

  watcher.reset();

  const validatedArgs = validateArgs(extraArgs);
  const args = [...config.claude.opts, ...validatedArgs].filter(Boolean);

  // Build working directory path, ensuring it stays within /workspace
  let cwd = '/workspace';
  if (customCwd) {
    const resolved = path.resolve('/workspace', customCwd);
    const normalized = path.normalize(resolved);
    if (normalized === '/workspace' || normalized.startsWith('/workspace/')) {
      cwd = normalized;
    }
    // Otherwise ignore and use default /workspace
  }

  // Create directory if it doesn't exist
  if (!fs.existsSync(cwd)) {
    try {
      fs.mkdirSync(cwd, { recursive: true });
      console.log(`[Claude] Created directory: ${cwd}`);
    } catch (err) {
      console.error(`[Claude] Failed to create directory: ${err.message}`);
      broadcast({ type: 'error', message: `Failed to create directory: ${err.message}` });
      return;
    }
  }

  if (config.mockMode) {
    startMockMode();
    return;
  }

  try {
    ptyManager.spawn(config.claude.command, args, {
      cwd,
      env: {
        HOME: '/home/node_user',
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        TERM: 'xterm-256color',
      },
    });

    broadcast({ type: 'started', args, cwd });
    console.log(`[Claude] Started in ${cwd} with args: ${args.join(' ') || '(none)'}`);
  } catch (error) {
    console.error('[Claude] Failed to start:', error.message);
    broadcast({ type: 'error', message: `Failed to start: ${error.message}` });
  }
}

/**
 * Mock mode for testing without Claude Code
 */
function startMockMode() {
  console.log('[Mock] Starting mock mode');
  broadcast({ type: 'started', args: ['--mock'] });

  const mockSequence = [
    { delay: 500, text: 'Welcome to Claude Code (Mock Mode)\r\n' },
    { delay: 1000, text: '\r\nAnalyzing your request...\r\n' },
    { delay: 2000, text: '\r\nI found 3 files that need to be modified.\r\n' },
    { delay: 500, text: '\r\n\x1b[1;33mDo you want to proceed? (y/n)\x1b[0m ' },
    {
      delay: 0,
      waitForInput: true,
      onInput: (input) => {
        if (input.toLowerCase().startsWith('y')) {
          return [
            { delay: 500, text: '\r\n\r\nProceeding with changes...\r\n' },
            { delay: 1500, text: '\r\nModifying file 1/3: src/app.js\r\n' },
            { delay: 1000, text: 'Modifying file 2/3: src/utils.js\r\n' },
            { delay: 1000, text: 'Modifying file 3/3: src/config.js\r\n' },
            { delay: 500, text: '\r\n\x1b[1;32mAll changes complete!\x1b[0m\r\n' },
            {
              delay: 1000,
              text: '\r\nSelect an option:\r\n1. Review changes\r\n2. Commit changes\r\n3. Revert changes\r\n\r\n> ',
            },
          ];
        } else {
          return [
            { delay: 500, text: '\r\n\r\nOperation cancelled.\r\n' },
            {
              delay: 1000,
              text: '\r\nWould you like to (a)pply, (r)eject, or (e)dit the changes? ',
            },
          ];
        }
      },
    },
  ];

  runMockSequence(mockSequence);
}

let mockInputHandler = null;

function runMockSequence(sequence, index = 0) {
  if (index >= sequence.length) return;

  const item = sequence[index];

  if (item.waitForInput) {
    mockInputHandler = (input) => {
      mockInputHandler = null;
      const nextSequence = item.onInput(input);
      if (nextSequence) {
        runMockSequence(nextSequence);
      }
    };
    return;
  }

  setTimeout(() => {
    broadcastOutput(item.text);
    runMockSequence(sequence, index + 1);
  }, item.delay);
}

/**
 * Broadcast output to all clients
 */
function broadcastOutput(data) {
  // Process through watcher
  const triggerResult = watcher.process(data);

  // Send raw output
  broadcast({ type: 'output', data });

  // Send options if detected
  if (triggerResult) {
    broadcast(triggerResult);
  }
}

/**
 * Broadcast a message to all connected clients
 */
function broadcast(message) {
  const data = JSON.stringify(message);
  for (const client of clients) {
    if (client.readyState === 1) {
      // WebSocket.OPEN
      client.send(data);
    }
  }
}

// PTY event handlers
let themeSent = false;

ptyManager.on('data', (data) => {
  console.log('[PTY] Output:', data.substring(0, 100).replace(/\n/g, '\\n'));
  broadcastOutput(data);

  // Auto-select dark theme when menu appears (dashed line indicates menu ready)
  if (!themeSent && data.includes('╌╌╌')) {
    themeSent = true;
    console.log('[PTY] Menu ready, sending theme selection');
    ptyManager.write('1');
    setTimeout(() => {
      if (ptyManager.isRunning()) {
        ptyManager.write('\r');
      }
    }, 100);
  }
});

ptyManager.on('exit', ({ exitCode, signal }) => {
  console.log(`[Claude] Exited with code ${exitCode}, signal ${signal}`);
  themeSent = false; // Reset for next run
  broadcast({
    type: 'exit',
    exitCode,
    signal,
  });
});

ptyManager.on('error', (error) => {
  console.error('[Claude] Error:', error.message);
  broadcast({
    type: 'error',
    message: error.message,
  });
});

// Handle mock mode input
const originalHandleClientMessage = handleClientMessage;
handleClientMessage = function (ws, data) {
  if (config.mockMode && data.type === 'input' && mockInputHandler) {
    mockInputHandler(data.data);
    broadcastOutput(data.data);
    return;
  }
  originalHandleClientMessage(ws, data);
};

// Start server
server.listen(config.port, '0.0.0.0', () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║         Claude Code Mobile Controller                       ║
╠════════════════════════════════════════════════════════════╣
║  Server running on port ${config.port.toString().padEnd(33)}║
║  Domain: ${config.domain.padEnd(48)}║
║  Mock mode: ${config.mockMode.toString().padEnd(45)}║
║  Notifications: ${config.ntfy.topic ? 'enabled' : 'disabled (no topic)'}${' '.repeat(Math.max(0, 40 - (config.ntfy.topic ? 7 : 19)))}║
╚════════════════════════════════════════════════════════════╝
  `);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[Server] SIGTERM received, shutting down...');
  ptyManager.kill();
  server.close(() => {
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('[Server] SIGINT received, shutting down...');
  ptyManager.kill();
  server.close(() => {
    process.exit(0);
  });
});
