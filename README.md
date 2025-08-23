# Bank Sync Service

Bank synchronization service with GoCardless integration for fetching and normalizing banking transactions.

## Features

- ✅ **GoCardless Integration**: Connect to bank accounts via GoCardless API
- ✅ **Idempotent Sync**: Deduplication and cursor-based incremental sync
- ✅ **Event Streaming**: Redis Streams for real-time event publishing
- ✅ **Persistent State**: Redis AOF with optional database checkpoints
- ✅ **Webhook Support**: Secure webhook handling with signature verification
- ✅ **Lock Management**: Distributed locks to prevent concurrent syncs
- ✅ **Health Monitoring**: Health and readiness endpoints

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│  GoCardless │────▶│  Bank Sync   │────▶│    Redis    │
│     API     │     │   Service    │     │   Streams   │
└─────────────┘     └──────────────┘     └─────────────┘
                            │                     │
                            ▼                     ▼
                    ┌──────────────┐     ┌─────────────┐
                    │   Webhooks   │     │   Finance   │
                    │   Endpoint   │     │   Service   │
                    └──────────────┘     └─────────────┘
```

## Quick Start

### Local Development

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Configure environment:**
   ```bash
   cp .env.example .env
   # Edit .env with your GoCardless credentials
   ```

3. **Start development server:**
   ```bash
   npm run dev
   # or with Docker
   make test-local
   ```

### Production Deployment (NAS)

1. **One-command deployment:**
   ```bash
   ./deploy.sh
   # or
   make deploy-nas
   ```

2. **Configure on NAS:**
   ```bash
   ssh k2600x@192.168.1.11
   cd /volume1/docker/bank-sync-service
   nano .env  # Add GoCardless credentials
   docker-compose restart
   ```

## API Endpoints

### Health & Status
- `GET /health` - Service health check
- `GET /ready` - Readiness check (Redis connection)

### Accounts
- `GET /v1/accounts` - List all bank accounts
- `GET /v1/accounts/:accountId` - Get account details

### Synchronization
- `POST /v1/sync/:accountId` - Start sync for account
- `GET /v1/operations/:operationId` - Check sync operation status

### Webhooks
- `POST /v1/webhook/gocardless` - GoCardless webhook endpoint

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `NODE_ENV` | Environment (development/production) | development |
| `PORT` | Service port | 3000 |
| `LOG_LEVEL` | Log level (debug/info/warn/error) | info |
| `REDIS_URL` | Redis connection URL | redis://localhost:6379 |
| `GC_ACCESS_TOKEN` | GoCardless access token | Required |
| `GC_WEBHOOK_SECRET` | Webhook signature secret | Required |
| `SYNC_LOOKBACK_DAYS` | Default sync lookback period | 90 |
| `MAX_TRANSACTIONS_PER_SYNC` | Max transactions per sync | 1000 |

### Redis Configuration

The service uses Redis with AOF persistence enabled:
- **AOF**: Append-only file for durability
- **Persistence**: Every second fsync
- **Memory**: 512MB max with LRU eviction

## Events

The service publishes events to Redis Streams:

### Transaction Created
```json
{
  "eventType": "bank.tx.created",
  "data": {
    "txId": "uuid",
    "externalRef": "provider-ref",
    "accountId": "account-123",
    "amount": 100.50,
    "direction": "in",
    "bookedAt": "2024-01-01T10:00:00Z"
  }
}
```

### Sync Completed
```json
{
  "eventType": "bank.sync.completed",
  "data": {
    "operationId": "uuid",
    "accountId": "account-123",
    "transactionCount": 42
  }
}
```

## Development

### Project Structure
```
bank-sync-service/
├── src/
│   ├── routes/          # API endpoints
│   ├── lib/            # Core libraries
│   ├── workers/        # Background workers
│   └── index.ts        # Application entry
├── contracts/          # OpenAPI/AsyncAPI specs
├── docker-compose.yml  # Docker services
└── deploy.sh          # Deployment script
```

### Testing
```bash
# Run tests
npm test

# Test sync endpoint
ACCOUNT_ID=your-account-id make test-sync

# Test accounts listing
make test-accounts
```

### Monitoring
```bash
# View logs
make deploy-logs

# Check status
make deploy-status

# Connect to Redis
make redis-cli
```

## Deployment Commands

```bash
# Deploy to NAS
make deploy-nas

# Quick update (no full rebuild)
make deploy-update

# Check deployment status
make deploy-status

# View logs from NAS
make deploy-logs

# Restart services
make deploy-restart

# Stop services
make deploy-stop
```

## Troubleshooting

### Sync Not Progressing
- Check for stuck locks: `redis-cli keys "gc:sync:lock:*"`
- Force release: `redis-cli del gc:sync:lock:ACCOUNT_ID`

### Duplicate Transactions
- Verify `externalRef` stability
- Check dedupe keys: `redis-cli keys "gc:tx:dedupe:*"`

### Webhook Issues
- Verify signature secret in `.env`
- Check webhook replay prevention keys
- Review logs for signature validation errors

### Redis Connection
- Ensure Redis is running: `docker-compose ps`
- Check Redis logs: `docker-compose logs redis`
- Verify AOF is enabled: `redis-cli config get appendonly`

## Security

- ✅ Webhook signature verification
- ✅ Anti-replay protection (72h window)
- ✅ Environment-based configuration
- ✅ Docker network isolation
- ✅ Distroless production image

## License

Private - Internal Use Only