.PHONY: up down logs logs-app restart shell test-notify hash-password clean build help

# Default target
help:
	@echo "Claude Code Mobile Controller"
	@echo ""
	@echo "Usage: make [target]"
	@echo ""
	@echo "Targets:"
	@echo "  up              Start all services (detached)"
	@echo "  up-ntfy         Start all services including self-hosted ntfy"
	@echo "  down            Stop all services"
	@echo "  build           Rebuild the claude-app image"
	@echo "  logs            Follow logs for all services"
	@echo "  logs-app        Follow logs for claude-app only"
	@echo "  restart         Restart all services"
	@echo "  shell           Open a shell in the claude-app container"
	@echo "  test-notify     Send a test notification"
	@echo "  hash-password   Generate bcrypt hash (usage: make hash-password PASS=yourpassword)"
	@echo "  clean           Remove containers, images, and volumes"
	@echo ""

# Load .env file if it exists
ifneq (,$(wildcard ./.env))
    include .env
    export
endif

# Start services
up:
	docker compose up -d --build

# Start services with self-hosted ntfy
up-ntfy:
	docker compose --profile ntfy up -d --build

# Stop services
down:
	docker compose --profile ntfy down

# Rebuild
build:
	docker compose build --no-cache

# Follow all logs
logs:
	docker compose logs -f

# Follow claude-app logs
logs-app:
	docker compose logs -f claude-app

# Restart services
restart:
	docker compose restart

# Shell into claude-app
shell:
	docker compose exec claude-app /bin/sh

# Send test notification
test-notify:
	@if [ -z "$(NTFY_TOPIC)" ]; then \
		echo "Error: NTFY_TOPIC not set. Create a .env file first."; \
		exit 1; \
	fi
	@SERVER=$${NTFY_SERVER:-https://ntfy.sh}; \
	echo "Sending test notification to $$SERVER/$(NTFY_TOPIC)..."; \
	curl -s \
		-H "Title: Claude Code Test" \
		-H "Priority: high" \
		-H "Tags: white_check_mark" \
		-d "Test notification from Claude Code Mobile Controller" \
		"$$SERVER/$(NTFY_TOPIC)" && echo " Done!"

# Generate bcrypt hash for Caddy basicauth
# Usage: make hash-password PASS=yourpassword
hash-password:
	@if [ -z "$(PASS)" ]; then \
		echo "Usage: make hash-password PASS=yourpassword"; \
		exit 1; \
	fi
	@echo "Generating bcrypt hash for password..."
	@docker run --rm caddy:2-alpine caddy hash-password --plaintext "$(PASS)"
	@echo ""
	@echo "Copy the hash above into your .env file as AUTH_PASS_HASH"

# Clean up everything
clean:
	docker compose --profile ntfy down -v --rmi local
	@echo "Cleaned up containers, volumes, and local images"
