# GoCardless Bank Account Data Setup Guide

## Prerequisites

1. **GoCardless Account**: Sign up at https://bankaccountdata.gocardless.com/
2. **User Secrets**: Create secrets in the GoCardless dashboard:
   - Go to **Developers → User Secrets**
   - Click **+ Create New**
   - Download and save the `secret_id` and `secret_key`

## Configuration

### 1. Add Credentials to Production

SSH into your NAS and update the `.env` file:

```bash
ssh k2600x@192.168.1.11
cd /volume1/docker/bank-sync-service
sudo nano .env
```

Update these values:
```env
GC_SECRET_ID=your_actual_secret_id_here
GC_SECRET_KEY=your_actual_secret_key_here
GC_COUNTRY_CODE=ES  # or your country code
```

Restart the service:
```bash
sudo /usr/local/bin/docker-compose restart
```

### 2. Verify Authentication

From your dev machine, test the credentials:

```bash
cd ~/dev/bank-sync-service
./scripts/test-gc-auth.sh
```

If successful, you'll see:
- ✓ Token generated successfully
- ✓ Valid token confirmed
- ✓ Successfully fetched institutions

## Bank Account Linking Flow

### Option 1: Interactive Flow (Recommended)

Use the interactive menu for guided setup:

```bash
make gc-flow
```

This provides a menu with all options:
- Generate auth token
- List available banks
- Create requisition (bank link)
- Check link status
- List connected accounts
- Sync transactions

### Option 2: Manual Commands

#### Step 1: Generate Auth Token
```bash
make gc-auth
```

#### Step 2: List Available Banks
```bash
make gc-banks

# For other countries:
curl -s http://192.168.1.11:4010/v1/institutions?country=DE | jq .
```

Popular Spanish banks:
- `BBVA_BBVAESMM` - BBVA
- `CAIXABANK_CAIXESBB` - CaixaBank  
- `SANTANDER_BSCHESMM` - Santander
- `ING_INGDESMMXXX` - ING
- `SABADELL_BSABESBB` - Sabadell

#### Step 3: Create Requisition
```bash
# Using Makefile (BBVA example)
make gc-requisition

# Or with custom bank:
curl -X POST http://192.168.1.11:4010/v1/requisitions \
  -H "Content-Type: application/json" \
  -d '{"institutionId": "SANTANDER_BSCHESMM"}'
```

Response includes:
- `id`: Requisition ID (save this!)
- `link`: Authorization URL (open in browser)

#### Step 4: Complete Authorization
1. Open the `link` URL in your browser
2. Select your bank
3. Log in with your bank credentials
4. Authorize access to account data
5. You'll be redirected back after completion

#### Step 5: Check Requisition Status
```bash
# Replace REQ_ID with your requisition ID
curl http://192.168.1.11:4010/v1/requisitions/REQ_ID | jq .
```

Status codes:
- `CR` - Created, waiting for user
- `LN` - Linked successfully ✓
- `RJ` - Rejected by user
- `EX` - Expired (create new one)

#### Step 6: List Connected Accounts
```bash
make gc-accounts
```

Save the account ID for syncing!

## Syncing Transactions

### Sync All Transactions
```bash
# Set account ID
export ACCOUNT_ID=your_account_id_here

# Run sync
make gc-sync
```

### Sync with Date Range
```bash
curl -X POST http://192.168.1.11:4010/v1/sync/ACCOUNT_ID \
  -H "Content-Type: application/json" \
  -d '{
    "fromDate": "2024-01-01",
    "toDate": "2024-03-20"
  }'
```

### Check Sync Status
```bash
# Replace OP_ID with operation ID from sync response
curl http://192.168.1.11:4010/v1/operations/OP_ID | jq .
```

## Monitoring

### View Logs
```bash
make deploy-logs
```

### Check Redis for Events
```bash
# Connect to Redis on NAS
ssh k2600x@192.168.1.11
cd /volume1/docker/bank-sync-service
sudo /usr/local/bin/docker exec -it bank-sync-redis redis-cli

# View transaction events
XREAD COUNT 10 STREAMS bank.tx.created 0

# View sync events
XREAD COUNT 10 STREAMS bank.sync.completed 0
```

## Troubleshooting

### Authentication Errors

If you get authentication errors:

1. **Verify credentials are set**:
   ```bash
   ssh k2600x@192.168.1.11
   cd /volume1/docker/bank-sync-service
   sudo cat .env | grep GC_SECRET
   ```

2. **Check service logs**:
   ```bash
   sudo /usr/local/bin/docker-compose logs --tail=50 bank-sync-service
   ```

3. **Restart service**:
   ```bash
   sudo /usr/local/bin/docker-compose restart
   ```

### Requisition Issues

- **Expired requisition**: Create a new one
- **No accounts returned**: User may not have completed authorization
- **403 errors**: Check if agreement has expired (90 days default)

### Rate Limiting

GoCardless imposes rate limits:
- Banks may limit to 4 API calls/day per account
- Each endpoint (details, balances, transactions) has separate limits
- If hit, wait 24 hours or contact support

## API Endpoints Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/auth/token` | POST | Generate access token |
| `/v1/auth/status` | GET | Check token validity |
| `/v1/institutions` | GET | List banks by country |
| `/v1/requisitions` | POST | Create bank link |
| `/v1/requisitions/{id}` | GET | Check link status |
| `/v1/accounts` | GET | List connected accounts |
| `/v1/sync/{accountId}` | POST | Sync transactions |
| `/v1/operations/{id}` | GET | Check sync status |

## Data Flow

```
1. Generate Token (secret_id + secret_key)
   ↓
2. Create Requisition (select bank)
   ↓
3. User Authorization (bank login)
   ↓
4. Accounts Linked (get account IDs)
   ↓
5. Sync Transactions (pull data)
   ↓
6. Events Emitted (Redis Streams)
   ↓
7. Finance Service Consumes
```

## Security Notes

- Never commit credentials to git
- Tokens expire after 24 hours (auto-refresh)
- Requisitions expire after 90 days
- Use HTTPS in production
- Monitor failed auth attempts in logs

## Support

- GoCardless Docs: https://developer.gocardless.com/bank-account-data/
- API Status: https://www.gocardless-status.com/
- Support: support@gocardless.com