# syntax=docker/dockerfile:1

# ───────────────────────────────────────────────────────────────────────────────
# Claude Code Mobile Controller - Dockerfile
# ───────────────────────────────────────────────────────────────────────────────

FROM node:20-bookworm-slim

# Install system dependencies for node-pty and Claude Code
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    git \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI globally
# Note: This assumes Claude Code is available via npm. If it's installed differently,
# adjust this line accordingly.
RUN npm install -g @anthropic-ai/claude-code

# Create app directory
WORKDIR /app

# Create non-root user for security
RUN useradd -m -s /bin/bash node_user \
    && mkdir -p /home/node_user/.claude \
    && chown -R node_user:node_user /home/node_user

# Copy package files first for better layer caching
COPY package*.json ./

# Install dependencies (including native modules)
RUN npm install

# Copy application source
COPY . .

# Set ownership
RUN chown -R node_user:node_user /app

# Switch to non-root user
USER node_user

# Set home directory for Claude auth
ENV HOME=/home/node_user

# Expose the application port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

# Start the application
CMD ["node", "server.js"]
