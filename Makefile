# Bank Sync Service Makefile
.PHONY: help install build dev test docker-build docker-up docker-down deploy deploy-nas logs clean

# Variables
SERVICE_NAME = bank-sync-service
DOCKER_IMAGE = $(SERVICE_NAME):latest
NAS_HOST = k2600x@192.168.1.11
NAS_PATH = /volume1/docker/bank-sync-service
DOCKER_REGISTRY = localhost:5000

# Colors for output
RED = \033[0;31m
GREEN = \033[0;32m
YELLOW = \033[1;33m
NC = \033[0m # No Color

help: ## Show this help message
	@echo "$(GREEN)Bank Sync Service - Available targets:$(NC)"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  $(YELLOW)%-20s$(NC) %s\n", $$1, $$2}'

install: ## Install dependencies
	@echo "$(GREEN)Installing dependencies...$(NC)"
	npm ci

build: ## Build TypeScript
	@echo "$(GREEN)Building TypeScript...$(NC)"
	npm run build

dev: ## Start development server
	@echo "$(GREEN)Starting development server...$(NC)"
	npm run dev

test: ## Run tests
	@echo "$(GREEN)Running tests...$(NC)"
	npm test

lint: ## Run linter
	@echo "$(GREEN)Running linter...$(NC)"
	npm run lint

# Docker commands
docker-build: ## Build Docker image
	@echo "$(GREEN)Building Docker image...$(NC)"
	docker build -t $(DOCKER_IMAGE) .

docker-up: ## Start services with docker-compose
	@echo "$(GREEN)Starting services...$(NC)"
	docker-compose up -d

docker-down: ## Stop services
	@echo "$(GREEN)Stopping services...$(NC)"
	docker-compose down

docker-logs: ## Show service logs
	docker-compose logs -f bank-sync-service

docker-redis-cli: ## Connect to Redis CLI
	docker exec -it bank-sync-redis redis-cli

# Deployment commands
deploy-prepare: ## Prepare deployment package
	@echo "$(GREEN)Preparing deployment...$(NC)"
	@rm -rf deploy/
	@mkdir -p deploy
	@cp -r src contracts package*.json tsconfig.json Dockerfile docker-compose.yml redis.conf .env.example deploy/
	@echo "$(GREEN)Creating deployment archive...$(NC)"
	@tar -czf bank-sync-service.tar.gz -C deploy .
	@rm -rf deploy/
	@echo "$(GREEN)Deployment package ready: bank-sync-service.tar.gz$(NC)"

deploy-nas: deploy-prepare ## Deploy to NAS
	@echo "$(GREEN)Deploying to NAS $(NAS_HOST)...$(NC)"
	@echo "$(YELLOW)Creating directory on NAS...$(NC)"
	ssh $(NAS_HOST) "mkdir -p $(NAS_PATH)"
	
	@echo "$(YELLOW)Copying files to NAS...$(NC)"
	scp bank-sync-service.tar.gz $(NAS_HOST):$(NAS_PATH)/
	
	@echo "$(YELLOW)Extracting and setting up on NAS...$(NC)"
	ssh $(NAS_HOST) "cd $(NAS_PATH) && \
		tar -xzf bank-sync-service.tar.gz && \
		rm bank-sync-service.tar.gz && \
		if [ ! -f .env ]; then cp .env.example .env && echo '$(RED)Please configure .env file on NAS$(NC)'; fi"
	
	@echo "$(YELLOW)Building and starting services on NAS...$(NC)"
	ssh $(NAS_HOST) "cd $(NAS_PATH) && \
		docker-compose build && \
		docker-compose down && \
		docker-compose up -d"
	
	@echo "$(GREEN)Deployment complete!$(NC)"
	@echo "$(YELLOW)Service should be available at: http://192.168.1.11:4010$(NC)"
	@rm -f bank-sync-service.tar.gz

deploy-update: ## Update deployment on NAS (quick update without full rebuild)
	@echo "$(GREEN)Quick update to NAS...$(NC)"
	@echo "$(YELLOW)Syncing source files...$(NC)"
	rsync -avz --delete \
		--exclude 'node_modules' \
		--exclude 'dist' \
		--exclude '.env' \
		--exclude 'data' \
		--exclude '.git' \
		src contracts package*.json tsconfig.json Dockerfile docker-compose.yml redis.conf \
		$(NAS_HOST):$(NAS_PATH)/
	
	@echo "$(YELLOW)Rebuilding on NAS...$(NC)"
	ssh $(NAS_HOST) "cd $(NAS_PATH) && \
		docker-compose build bank-sync-service && \
		docker-compose up -d bank-sync-service"
	
	@echo "$(GREEN)Update complete!$(NC)"

deploy-status: ## Check deployment status on NAS
	@echo "$(GREEN)Checking deployment status...$(NC)"
	@ssh $(NAS_HOST) "cd $(NAS_PATH) && docker-compose ps"
	@echo ""
	@echo "$(YELLOW)Health check:$(NC)"
	@curl -s http://192.168.1.11:4010/health | jq . || echo "$(RED)Service not responding$(NC)"

deploy-logs: ## View logs from NAS deployment
	@echo "$(GREEN)Fetching logs from NAS...$(NC)"
	ssh $(NAS_HOST) "cd $(NAS_PATH) && docker-compose logs --tail=100 -f"

deploy-restart: ## Restart services on NAS
	@echo "$(YELLOW)Restarting services on NAS...$(NC)"
	ssh $(NAS_HOST) "cd $(NAS_PATH) && docker-compose restart"

deploy-stop: ## Stop services on NAS
	@echo "$(YELLOW)Stopping services on NAS...$(NC)"
	ssh $(NAS_HOST) "cd $(NAS_PATH) && docker-compose down"

# Local testing with real GoCardless
test-local: ## Test locally with docker-compose
	@echo "$(GREEN)Starting local test environment...$(NC)"
	@if [ ! -f .env ]; then \
		echo "$(RED)Error: .env file not found. Copy .env.example and configure it.$(NC)"; \
		exit 1; \
	fi
	docker-compose up --build

test-sync: ## Test sync endpoint (requires ACCOUNT_ID env var)
	@if [ -z "$$ACCOUNT_ID" ]; then \
		echo "$(RED)Error: ACCOUNT_ID environment variable not set$(NC)"; \
		exit 1; \
	fi
	@echo "$(GREEN)Testing sync for account $$ACCOUNT_ID...$(NC)"
	curl -X POST http://localhost:4010/v1/sync/$$ACCOUNT_ID | jq .

test-accounts: ## Test accounts endpoint
	@echo "$(GREEN)Testing accounts endpoint...$(NC)"
	curl -s http://localhost:4010/v1/accounts | jq .

# Cleanup
clean: ## Clean build artifacts and dependencies
	@echo "$(RED)Cleaning build artifacts...$(NC)"
	rm -rf dist/ node_modules/ coverage/ *.log bank-sync-service.tar.gz

clean-docker: ## Clean Docker artifacts
	@echo "$(RED)Cleaning Docker artifacts...$(NC)"
	docker-compose down -v
	docker rmi $(DOCKER_IMAGE) || true

# Database management
redis-backup: ## Backup Redis data
	@echo "$(GREEN)Backing up Redis data...$(NC)"
	docker exec bank-sync-redis redis-cli BGSAVE
	@sleep 2
	docker cp bank-sync-redis:/data/dump.rdb ./redis-backup-$$(date +%Y%m%d-%H%M%S).rdb
	@echo "$(GREEN)Backup completed$(NC)"

redis-cli: ## Connect to Redis CLI
	docker exec -it bank-sync-redis redis-cli

# Development helpers
watch: ## Watch for changes and rebuild
	@echo "$(GREEN)Watching for changes...$(NC)"
	npm run dev

format: ## Format code
	@echo "$(GREEN)Formatting code...$(NC)"
	npm run format

# === BANK SYNC STATUS COMMANDS ===
status: ## Show comprehensive bank sync status
	@echo "$(GREEN)🔍 Bank Sync Service Status$(NC)"
	@echo "=============================="
	@echo ""
	@echo "$(YELLOW)Service Health:$(NC)"
	@curl -s http://192.168.1.11:4010/health | jq '.' || echo "$(RED)Service not responding$(NC)"
	@echo ""
	@echo "$(YELLOW)Authentication:$(NC)"
	@curl -s http://192.168.1.11:4010/v1/auth/status | jq '.' || echo "$(RED)Auth check failed$(NC)"
	@echo ""
	@echo "$(YELLOW)Connected Banks:$(NC)"
	@curl -s http://192.168.1.11:4010/v1/requisitions 2>/dev/null | jq '[.results[] | select(.status == "LN")] | length' | xargs -I {} echo "  {} active connection(s)" || echo "  No data"
	@echo ""
	@echo "$(YELLOW)Linked Accounts:$(NC)"
	@curl -s http://192.168.1.11:4010/v1/accounts 2>/dev/null | jq '.accounts | map(.id) | unique | length' | xargs -I {} echo "  {} unique account(s)" || echo "  No data"

accounts: ## Show all linked bank accounts with details
	@echo "$(GREEN)💳 Your Bank Accounts$(NC)"
	@echo "====================="
	@curl -s http://192.168.1.11:4010/v1/accounts 2>/dev/null | \
		jq -r '.accounts | group_by(.id) | map(.[0]) | .[] | "Account ID: \(.id)\nIBAN: \(.iban)\nCurrency: \(.currency)\nStatus: \(.status)\n"' || \
		echo "$(RED)No accounts found$(NC)"

banks: ## Show your connected banks
	@echo "$(GREEN)🏦 Your Connected Banks$(NC)"
	@echo "======================="
	@curl -s http://192.168.1.11:4010/v1/requisitions 2>/dev/null | \
		jq -r '[.results[] | select(.status == "LN")] | .[] | "Bank: \(.institutionId)\nLinked: \(.created | split("T")[0])\nAccounts: \(.accounts | length)\nRequisition: \(.id)\n"' || \
		echo "$(RED)No banks connected$(NC)"

dashboard: ## Interactive dashboard for bank sync monitoring
	@./scripts/bank-dashboard.sh

balance: ## Get balance for first account
	@echo "$(GREEN)💰 Account Balance$(NC)"
	@echo "=================="
	@ACCOUNT=$$(curl -s http://192.168.1.11:4010/v1/requisitions 2>/dev/null | jq -r '[.results[] | select(.status == "LN")] | .[0].accounts[0]'); \
	if [ "$$ACCOUNT" != "null" ] && [ -n "$$ACCOUNT" ]; then \
		echo "Account: $$ACCOUNT"; \
		curl -s "http://192.168.1.11:4010/v1/accounts/$$ACCOUNT/balance" | jq '.'; \
	else \
		echo "$(RED)No linked accounts found$(NC)"; \
	fi

sync-balances: ## Sync all account balances
	@echo "$(YELLOW)🔄 Syncing account balances...$(NC)"
	@curl -s -X POST http://192.168.1.11:4010/v1/sync/balances | jq '.'

scheduler-status: ## Check scheduler and rate limit status
	@echo "$(CYAN)⏰ Scheduler Status$(NC)"
	@echo "=================="
	@curl -s http://192.168.1.11:4010/v1/scheduler/status | jq '.'

rate-limits: ## Check GoCardless rate limits
	@echo "$(CYAN)🚦 Rate Limit Status$(NC)"
	@echo "===================="
	@curl -s http://192.168.1.11:4010/v1/sync/limits | jq '.'

# GoCardless flow commands
gc-flow: ## Interactive GoCardless flow menu
	@./scripts/gc-flow.sh

gc-auth: ## Generate GoCardless auth token
	@echo "$(GREEN)Generating auth token...$(NC)"
	@curl -s -X POST http://192.168.1.11:4010/v1/auth/token | jq .

gc-banks: ## List available banks
	@echo "$(GREEN)Fetching banks for Spain...$(NC)"
	@curl -s http://192.168.1.11:4010/v1/institutions?country=ES | jq -r '.institutions[] | "\(.id) - \(.name)"' | head -20

gc-requisition: ## Create a new requisition
	@echo "$(GREEN)Creating requisition for BBVA...$(NC)"
	@curl -s -X POST http://192.168.1.11:4010/v1/requisitions \
		-H "Content-Type: application/json" \
		-d '{"institutionId": "BBVA_BBVAESMM"}' | jq .

gc-accounts: ## List connected accounts
	@echo "$(GREEN)Fetching connected accounts...$(NC)"
	@curl -s http://192.168.1.11:4010/v1/accounts | jq .

gc-sync: ## Sync transactions (requires ACCOUNT_ID env var)
	@if [ -z "$$ACCOUNT_ID" ]; then \
		echo "$(RED)Error: ACCOUNT_ID environment variable not set$(NC)"; \
		exit 1; \
	fi
	@echo "$(GREEN)Starting sync for account $$ACCOUNT_ID...$(NC)"
	@curl -s -X POST http://192.168.1.11:4010/v1/sync/$$ACCOUNT_ID | jq .

# === NOTIFICATIONS ===
test-notifications: ## Test notification system (requires COMM_SERVICE_* env vars)
	@if [ -z "$$COMM_SERVICE_URL" ] || [ -z "$$COMM_SERVICE_TOKEN" ]; then \
		echo "$(YELLOW)Warning: COMM_SERVICE_URL and COMM_SERVICE_TOKEN not set - notifications disabled$(NC)"; \
	else \
		echo "$(GREEN)Notifications configured: $$COMM_SERVICE_URL$(NC)"; \
	fi
	@echo "$(GREEN)Testing balance sync with notifications...$(NC)"
	@make sync-balances