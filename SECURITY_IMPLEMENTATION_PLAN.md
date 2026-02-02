# Security Implementation Plan for OnClaude

This document provides a comprehensive implementation plan for fixing security issues #3-20 identified in the security review. Issues are organized by priority and grouped for efficient batch implementation.

---

## Table of Contents

1. [Implementation Summary](#implementation-summary)
2. [Implementation Order](#implementation-order)
3. [Batch Groups](#batch-groups)
4. [Detailed Issue Plans](#detailed-issue-plans)
   - [HIGH Priority](#high-priority-issues)
   - [MEDIUM Priority](#medium-priority-issues)
   - [LOW Priority](#low-priority-issues)
5. [New Dependencies](#new-dependencies)
6. [Breaking Changes Summary](#breaking-changes-summary)
7. [Rollback Strategy](#rollback-strategy)

---

## Implementation Summary

| Issue | Priority | Effort | Risk | Batch |
|-------|----------|--------|------|-------|
| #3 Health endpoint auth | HIGH | Low | Low | A |
| #4 ReDoS in ANSI regex | HIGH | Medium | Low | B |
| #5 CSRF on login | HIGH | Medium | Medium | A |
| #6 Whitelist bypass | HIGH | Medium | Low | B |
| #7 WS message size | HIGH | Low | Low | C |
| #8 Static auth | MEDIUM | Medium | Medium | A |
| #9 innerHTML usage | MEDIUM | Low | Low | D |
| #10 Docker network | MEDIUM | Low | Low | E |
| #11 Session invalidation | MEDIUM | Low | Low | A |
| #12 WS rate escalation | MEDIUM | Medium | Low | C |
| #13 VAPID filesystem | MEDIUM | Low | Low | A |
| #14 Content-Type validation | MEDIUM | Low | Low | A |
| #15 Console logging | LOW | Low | Low | F |
| #16 Security headers | LOW | Low | Low | A |
| #17 CDN SRI | LOW | Low | Low | D |
| #18 Password field attrs | LOW | Low | Low | D |
| #19 Docker health HTTP | LOW | Low | Low | E |
| #20 Error message leaks | LOW | Low | Low | F |

---

## Implementation Order

Recommended order based on dependencies and risk:

1. **Batch A** (Authentication & Core Security) - Issues #3, #5, #8, #11, #13, #14, #16
2. **Batch B** (Input Validation) - Issues #4, #6
3. **Batch C** (WebSocket Hardening) - Issues #7, #12
4. **Batch D** (Frontend Security) - Issues #9, #17, #18
5. **Batch E** (Docker Security) - Issues #10, #19
6. **Batch F** (Information Disclosure) - Issues #15, #20

---

## Batch Groups

### Batch A: Authentication & Core Security
**Files affected:** `app/server.js`
**Issues:** #3, #5, #8, #11, #13, #14, #16

### Batch B: Input Validation
**Files affected:** `app/server.js`, `app/lib/watcher.js`
**Issues:** #4, #6

### Batch C: WebSocket Hardening
**Files affected:** `app/server.js`
**Issues:** #7, #12

### Batch D: Frontend Security
**Files affected:** `app/public/index.html`, `app/public/app.js`
**Issues:** #9, #17, #18

### Batch E: Docker Security
**Files affected:** `app/Dockerfile`, `docker-compose.yml` (if exists)
**Issues:** #10, #19

### Batch F: Information Disclosure
**Files affected:** `app/server.js`, `app/lib/notifier.js`
**Issues:** #15, #20

---

## Detailed Issue Plans

---

# HIGH PRIORITY ISSUES

---

## Issue #3: Health Endpoint Exposes Internal State Without Authentication

### Problem
The `/health` endpoint at line 309-316 of `server.js` exposes sensitive internal state including PTY status, notification stats, and client count without requiring authentication.

### Technical Approach
Create two separate health endpoints:
1. `/health` - Basic health check for load balancers (no sensitive data)
2. `/api/health` - Detailed health info requiring authentication

### Files to Modify

**File:** `D:\projects\OnClaude\app\server.js`
**Lines:** 308-316

### Before
```javascript
// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    pty: ptyManager.getState(),
    notifications: notifier.getStats(),
    clients: clients.size,
  });
});
```

### After
```javascript
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
```

### Testing Strategy
1. Verify `/health` returns only `status` and `timestamp`
2. Verify `/health` works without authentication
3. Verify `/api/health` requires authentication (401 without session)
4. Verify `/api/health` returns full details when authenticated
5. Update Docker HEALTHCHECK to use basic `/health` endpoint

### Rollback Plan
Revert to single `/health` endpoint if monitoring systems depend on the detailed data.

### Dependencies/New Packages
None required.

### Breaking Changes
- Monitoring systems expecting detailed health data at `/health` need to be updated to use `/api/health` with authentication
- Docker health check continues to work (uses basic `/health`)

### Security Trade-offs
Basic health endpoint still reveals server is running, but this is acceptable for orchestration purposes.

---

## Issue #4: Potential ReDoS in ANSI Regex

### Problem
The ANSI regex in `watcher.js` line 15 and in `mightContainTrigger` function (line 164-165) could be vulnerable to ReDoS attacks with crafted input.

### Technical Approach
1. Replace vulnerable regex patterns with safe, non-backtracking alternatives
2. Add input length limits before regex processing
3. Use the well-tested `strip-ansi` package which is already a dependency

### Files to Modify

**File:** `D:\projects\OnClaude\app\lib\watcher.js`
**Lines:** 14-15, 163-169

### Before (lines 14-15)
```javascript
// ANSI escape sequence regex - simplified to prevent ReDoS
this.ansiRegex = /\x1b\[[0-9;]*m|\x1b\][^\x07]*\x07/g;
```

### After (lines 14-15)
```javascript
// Use strip-ansi for safe ANSI removal (avoids ReDoS)
this.stripAnsiModule = require('strip-ansi');
```

### Before (lines 23-25)
```javascript
stripAnsi(text) {
  return text.replace(this.ansiRegex, '');
}
```

### After (lines 23-25)
```javascript
stripAnsi(text) {
  // Limit input length to prevent DoS
  if (text.length > 100000) {
    text = text.slice(-100000);
  }
  return this.stripAnsiModule(text);
}
```

### Before (lines 163-169)
```javascript
function mightContainTrigger(text) {
  const stripped = text.replace(
    /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
    ''
  );
  return TRIGGER_PATTERNS.some((pattern) => pattern.test(stripped));
}
```

### After (lines 163-169)
```javascript
function mightContainTrigger(text) {
  // Use strip-ansi module for safe ANSI removal
  const stripAnsi = require('strip-ansi');
  // Limit input to prevent DoS
  const limited = text.length > 50000 ? text.slice(-50000) : text;
  const stripped = stripAnsi(limited);
  return TRIGGER_PATTERNS.some((pattern) => pattern.test(stripped));
}
```

### Testing Strategy
1. Unit test with normal ANSI sequences
2. Stress test with crafted malicious input (repeated escape sequences)
3. Performance benchmark before/after with large inputs
4. Verify no functionality regression with Claude Code output

### Rollback Plan
Revert to original regex if `strip-ansi` causes compatibility issues.

### Dependencies/New Packages
`strip-ansi` is already in `package.json` - no new dependencies needed.

### Breaking Changes
None expected - `strip-ansi` produces identical output.

### Security Trade-offs
Input length limiting could theoretically truncate very long legitimate output, but 100KB is well above any practical terminal buffer.

---

## Issue #5: No CSRF Protection on Login Endpoint

### Problem
The `/api/login` endpoint (line 227) lacks CSRF protection, making it vulnerable to cross-site request forgery attacks.

### Technical Approach
1. Implement double-submit cookie pattern (stateless CSRF)
2. Generate CSRF token on page load and store in cookie
3. Require token in request header for login
4. Alternative: Use SameSite=Strict cookies (simpler but less robust)

### Files to Modify

**File:** `D:\projects\OnClaude\app\server.js`
**Lines:** 8 (add import), 186-224 (add CSRF middleware), 227-260 (modify login)

**File:** `D:\projects\OnClaude\app\public\app.js`
**Lines:** 582-601 (modify login function)

### Implementation in server.js

#### Add after line 9 (imports)
```javascript
// CSRF token generation
function generateCsrfToken() {
  return crypto.randomBytes(32).toString('hex');
}
```

#### Add before line 227 (login endpoint)
```javascript
// CSRF token endpoint - provides token for login form
app.get('/api/csrf-token', (req, res) => {
  const token = generateCsrfToken();
  // Set CSRF token in cookie
  res.cookie('csrf_token', token, {
    httpOnly: false, // Must be readable by JavaScript
    secure: process.env.NODE_ENV === 'production',
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
```

#### Modify login endpoint (line 227)
```javascript
// Login endpoint with CSRF protection
app.post('/api/login', validateCsrf, async (req, res) => {
  // ... existing login logic ...
});
```

### Implementation in app.js

#### Modify login function (around line 570)
```javascript
loginBtn.addEventListener('click', async () => {
  const user = loginUser.value;
  const pass = loginPass.value;
  loginError.classList.add('hidden');

  if (!user || !pass) {
    loginError.textContent = 'Enter username and password';
    loginError.classList.remove('hidden');
    return;
  }

  loginBtn.disabled = true;
  try {
    // Get CSRF token first
    const csrfRes = await fetch('/api/csrf-token');
    const { token } = await csrfRes.json();

    const res = await fetch('/api/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': token
      },
      body: JSON.stringify({ username: user, password: pass })
    });
    if (res.ok) {
      isAuthenticated = true;
      showStartOptions();
      connect();
    } else {
      loginError.textContent = 'Invalid credentials';
      loginError.classList.remove('hidden');
    }
  } catch (e) {
    loginError.textContent = 'Connection error';
    loginError.classList.remove('hidden');
  }
  loginBtn.disabled = false;
});
```

### Testing Strategy
1. Verify login works with valid CSRF token
2. Verify login fails without CSRF token (403)
3. Verify login fails with mismatched token
4. Test from different origin (should fail)
5. Verify token rotation works

### Rollback Plan
Remove CSRF middleware and revert to simple login if mobile compatibility issues arise.

### Dependencies/New Packages
None - uses built-in crypto module.

### Breaking Changes
- Any automated login scripts will need to fetch CSRF token first
- API clients must include X-CSRF-Token header

### Security Trade-offs
Double-submit cookies are secure against CSRF but require JavaScript. This is acceptable since the app requires JavaScript anyway.

---

## Issue #6: PTY Command Arguments Whitelist Bypass Potential

### Problem
The argument validation in `validateArgs` (lines 470-499) could potentially be bypassed through creative argument construction, particularly with the `--flag=value` format and value-following logic.

### Technical Approach
1. Stricter whitelist with explicit value patterns
2. Block dangerous characters in all positions
3. Validate argument values against allowed patterns
4. Add maximum argument count limit

### Files to Modify

**File:** `D:\projects\OnClaude\app\server.js`
**Lines:** 463-499

### Before
```javascript
// Whitelist of allowed Claude CLI arguments
const ALLOWED_CLAUDE_ARGS = [
  '--model', '--max-turns', '--verbose', '--print',
  '--output-format', '--input-format', '--yes', '-y',
  '--no-cache', '--continue', '-c', '--resume', '-r'
];

function validateArgs(args) {
  if (!Array.isArray(args)) return [];

  const validated = [];
  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i]).trim();

    // Skip empty args
    if (!arg) continue;

    // Check if it's an allowed flag
    if (arg.startsWith('-')) {
      const flagName = arg.split('=')[0]; // Handle --flag=value format
      if (ALLOWED_CLAUDE_ARGS.includes(flagName)) {
        validated.push(arg);
      } else {
        console.log(`[Claude] Rejected disallowed argument: ${flagName}`);
      }
    } else if (validated.length > 0 && validated[validated.length - 1].startsWith('-')) {
      // Allow values that follow allowed flags (e.g., --model sonnet)
      // But sanitize: no shell metacharacters
      if (!/[;&|`$(){}[\]<>\\]/.test(arg)) {
        validated.push(arg);
      } else {
        console.log(`[Claude] Rejected argument with shell characters: ${arg}`);
      }
    }
  }
  return validated;
}
```

### After
```javascript
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
```

### Testing Strategy
1. Test all allowed arguments work correctly
2. Test `--flag=value` format for all value-taking flags
3. Test argument rejection with shell metacharacters
4. Test bypass attempts: `--model=;rm -rf`, `--model $(cmd)`, etc.
5. Test MAX_ARGS limit
6. Test flag ordering (flag before value)
7. Fuzz testing with random strings

### Rollback Plan
Keep original validateArgs function as `validateArgsLegacy` for quick rollback.

### Dependencies/New Packages
None.

### Breaking Changes
- Some creative argument usage may no longer work
- Arguments exceeding MAX_ARGS limit are silently dropped

### Security Trade-offs
Stricter validation may reject some legitimate but unusual argument patterns.

---

## Issue #7: WebSocket Message Size Limit May Be Insufficient

### Problem
The WebSocket message size limit (64KB at line 372) may be insufficient for some use cases, but more importantly, large messages could still cause memory issues before the check.

### Technical Approach
1. Configure WebSocket server with `maxPayload` option
2. Add early rejection at WebSocket level
3. Keep application-level check as secondary defense

### Files to Modify

**File:** `D:\projects\OnClaude\app\server.js`
**Lines:** 180, 371-375

### Before (line 180)
```javascript
const wss = new WebSocketServer({ server });
```

### After (line 180)
```javascript
const wss = new WebSocketServer({
  server,
  maxPayload: 65536, // 64KB - reject at WebSocket level before buffering
  perMessageDeflate: false, // Disable compression to prevent zip bombs
});
```

### Before (lines 371-375)
```javascript
ws.on('message', (message) => {
  // Limit message size to 64KB
  if (message.length > 65536) {
    console.log('[WS] Rejected oversized message:', message.length);
    return;
  }
```

### After (lines 371-375)
```javascript
ws.on('message', (message) => {
  // Secondary check (primary is WebSocket maxPayload)
  // Buffer.byteLength handles both string and Buffer
  const size = Buffer.isBuffer(message) ? message.length : Buffer.byteLength(message);
  if (size > 65536) {
    console.log('[WS] Rejected oversized message:', size);
    ws.close(1009, 'Message too large'); // 1009 = Message Too Big
    return;
  }
```

### Testing Strategy
1. Send message exactly at 64KB limit (should work)
2. Send message 1 byte over limit (should be rejected)
3. Test rapid large message sending
4. Verify close code 1009 is sent
5. Memory profiling under load

### Rollback Plan
Remove `maxPayload` option if legitimate large messages are needed.

### Dependencies/New Packages
None - `maxPayload` is built into `ws` package.

### Breaking Changes
Clients sending messages >64KB will be disconnected with code 1009.

### Security Trade-offs
64KB should be sufficient for all legitimate use cases (terminal input, resize commands).

---

# MEDIUM PRIORITY ISSUES

---

## Issue #8: Static Files Served Without Authentication

### Problem
Static files at `app/public/` (line 221) are served without authentication, potentially exposing the application structure and JavaScript code.

### Technical Approach
1. Only serve essential bootstrap files (login page) without auth
2. Require authentication for main application files
3. Use middleware to check auth before serving protected assets

### Files to Modify

**File:** `D:\projects\OnClaude\app\server.js`
**Lines:** 220-221

**File:** `D:\projects\OnClaude\app\public\index.html`
(Split into login and app pages, or use dynamic loading)

### Implementation Option A: Conditional Static Serving

#### Replace line 221
```javascript
// Serve only specific files without auth
const PUBLIC_WITHOUT_AUTH = [
  '/index.html',
  '/',
  '/style.css',
  '/manifest.json',
  '/icon-192.svg',
  '/favicon.ico',
];

// Custom static file middleware with auth for protected files
app.use((req, res, next) => {
  // Check if this is a static file request
  const isStaticRequest = !req.path.startsWith('/api') &&
                          !req.path.startsWith('/health') &&
                          req.method === 'GET';

  if (!isStaticRequest) {
    return next();
  }

  // Allow public files without auth
  if (PUBLIC_WITHOUT_AUTH.includes(req.path)) {
    return express.static(path.join(__dirname, 'public'))(req, res, next);
  }

  // app.js and other scripts require auth
  const token = getSessionFromRequest(req);
  if (validateSession(token)) {
    return express.static(path.join(__dirname, 'public'))(req, res, next);
  }

  // Return 401 for protected static files
  res.status(401).json({ error: 'Unauthorized' });
});
```

### Alternative Implementation Option B: Keep Simple (Recommended)

Since the login form is in index.html and app.js contains only client-side code that's useless without authentication, a simpler approach:

```javascript
// Static files - login page visible to all, but app requires auth to function
// Note: app.js is visible but useless without valid session (all API calls fail)
app.use(express.static(path.join(__dirname, 'public')));
```

Keep current implementation but document the security model:
- Static files are visible but contain no secrets
- All functionality requires authenticated API calls
- This is similar to most SPAs (React, Vue, etc.)

### Testing Strategy
1. Verify login page loads without auth
2. Verify CSS loads without auth
3. (Option A) Verify app.js requires auth
4. Verify all API endpoints still require auth

### Rollback Plan
Revert to unrestricted static serving.

### Dependencies/New Packages
None.

### Breaking Changes
(Option A) Service workers may break if not in PUBLIC_WITHOUT_AUTH list.

### Security Trade-offs
**Recommendation:** Keep Option B (current behavior). The JavaScript code is not sensitive - all sensitive operations require authenticated API calls. Protecting static files adds complexity with minimal security benefit for this application type.

---

## Issue #9: innerHTML Usage in Frontend

### Problem
The `app.js` file uses `innerHTML` at line 379 which could lead to XSS if unsanitized data is rendered.

### Technical Approach
Replace `innerHTML` with safer DOM manipulation methods.

### Files to Modify

**File:** `D:\projects\OnClaude\app\public\app.js`
**Lines:** 379

### Before (line 379)
```javascript
optionsButtons.innerHTML = '';
```

### After (line 379)
```javascript
// Clear children safely without innerHTML
while (optionsButtons.firstChild) {
  optionsButtons.removeChild(optionsButtons.firstChild);
}
```

### Additional Review
The `textContent` assignments in the file are safe:
- Line 378: `optionsPrompt.textContent = prompt || 'Select:';` - Safe
- Line 383: `btn.textContent = opt.label;` - Safe

No other innerHTML usage found in app.js.

### Testing Strategy
1. Verify options buttons clear correctly
2. Verify new options render correctly
3. Test with special characters in option labels
4. No XSS possible since textContent is used for content

### Rollback Plan
Revert to innerHTML = '' if performance issues observed (unlikely).

### Dependencies/New Packages
None.

### Breaking Changes
None.

### Security Trade-offs
None - this is a strict improvement.

---

## Issue #10: Docker Container Runs with Full Network Access

### Problem
The Dockerfile doesn't restrict network capabilities, allowing the container full network access which could be exploited if compromised.

### Technical Approach
1. Add network restrictions in docker-compose
2. Document required network access
3. Consider read-only filesystem where possible

### Files to Modify

**File:** `D:\projects\OnClaude\docker-compose.yml` (create if needed)

### Before (no docker-compose.yml restrictions)
```yaml
# Basic docker-compose.yml
version: '3.8'
services:
  onclaud:
    build: ./app
    ports:
      - "3000:3000"
```

### After
```yaml
version: '3.8'
services:
  onclaud:
    build: ./app
    ports:
      - "3000:3000"
    # Security restrictions
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    cap_add:
      - CHOWN
      - SETUID
      - SETGID
    read_only: true
    tmpfs:
      - /tmp
      - /home/node_user/.claude:mode=770
    networks:
      - onclaud-internal
    # Limit resources
    deploy:
      resources:
        limits:
          memory: 512M
          cpus: '1.0'

networks:
  onclaud-internal:
    driver: bridge
    internal: false  # Set to true if no external access needed
    driver_opts:
      com.docker.network.bridge.enable_ip_masquerade: 'true'
```

### Dockerfile Additions
```dockerfile
# Add security labels
LABEL org.opencontainers.image.title="OnClaude"
LABEL org.opencontainers.image.description="Claude Code Mobile Controller"

# Reduce attack surface
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    git \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean
```

### Testing Strategy
1. Verify container starts with restrictions
2. Verify Claude Code functionality works
3. Test that container cannot make unauthorized network connections
4. Verify tmpfs mounts work for Claude config

### Rollback Plan
Remove security restrictions from docker-compose.yml.

### Dependencies/New Packages
None.

### Breaking Changes
- May affect some Claude Code network operations
- Read-only filesystem requires tmpfs mounts for writable directories

### Security Trade-offs
Claude Code legitimately needs network access for API calls. Full isolation isn't possible, but limiting capabilities reduces blast radius.

---

## Issue #11: Session Tokens Not Invalidated on Logout

### Problem
There's no logout endpoint to invalidate session tokens. Users can't securely end their sessions.

### Technical Approach
1. Add `/api/logout` endpoint
2. Delete session from sessions Map
3. Clear session cookie

### Files to Modify

**File:** `D:\projects\OnClaude\app\server.js`
**Lines:** After line 270 (after auth-check endpoint)

### Implementation

#### Add after auth-check endpoint (line 270)
```javascript
// Logout endpoint
app.post('/api/logout', (req, res) => {
  const token = getSessionFromRequest(req);

  if (token) {
    sessions.delete(token);
    console.log('[Auth] Session invalidated');
  }

  // Clear the session cookie
  res.cookie('session', '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 0, // Expire immediately
  });

  res.json({ success: true });
});
```

#### Add to app.js (frontend) - new logout functionality
```javascript
// Add logout button to UI and handler
async function logout() {
  try {
    await fetch('/api/logout', { method: 'POST' });
  } catch (e) {
    // Ignore errors - we're logging out anyway
  }
  isAuthenticated = false;
  if (ws) {
    ws.close();
  }
  showLoginForm();
}
```

### Testing Strategy
1. Login, then logout
2. Verify session cookie is cleared
3. Verify subsequent API calls return 401
4. Verify WebSocket connection is rejected after logout

### Rollback Plan
Remove logout endpoint (sessions will still expire naturally).

### Dependencies/New Packages
None.

### Breaking Changes
None - adds new functionality.

### Security Trade-offs
None - this is a strict improvement.

---

## Issue #12: No Rate Limiting Escalation for WebSocket Abuse

### Problem
Current WebSocket rate limiting (30 messages/second) doesn't escalate for repeated violations. An attacker could continuously hit the limit without penalty.

### Technical Approach
1. Track violations per connection
2. Disconnect after N violations
3. Add IP-based temporary ban for severe abuse

### Files to Modify

**File:** `D:\projects\OnClaude\app\server.js`
**Lines:** 366-386

### Before
```javascript
// WebSocket message rate limiting config
const MESSAGE_RATE_LIMIT = 30; // messages per second
const MESSAGE_WINDOW = 1000;

ws.on('message', (message) => {
  // Limit message size to 64KB
  if (message.length > 65536) {
    console.log('[WS] Rejected oversized message:', message.length);
    return;
  }

  // Per-connection message rate limiting
  if (!ws.messageTimestamps) ws.messageTimestamps = [];
  const now = Date.now();
  ws.messageTimestamps = ws.messageTimestamps.filter(t => now - t < MESSAGE_WINDOW);

  if (ws.messageTimestamps.length >= MESSAGE_RATE_LIMIT) {
    console.log('[WS] Rate limited - too many messages');
    return;
  }
  ws.messageTimestamps.push(now);
```

### After
```javascript
// WebSocket message rate limiting config
const MESSAGE_RATE_LIMIT = 30; // messages per second
const MESSAGE_WINDOW = 1000;
const MAX_VIOLATIONS = 5; // Disconnect after this many violations
const BAN_DURATION = 5 * 60 * 1000; // 5 minute ban for severe abuse

// Track banned IPs
const bannedIps = new Map(); // IP -> ban expiry timestamp

// Clean up expired bans every minute
setInterval(() => {
  const now = Date.now();
  for (const [ip, expiry] of bannedIps.entries()) {
    if (now > expiry) {
      bannedIps.delete(ip);
    }
  }
}, 60 * 1000);

// In WebSocket connection handler, add ban check:
wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;

  // Check if IP is banned
  if (bannedIps.has(ip) && Date.now() < bannedIps.get(ip)) {
    console.log(`[WS] Rejected banned IP: ${ip}`);
    ws.close(4403, 'Temporarily banned');
    return;
  }

  // ... existing auth and rate limit checks ...

  // Initialize violation counter
  ws.violations = 0;
  ws.messageTimestamps = [];

  ws.on('message', (message) => {
    // ... size check ...

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
    // ... rest of message handling ...
  });
});
```

### Testing Strategy
1. Send messages at rate limit (should work)
2. Exceed rate limit - verify messages dropped
3. Exceed rate limit 5 times - verify disconnect
4. Verify IP ban prevents reconnection
5. Verify ban expires after 5 minutes

### Rollback Plan
Remove violation tracking and ban logic; keep simple rate limiting.

### Dependencies/New Packages
None.

### Breaking Changes
Aggressive clients may get temporarily banned.

### Security Trade-offs
Legitimate users with poor network conditions might trigger false positives. 5 violations before ban provides reasonable tolerance.

---

## Issue #13: VAPID Keys Written to Filesystem

### Problem
VAPID keys are written to `.vapid-keys.json` (line 138) which could be exposed if file permissions are incorrect or if the filesystem is compromised.

### Technical Approach
1. Prefer environment variables for VAPID keys
2. If generating keys, store with restrictive permissions
3. Add warning if using filesystem storage

### Files to Modify

**File:** `D:\projects\OnClaude\app\server.js`
**Lines:** 123-150

### Before
```javascript
function setupWebPush() {
  // Check for environment variables first
  if (config.vapid.publicKey && config.vapid.privateKey) {
    vapidKeys = {
      publicKey: config.vapid.publicKey,
      privateKey: config.vapid.privateKey,
    };
  } else {
    // Try to load from file or generate new keys
    const keysFile = path.join(__dirname, '.vapid-keys.json');

    if (fs.existsSync(keysFile)) {
      vapidKeys = JSON.parse(fs.readFileSync(keysFile, 'utf8'));
    } else {
      vapidKeys = webpush.generateVAPIDKeys();
      fs.writeFileSync(keysFile, JSON.stringify(vapidKeys, null, 2));
      console.log('[WebPush] Generated new VAPID keys');
    }
  }
```

### After
```javascript
function setupWebPush() {
  // Check for environment variables first (RECOMMENDED)
  if (config.vapid.publicKey && config.vapid.privateKey) {
    vapidKeys = {
      publicKey: config.vapid.publicKey,
      privateKey: config.vapid.privateKey,
    };
    console.log('[WebPush] Using VAPID keys from environment');
  } else {
    // Fallback to filesystem (less secure)
    const keysFile = path.join(__dirname, '.vapid-keys.json');

    if (fs.existsSync(keysFile)) {
      try {
        const stats = fs.statSync(keysFile);
        // Check file permissions (Unix only)
        if (process.platform !== 'win32' && (stats.mode & 0o077) !== 0) {
          console.warn('[WebPush] WARNING: VAPID keys file has insecure permissions');
          console.warn('[WebPush] Run: chmod 600 .vapid-keys.json');
        }
        vapidKeys = JSON.parse(fs.readFileSync(keysFile, 'utf8'));
      } catch (err) {
        console.error('[WebPush] Failed to read VAPID keys:', err.message);
        return;
      }
    } else {
      vapidKeys = webpush.generateVAPIDKeys();
      try {
        // Write with restrictive permissions
        fs.writeFileSync(keysFile, JSON.stringify(vapidKeys, null, 2), { mode: 0o600 });
        console.log('[WebPush] Generated new VAPID keys');
        console.warn('[WebPush] SECURITY: Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY environment variables for production');
      } catch (err) {
        console.error('[WebPush] Failed to write VAPID keys:', err.message);
        // Continue with in-memory keys (will be regenerated on restart)
      }
    }
  }
```

### Add to Dockerfile/.dockerignore

#### .dockerignore
```
.vapid-keys.json
```

### Testing Strategy
1. Test with environment variables (should work)
2. Test without env vars (should generate file)
3. Verify file permissions on Unix
4. Verify warning messages appear

### Rollback Plan
Revert to original file handling.

### Dependencies/New Packages
None.

### Breaking Changes
None.

### Security Trade-offs
Filesystem storage is still supported for development convenience, but with warnings.

---

## Issue #14: Missing Content-Type Validation on JSON Endpoints

### Problem
The JSON body parser (line 224) accepts requests without proper Content-Type validation.

### Technical Approach
1. Enforce Content-Type: application/json for JSON endpoints
2. Reject requests with missing or incorrect Content-Type

### Files to Modify

**File:** `D:\projects\OnClaude\app\server.js`
**Lines:** 224

### Before
```javascript
// JSON body parser for API endpoints
app.use(express.json());
```

### After
```javascript
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
```

### Testing Strategy
1. POST to /api/login with Content-Type: application/json (should work)
2. POST without Content-Type (should fail 415)
3. POST with Content-Type: text/plain (should fail 415)
4. GET requests without Content-Type (should work)

### Rollback Plan
Remove Content-Type validation middleware.

### Dependencies/New Packages
None.

### Breaking Changes
Clients not sending Content-Type header will receive 415 errors.

### Security Trade-offs
May break some simple curl commands or scripts that don't set Content-Type.

---

# LOW PRIORITY ISSUES

---

## Issue #15: Console Logging Contains Potentially Sensitive Data

### Problem
Various console.log statements may leak sensitive information:
- Line 250: Logs username on successful login
- Line 253: Logs username on failed login
- Line 417: Logs input length
- Line 659: Logs PTY output

### Technical Approach
1. Create structured logging utility
2. Sanitize sensitive data before logging
3. Use log levels (info, warn, error, debug)
4. Make debug logging configurable

### Files to Modify

**File:** `D:\projects\OnClaude\app\lib\logger.js` (new file)
**File:** `D:\projects\OnClaude\app\server.js` (multiple lines)

### Create new logger utility

#### `app/lib/logger.js`
```javascript
/**
 * Structured logging utility with sensitivity awareness
 */

const LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const currentLevel = LOG_LEVELS[process.env.LOG_LEVEL || 'info'];
const isProduction = process.env.NODE_ENV === 'production';

function sanitize(data) {
  if (typeof data !== 'string') return data;

  // Truncate long strings
  if (data.length > 100) {
    data = data.substring(0, 100) + '...[truncated]';
  }

  // Remove potential secrets
  data = data.replace(/password[=:]["']?[^"'\s]+["']?/gi, 'password=[REDACTED]');
  data = data.replace(/token[=:]["']?[^"'\s]+["']?/gi, 'token=[REDACTED]');
  data = data.replace(/key[=:]["']?[^"'\s]+["']?/gi, 'key=[REDACTED]');

  return data;
}

function log(level, tag, message, data = null) {
  if (LOG_LEVELS[level] < currentLevel) return;

  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [${level.toUpperCase()}] [${tag}]`;

  let logMessage = `${prefix} ${message}`;

  if (data !== null) {
    const sanitized = isProduction ? sanitize(JSON.stringify(data)) : JSON.stringify(data);
    logMessage += ` ${sanitized}`;
  }

  switch (level) {
    case 'error':
      console.error(logMessage);
      break;
    case 'warn':
      console.warn(logMessage);
      break;
    default:
      console.log(logMessage);
  }
}

module.exports = {
  debug: (tag, msg, data) => log('debug', tag, msg, data),
  info: (tag, msg, data) => log('info', tag, msg, data),
  warn: (tag, msg, data) => log('warn', tag, msg, data),
  error: (tag, msg, data) => log('error', tag, msg, data),
};
```

### Example usage in server.js
```javascript
const logger = require('./lib/logger');

// Before
console.log(`[Auth] Login successful for user: ${username}`);

// After
logger.info('Auth', 'Login successful', { user: username.substring(0, 3) + '***' });
```

### Testing Strategy
1. Verify logs don't contain full passwords
2. Verify logs don't contain session tokens
3. Verify log levels work correctly
4. Verify production mode sanitizes more aggressively

### Rollback Plan
Keep console.log statements alongside logger during transition.

### Dependencies/New Packages
None.

### Breaking Changes
Log format changes may affect log parsing tools.

### Security Trade-offs
Some debugging information is lost in production mode.

---

## Issue #16: Missing Security Headers

### Problem
The application doesn't set security headers like:
- X-Content-Type-Options
- X-Frame-Options
- Content-Security-Policy
- Strict-Transport-Security (HSTS)

### Technical Approach
Use the `helmet` middleware package for comprehensive security headers.

### Files to Modify

**File:** `D:\projects\OnClaude\app\server.js`
**Lines:** After line 178 (after express() initialization)

**File:** `D:\projects\OnClaude\app\package.json`

### Implementation

#### Add to package.json dependencies
```json
"helmet": "^7.1.0"
```

#### Add to server.js after express initialization
```javascript
const helmet = require('helmet');

// Security headers
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
```

### Testing Strategy
1. Verify all security headers present in responses
2. Test CSP doesn't break xterm.js loading
3. Test WebSocket connections still work
4. Use security header scanner (securityheaders.com)

### Rollback Plan
Remove helmet middleware.

### Dependencies/New Packages
`helmet` - well-maintained, widely used.

### Breaking Changes
CSP may break if there are unlisted external resources.

### Security Trade-offs
CSP is somewhat permissive to allow CDN resources. Could be stricter with local bundling.

---

## Issue #17: External CDN Dependencies Without SRI

### Problem
xterm.js is loaded from jsdelivr CDN (lines 92-95 of index.html) without Subresource Integrity (SRI) hashes.

### Technical Approach
Add SRI integrity attributes to CDN script/link tags.

### Files to Modify

**File:** `D:\projects\OnClaude\app\public\index.html`
**Lines:** 92-95

### Before
```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.css">
<script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-web-links@0.11.0/lib/addon-web-links.min.js"></script>
```

### After
```html
<link rel="stylesheet"
  href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.css"
  integrity="sha384-[HASH_HERE]"
  crossorigin="anonymous">
<script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js"
  integrity="sha384-[HASH_HERE]"
  crossorigin="anonymous"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js"
  integrity="sha384-[HASH_HERE]"
  crossorigin="anonymous"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-web-links@0.11.0/lib/addon-web-links.min.js"
  integrity="sha384-[HASH_HERE]"
  crossorigin="anonymous"></script>
```

### Generate SRI Hashes
Use https://www.srihash.org/ or:
```bash
curl -s https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js | openssl dgst -sha384 -binary | openssl base64 -A
```

### Alternative: Bundle Locally
Instead of CDN, install xterm locally and serve from public folder:
```bash
npm install @xterm/xterm @xterm/addon-fit @xterm/addon-web-links
```

Then copy to public folder and update HTML.

### Testing Strategy
1. Verify page loads correctly with SRI
2. Test that tampering with CDN would be detected (modify hash, should fail to load)
3. Test offline caching still works with service worker

### Rollback Plan
Remove integrity attributes.

### Dependencies/New Packages
None for SRI approach; xterm packages for local bundling.

### Breaking Changes
None expected.

### Security Trade-offs
SRI prevents CDN compromise but means updates require hash regeneration.

---

## Issue #18: Password Input Field Lacks Additional Security Attributes

### Problem
The password input (line 47 of index.html) lacks some security-enhancing attributes.

### Technical Approach
Add autocomplete, autocapitalize, and other security attributes.

### Files to Modify

**File:** `D:\projects\OnClaude\app\public\index.html`
**Lines:** 47

### Before
```html
<input type="password" id="login-pass" placeholder="Password" autocomplete="current-password">
```

### After
```html
<input type="password"
  id="login-pass"
  placeholder="Password"
  autocomplete="current-password"
  autocapitalize="off"
  autocorrect="off"
  spellcheck="false"
  data-lpignore="true"
  data-form-type="password">
```

### Attributes Explanation
- `autocapitalize="off"` - Prevents mobile keyboards from capitalizing
- `autocorrect="off"` - Prevents autocorrect from modifying password
- `spellcheck="false"` - Prevents spell-check underlining
- `data-lpignore="true"` - Hint for LastPass to handle carefully
- `data-form-type="password"` - Semantic hint for password managers

### Testing Strategy
1. Verify password managers still work
2. Test on mobile - no autocapitalize
3. Test spell check doesn't activate

### Rollback Plan
Remove additional attributes.

### Dependencies/New Packages
None.

### Breaking Changes
None.

### Security Trade-offs
None - these are improvements.

---

## Issue #19: Docker Health Check Uses Insecure HTTP

### Problem
The Docker HEALTHCHECK (line 54-55 of Dockerfile) uses HTTP which could leak information if network is sniffed.

### Technical Approach
Since health checks are internal to Docker, this is low risk. Options:
1. Keep HTTP but document it's internal only
2. Use a different health check mechanism (file-based)
3. Accept the trade-off (health checks need to be simple)

### Files to Modify

**File:** `D:\projects\OnClaude\app\Dockerfile`
**Lines:** 54-55

### Before
```dockerfile
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1
```

### Option A: File-based Health Check (Most Secure)
```dockerfile
# Health check using file presence (no network exposure)
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"
```

### Option B: Keep HTTP with Comment (Pragmatic)
```dockerfile
# Health check - HTTP is acceptable since it's localhost-only within container
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1
```

### Option C: Wget Alternative (Smaller Attack Surface)
```dockerfile
# Remove curl, use wget (already in base image or smaller footprint)
RUN apt-get update && apt-get install -y --no-install-recommends wget \
    && rm -rf /var/lib/apt/lists/*

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --quiet --spider http://localhost:3000/health || exit 1
```

### Recommendation
Keep Option B. The HTTP is localhost-only within the container network namespace. The risk is negligible compared to the complexity of alternatives.

### Testing Strategy
1. Verify Docker health check works
2. Verify container marked healthy/unhealthy correctly

### Rollback Plan
N/A - keeping current behavior.

### Dependencies/New Packages
None.

### Breaking Changes
None.

### Security Trade-offs
Localhost HTTP within container is acceptable risk.

---

## Issue #20: Error Messages May Leak Information

### Problem
Error messages returned to clients may contain stack traces or internal information.

### Technical Approach
1. Add global error handler
2. Return generic errors to clients
3. Log detailed errors server-side only

### Files to Modify

**File:** `D:\projects\OnClaude\app\server.js`
**Lines:** After all route definitions (before server.listen)

### Implementation

#### Add global error handler
```javascript
// Generic error responses for production
const isProduction = process.env.NODE_ENV === 'production';

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Global error handler
app.use((err, req, res, next) => {
  // Log full error server-side
  console.error('[Error]', err.stack || err.message || err);

  // Send sanitized error to client
  const statusCode = err.statusCode || err.status || 500;

  const response = {
    error: isProduction ? 'Internal server error' : err.message,
  };

  // Include stack trace only in development
  if (!isProduction && err.stack) {
    response.stack = err.stack;
  }

  res.status(statusCode).json(response);
});
```

#### Update existing error responses

##### Before (example from login)
```javascript
res.status(500).json({ error: 'Login error' });
```

##### After
```javascript
res.status(500).json({ error: 'Authentication failed' });
```

#### Update WebSocket error handling
```javascript
ws.on('message', (message) => {
  try {
    const data = JSON.parse(message);
    handleClientMessage(ws, data);
  } catch (error) {
    // Don't leak parse error details
    console.error('[WS] Message handling error:', error.message);
    ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
  }
});
```

### Testing Strategy
1. Trigger various errors and verify generic responses
2. Verify detailed errors logged server-side
3. Verify stack traces not exposed in production
4. Test 404 handler

### Rollback Plan
Remove error handler middleware.

### Dependencies/New Packages
None.

### Breaking Changes
Error message format changes may affect client error handling.

### Security Trade-offs
Less debugging information available to legitimate users troubleshooting issues.

---

## New Dependencies

| Package | Version | Purpose | Issues |
|---------|---------|---------|--------|
| helmet | ^7.1.0 | Security headers | #16 |

Note: `strip-ansi` is already in package.json.

---

## Breaking Changes Summary

| Issue | Breaking Change | Migration |
|-------|-----------------|-----------|
| #3 | Health endpoint returns less data | Use /api/health with auth |
| #5 | Login requires CSRF token | Fetch token first, send in header |
| #6 | Stricter argument validation | Review custom args for compliance |
| #7 | Large WS messages rejected | Keep messages under 64KB |
| #12 | Aggressive clients get banned | Implement backoff |
| #14 | Content-Type required | Add header to POST requests |
| #20 | Generic error messages | Check server logs for details |

---

## Rollback Strategy

All changes are designed for easy rollback:

1. **Git-based**: Each batch should be a separate commit for easy revert
2. **Feature flags**: Where possible, use environment variables to toggle
3. **Gradual rollout**: Deploy to staging first
4. **Monitoring**: Watch error rates and user feedback

### Emergency Rollback Commands
```bash
# Revert last commit
git revert HEAD

# Revert specific batch
git revert <batch-commit-hash>

# Revert to known good state
git reset --hard <known-good-commit>
```

### Environment Variable Toggles
```bash
# Disable CSRF (emergency only)
DISABLE_CSRF=true

# Disable strict Content-Type
STRICT_CONTENT_TYPE=false

# Lower log level for debugging
LOG_LEVEL=debug
```

---

## Testing Checklist

### Unit Tests
- [ ] CSRF token generation/validation
- [ ] Argument validation with malicious inputs
- [ ] Rate limit escalation logic
- [ ] Logger sanitization

### Integration Tests
- [ ] Login flow with CSRF
- [ ] WebSocket connection and messaging
- [ ] Session lifecycle (login/logout)
- [ ] Health endpoint access control

### Security Tests
- [ ] ReDoS fuzzing on ANSI parsing
- [ ] Argument injection attempts
- [ ] CSRF bypass attempts
- [ ] Rate limit abuse testing

### Performance Tests
- [ ] ANSI parsing with large inputs
- [ ] WebSocket message throughput
- [ ] Concurrent connection handling

---

## Implementation Timeline (Suggested)

| Week | Batch | Issues | Focus |
|------|-------|--------|-------|
| 1 | A | #3, #5, #8, #11, #13, #14, #16 | Auth & Core Security |
| 2 | B | #4, #6 | Input Validation |
| 2 | C | #7, #12 | WebSocket Hardening |
| 3 | D | #9, #17, #18 | Frontend Security |
| 3 | E | #10, #19 | Docker Security |
| 4 | F | #15, #20 | Information Disclosure |

---

## Approval Checklist

Before implementation, ensure:
- [ ] Security team review
- [ ] Product owner sign-off on breaking changes
- [ ] DevOps review of Docker changes
- [ ] QA test plan prepared
- [ ] Rollback procedures documented
- [ ] Monitoring alerts configured

---

*Document generated: 2024*
*Last updated: Pending implementation*
