# OnClaude

Mobile remote for Claude Code. Control Claude running on your Windows machine from your phone. Get push notifications when Claude needs input, tap to respond, and interact via a mobile-friendly web UI — no Remote Desktop needed.

## Features

- **Mobile-First Web UI**: Optimized for phone screens with large, tappable buttons
- **Smart Input Detection**: Automatically detects when Claude Code needs your input (y/n prompts, numbered options, etc.) and presents them as buttons
- **Push Notifications**: Get notified on your iPhone via ntfy when Claude Code needs attention
- **HTTPS & Authentication**: Secure access over the internet with automatic TLS certificates
- **PTY Emulation**: Full terminal emulation — Claude Code runs exactly as it would locally
- **Mock Mode**: Test the UI without running Claude Code

## Quick Start

### Prerequisites

- Windows with Docker Desktop installed
- A domain name pointing to your machine's public IP
- Port 80 and 443 accessible from the internet (for HTTPS)
- An iPhone with the [ntfy app](https://apps.apple.com/app/ntfy/id1625396347) installed

---

## Step-by-Step Setup Walkthrough

### Step 1: Clone the Repository

```bash
git clone <this-repo>
cd OnClaude
```

### Step 2: Copy and Edit Environment File

```bash
cp .env.example .env
```

Open `.env` in your editor and configure these settings:

#### Required Settings

```bash
# Your domain (must have DNS pointing to your public IP)
DOMAIN=claude.yourdomain.com

# Web UI login credentials
AUTH_USER=admin
AUTH_PASS=your-secure-password

# Path to your code projects (mounted as /workspace in container)
WORKSPACE_PATH=C:/Users/YourName/projects

# Path to your Claude config directory (for authentication)
# Usually: C:/Users/YourName/.claude
CLAUDE_CONFIG_PATH=C:/Users/YourName/.claude

# Notification topic - pick something random and unguessable!
NTFY_TOPIC=claude-abc123xyz789
```

#### Optional Settings

```bash
# API key (leave blank to use existing Claude auth from CLAUDE_CONFIG_PATH)
ANTHROPIC_API_KEY=

# Extra CLI flags
CLAUDE_OPTS=--dangerously-skip-permissions
```

### Step 3: Generate Password Hash

Caddy requires a bcrypt-hashed password for authentication:

```bash
# Using Make
make hash-password PASS=your-secure-password

# Or using Docker directly
docker run --rm caddy:2-alpine caddy hash-password --plaintext "your-secure-password"
```

Copy the output (starts with `$2a$` or `$2b$`) into your `.env`:

```bash
AUTH_PASS_HASH=$2a$14$Zkx19XLiAWeXJYrg...
```

### Step 4: Configure Your Router/Firewall

For HTTPS to work, you need:

1. **DNS**: Point your domain to your public IP address
2. **Port Forwarding**: Forward ports 80 and 443 to your machine
3. **Firewall**: Allow incoming connections on ports 80 and 443

### Step 5: Start the Services

```bash
# Build and start all containers
make up

# Or using docker compose directly
docker compose up -d --build
```

First startup will:
- Build the Node.js application container
- Download the Caddy reverse proxy image
- Provision a TLS certificate from Let's Encrypt (requires ports 80/443)

Check that everything is running:

```bash
make logs
# or
docker compose logs -f
```

### Step 6: Set Up Phone Notifications

1. Install the **ntfy** app: [iOS App Store](https://apps.apple.com/app/ntfy/id1625396347) | [Android Play Store](https://play.google.com/store/apps/details?id=io.heckel.ntfy)
2. Open the app and tap **+** (or Subscribe)
3. Enter your topic name exactly as in `NTFY_TOPIC`
4. Tap Subscribe

Test it works:

```bash
make test-notify
```

You should receive a notification on your phone.

### Step 7: Access the Web UI

1. Open `https://your-domain.com` on your phone or computer
2. Log in with `AUTH_USER` and `AUTH_PASS` (the plaintext password, not the hash)
3. Tap **Start Claude Code**

#### Install as App (Optional)

**iOS (Safari):**
1. Tap the Share button (square with arrow)
2. Scroll down and tap "Add to Home Screen"
3. Tap "Add"

**Android (Chrome):**
1. Tap the menu (three dots)
2. Tap "Add to Home Screen" or "Install App"
3. Tap "Add"

The app will launch in fullscreen mode without browser UI.

### Step 8: First Run Authentication

If you haven't set `ANTHROPIC_API_KEY`, Claude will show a login flow:

1. You'll see a URL to authenticate
2. Copy the URL and open it in a browser
3. Log in with your Claude account
4. Return to the terminal and confirm

Your auth token will be saved in the mounted `.claude` directory.

---

## UI Controls

The status bar has toggle buttons:

| Button | Function |
|--------|----------|
| 🔘 | Toggle auto-generated option buttons (OFF by default) |
| ⌨️ | Toggle navigation keys (arrows, backspace, etc.) |
| 🔔/🔕 | Toggle push notifications |
| Stop | Kill the running Claude process |

Navigation keys (when enabled): ▲ ▼ ⌫ Enter Esc Y N

---

## Usage

### Web Interface

The interface has two main areas:

**Terminal Output** (top): Shows Claude Code's output with colors. Scrolls automatically.

**Input Area** (bottom):
- **Option Buttons**: When Claude Code asks a question (like "Do you want to proceed? (y/n)"), buttons appear automatically. Tap to respond.
- **Text Input**: For typing custom responses or prompts. Always visible below the buttons.

### Workflow

1. Claude Code runs a task
2. When it needs input (confirmation, selection, etc.), you get a push notification
3. Tap the notification to open the web UI
4. Tap the appropriate button or type your response
5. Continue from anywhere!

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DOMAIN` | Yes | - | Your domain with DNS pointing to this machine |
| `AUTH_USER` | Yes | - | Web UI login username |
| `AUTH_PASS` | Yes | - | Web UI login password (plaintext, for your reference) |
| `AUTH_PASS_HASH` | Yes | - | Bcrypt hash of password (generate with `make hash-password`) |
| `WORKSPACE_PATH` | Yes | - | Windows path to your code projects |
| `CLAUDE_CONFIG_PATH` | Yes | - | Path to your `.claude` config directory |
| `NTFY_TOPIC` | Yes | - | Unique notification topic name |
| `NTFY_SELF_HOSTED` | No | `false` | Set `true` to use the bundled ntfy server |
| `NTFY_TOKEN` | No | - | Auth token for private ntfy topics |
| `ANTHROPIC_API_KEY` | No | - | API key (or authenticate interactively) |
| `CLAUDE_OPTS` | No | - | Extra CLI flags for Claude Code |
| `DEBOUNCE_SECONDS` | No | `30` | Minimum seconds between repeat notifications |
| `MOCK_MODE` | No | `false` | Run without Claude Code (for testing) |

### Self-Hosted ntfy

By default, notifications go through the public `ntfy.sh` server. For more privacy, you can self-host ntfy:

1. Set `NTFY_SELF_HOSTED=true` in `.env`
2. Start with the ntfy profile:
   ```bash
   make up-ntfy
   ```
3. In the ntfy iOS app:
   - Go to Settings → Add Server
   - Enter `https://your-domain.com/ntfy`
   - Subscribe to your topic

## Commands

```bash
make up              # Start all services
make up-ntfy         # Start with self-hosted ntfy
make down            # Stop all services
make build           # Rebuild images
make logs            # Follow all logs
make logs-app        # Follow claude-app logs only
make restart         # Restart services
make shell           # Shell into claude-app container
make test-notify     # Send a test notification
make hash-password   # Generate bcrypt hash
make clean           # Remove everything
```

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Internet                                 │
└────────────────────────────┬────────────────────────────────────┘
                             │ HTTPS (443)
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  Caddy (Reverse Proxy)                                          │
│  - Auto TLS via Let's Encrypt                                   │
│  - Basic Auth                                                   │
│  - Routes to claude-app and ntfy                                │
└──────────────────┬─────────────────────────┬────────────────────┘
                   │                         │
                   ▼                         ▼
┌──────────────────────────────┐  ┌──────────────────────────────┐
│  claude-app (Node.js)        │  │  ntfy (optional)             │
│  - Express + WebSocket       │  │  - Push notification server  │
│  - PTY management            │  │  - Self-hosted alternative   │
│  - Output parsing            │  │    to ntfy.sh                │
│  - Notification triggers     │  │                              │
└──────────────────────────────┘  └──────────────────────────────┘
         │
         ▼
┌──────────────────────────────┐
│  Claude Code (PTY)           │
│  - Runs inside container     │
│  - /workspace mounted        │
└──────────────────────────────┘
```

## Detected Input Patterns

The Smart Watcher detects these patterns and shows them as buttons:

| Claude Code Output | Buttons Shown |
|-------------------|---------------|
| `(y/n)` or `[Y/n]` | Yes, No |
| `(y/n/always)` | Yes, No, Always |
| `1. Option A`, `2. Option B` | Numbered buttons |
| `(a)pply, (r)eject, (e)dit` | Apply, Reject, Edit |
| `Press Enter to continue` | Continue |

## Troubleshooting

### Can't connect to the web UI

1. Check that your domain's DNS points to your machine's public IP
2. Ensure ports 80 and 443 are forwarded/open
3. Check Caddy logs: `make logs`

### Not receiving notifications

1. Verify the ntfy app is installed and subscribed to your topic
2. Test notifications: `make test-notify`
3. Check iOS notification settings for the ntfy app
4. Ensure `NTFY_TOPIC` is set in `.env`

### Claude Code won't start

1. Check logs: `make logs-app`
2. Verify `ANTHROPIC_API_KEY` is set (or use interactive auth)
3. Try `MOCK_MODE=true` to test without Claude Code

### Authentication issues

1. Regenerate password hash: `make hash-password PASS=yourpassword`
2. Ensure `AUTH_PASS_HASH` in `.env` includes the full hash (starts with `$2a$` or `$2b$`)

### Buttons not appearing

1. Check browser console for JavaScript errors
2. The output parser may not recognize the pattern — check `app/lib/option-parser.js`

## Security Considerations

- **HTTPS Only**: Caddy enforces HTTPS with auto-renewed certificates
- **Basic Auth**: All requests require authentication
- **Random Topic**: Use a long, random `NTFY_TOPIC` to prevent unauthorized notifications
- **No Plaintext Secrets**: All secrets come from environment variables
- **Container Isolation**: Claude Code runs in a container with limited permissions

## File Structure

```
OnClaude/
├── docker-compose.yml      # Container orchestration
├── .env.example            # Environment template
├── .env                    # Your configuration (git-ignored)
├── Caddyfile               # Reverse proxy config
├── Makefile                # Convenience commands
├── README.md               # This file
└── app/
    ├── Dockerfile          # Node.js container
    ├── package.json        # Dependencies
    ├── server.js           # Main application
    ├── lib/
    │   ├── pty-manager.js  # PTY lifecycle management
    │   ├── watcher.js      # Output monitoring
    │   ├── option-parser.js # Button extraction
    │   └── notifier.js     # ntfy integration
    └── public/
        ├── index.html      # Web UI
        ├── style.css       # Mobile-first styles
        └── app.js          # Frontend logic
```

## License

MIT
