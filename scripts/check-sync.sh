#!/bin/bash

# Monitor synchronization status and recent transactions

API_URL="http://192.168.1.11:4010"
NAS_HOST="k2600x@192.168.1.11"
NAS_PATH="/volume1/docker/bank-sync-service"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
NC='\033[0m'

# Function to format currency
format_currency() {
    echo "$1" | sed 's/\([0-9]\)\([0-9]\{3\}\)$/\1,\2/' | sed 's/^/-€/'
}

# Function to format date
format_date() {
    echo "$1" | cut -d'T' -f1
}

clear
echo "========================================="
echo -e "${CYAN}Bank Sync Status Monitor${NC}"
echo "========================================="
echo ""

# 1. Service Status
echo -e "${BLUE}1. Service Status${NC}"
echo "-----------------------------------------"

# Check container status
container_status=$(ssh $NAS_HOST "sudo /usr/local/bin/docker ps --filter name=bank-sync-service --format '{{.Status}}' | head -1" 2>/dev/null)
if [ -n "$container_status" ]; then
    echo -e "${GREEN}✓ Container: Running${NC} ($container_status)"
else
    echo -e "${RED}✗ Container: Not running${NC}"
fi

# Check API health
health_response=$(curl -s $API_URL/health 2>/dev/null)
if echo "$health_response" | grep -q '"ok":true'; then
    echo -e "${GREEN}✓ API: Healthy${NC}"
else
    echo -e "${RED}✗ API: Not responding${NC}"
fi

# Check Redis
ready_response=$(curl -s $API_URL/ready 2>/dev/null)
if echo "$ready_response" | grep -q '"redis":"connected"'; then
    echo -e "${GREEN}✓ Redis: Connected${NC}"
else
    echo -e "${RED}✗ Redis: Disconnected${NC}"
fi

echo ""

# 2. Authentication Status
echo -e "${BLUE}2. Authentication Status${NC}"
echo "-----------------------------------------"

auth_status=$(curl -s $API_URL/v1/auth/status 2>/dev/null)
if echo "$auth_status" | grep -q '"authenticated":true'; then
    echo -e "${GREEN}✓ GoCardless: Authenticated${NC}"
    
    # Extract token expiry if available
    if echo "$auth_status" | grep -q '"expiresAt"'; then
        expires=$(echo "$auth_status" | grep -o '"expiresAt":"[^"]*"' | cut -d'"' -f4)
        echo -e "  Token expires: ${YELLOW}$expires${NC}"
    fi
else
    echo -e "${RED}✗ GoCardless: Not authenticated${NC}"
    echo "  Run: ./scripts/setup-credentials.sh"
fi

echo ""

# 3. Requisition Status
echo -e "${BLUE}3. Bank Connections${NC}"
echo "-----------------------------------------"

requisitions_response=$(curl -s $API_URL/v1/requisitions 2>/dev/null)

if echo "$requisitions_response" | grep -q '"requisitions":\['; then
    # Count requisitions
    req_count=$(echo "$requisitions_response" | grep -o '"id"' | wc -l)
    
    if [ $req_count -eq 0 ]; then
        echo -e "${YELLOW}No bank connections found${NC}"
        echo "  Run: ./scripts/gc-flow.sh to connect a bank"
    else
        echo -e "Found ${GREEN}$req_count${NC} bank connection(s):"
        echo ""
        
        # Parse each requisition
        echo "$requisitions_response" | grep -o '"id":"[^"]*"' | while read -r line; do
            req_id=$(echo "$line" | cut -d'"' -f4)
            
            # Get requisition details
            req_detail=$(curl -s "$API_URL/v1/requisitions/$req_id" 2>/dev/null)
            
            status=$(echo "$req_detail" | grep -o '"status":"[^"]*"' | cut -d'"' -f4)
            created=$(echo "$req_detail" | grep -o '"created":"[^"]*"' | cut -d'"' -f4 | cut -d'T' -f1)
            accounts=$(echo "$req_detail" | grep -o '"accounts":\[[^]]*\]' | grep -o '"[^"]*"' | grep -v "accounts" | wc -l)
            
            # Status color
            case "$status" in
                "LN") status_color="${GREEN}Linked${NC}" ;;
                "CR") status_color="${YELLOW}Created${NC}" ;;
                "GC") status_color="${YELLOW}Giving Consent${NC}" ;;
                "UA") status_color="${YELLOW}Undergoing Auth${NC}" ;;
                "RJ") status_color="${RED}Rejected${NC}" ;;
                "EX") status_color="${RED}Expired${NC}" ;;
                *) status_color="${YELLOW}$status${NC}" ;;
            esac
            
            echo -e "  • ID: ${CYAN}${req_id:0:8}...${NC}"
            echo -e "    Status: $status_color"
            echo -e "    Created: ${YELLOW}$created${NC}"
            echo -e "    Accounts: ${GREEN}$accounts${NC}"
            echo ""
        done
    fi
else
    echo -e "${RED}Failed to fetch requisitions${NC}"
fi

echo ""

# 4. Account Summary
echo -e "${BLUE}4. Account Summary${NC}"
echo "-----------------------------------------"

accounts_response=$(curl -s $API_URL/v1/accounts 2>/dev/null)

if echo "$accounts_response" | grep -q '\['; then
    account_count=$(echo "$accounts_response" | grep -o '"id"' | wc -l)
    
    if [ $account_count -eq 0 ]; then
        echo -e "${YELLOW}No accounts synchronized yet${NC}"
    else
        echo -e "Synchronized ${GREEN}$account_count${NC} account(s):"
        echo ""
        
        # Parse each account
        echo "$accounts_response" | jq -r '.[] | @json' 2>/dev/null | while IFS= read -r account; do
            id=$(echo "$account" | jq -r '.id' 2>/dev/null)
            name=$(echo "$account" | jq -r '.name // "Unknown"' 2>/dev/null)
            iban=$(echo "$account" | jq -r '.iban // ""' 2>/dev/null)
            currency=$(echo "$account" | jq -r '.currency // "EUR"' 2>/dev/null)
            
            echo -e "  • ${GREEN}$name${NC}"
            echo -e "    ID: ${CYAN}${id:0:8}...${NC}"
            if [ -n "$iban" ] && [ "$iban" != "null" ]; then
                masked_iban="${iban:0:4}...${iban: -4}"
                echo -e "    IBAN: ${YELLOW}$masked_iban${NC}"
            fi
            echo -e "    Currency: ${YELLOW}$currency${NC}"
            
            # Get balance
            balance_response=$(curl -s "$API_URL/v1/accounts/$id/balance" 2>/dev/null)
            if echo "$balance_response" | grep -q '"amount"'; then
                amount=$(echo "$balance_response" | jq -r '.balances[0].balanceAmount.amount // "0"' 2>/dev/null)
                echo -e "    Balance: ${MAGENTA}€$amount${NC}"
            fi
            echo ""
        done
    fi
else
    echo -e "${YELLOW}No accounts found${NC}"
fi

echo ""

# 5. Sync Status
echo -e "${BLUE}5. Synchronization Status${NC}"
echo "-----------------------------------------"

sync_status=$(curl -s $API_URL/v1/sync/status 2>/dev/null)

if echo "$sync_status" | grep -q '"accounts"'; then
    # Parse sync status
    last_sync=$(echo "$sync_status" | jq -r '.lastSync // "never"' 2>/dev/null)
    next_sync=$(echo "$sync_status" | jq -r '.nextSync // "not scheduled"' 2>/dev/null)
    
    if [ "$last_sync" != "never" ] && [ "$last_sync" != "null" ]; then
        echo -e "Last sync: ${GREEN}$(format_date "$last_sync")${NC}"
    else
        echo -e "Last sync: ${YELLOW}Never${NC}"
    fi
    
    if [ "$next_sync" != "not scheduled" ] && [ "$next_sync" != "null" ]; then
        echo -e "Next sync: ${CYAN}$(format_date "$next_sync")${NC}"
    else
        echo -e "Next sync: ${YELLOW}Not scheduled${NC}"
    fi
    
    # Account sync details
    account_details=$(echo "$sync_status" | jq -r '.accounts[]? | @json' 2>/dev/null)
    if [ -n "$account_details" ]; then
        echo ""
        echo "Account sync details:"
        echo "$account_details" | while IFS= read -r detail; do
            acc_id=$(echo "$detail" | jq -r '.accountId' 2>/dev/null)
            tx_count=$(echo "$detail" | jq -r '.transactionCount // 0' 2>/dev/null)
            last_tx=$(echo "$detail" | jq -r '.lastTransaction // "none"' 2>/dev/null)
            
            echo -e "  • Account ${CYAN}${acc_id:0:8}...${NC}"
            echo -e "    Transactions: ${GREEN}$tx_count${NC}"
            if [ "$last_tx" != "none" ] && [ "$last_tx" != "null" ]; then
                echo -e "    Last transaction: ${YELLOW}$(format_date "$last_tx")${NC}"
            fi
        done
    fi
else
    echo -e "${YELLOW}Sync status unavailable${NC}"
fi

echo ""

# 6. Recent Transactions (if any accounts exist)
if [ $account_count -gt 0 ] 2>/dev/null; then
    echo -e "${BLUE}6. Recent Transactions${NC}"
    echo "-----------------------------------------"
    
    # Get first account ID for demo
    first_account=$(echo "$accounts_response" | jq -r '.[0].id // ""' 2>/dev/null)
    
    if [ -n "$first_account" ] && [ "$first_account" != "null" ]; then
        tx_response=$(curl -s "$API_URL/v1/accounts/$first_account/transactions?limit=5" 2>/dev/null)
        
        if echo "$tx_response" | grep -q '"transactions"'; then
            tx_count=$(echo "$tx_response" | jq '.transactions | length' 2>/dev/null)
            
            if [ "$tx_count" -gt 0 ]; then
                echo "Latest 5 transactions:"
                echo ""
                
                echo "$tx_response" | jq -r '.transactions[] | @json' 2>/dev/null | while IFS= read -r tx; do
                    date=$(echo "$tx" | jq -r '.bookingDate // .valueDate' 2>/dev/null)
                    amount=$(echo "$tx" | jq -r '.transactionAmount.amount' 2>/dev/null)
                    currency=$(echo "$tx" | jq -r '.transactionAmount.currency' 2>/dev/null)
                    info=$(echo "$tx" | jq -r '.remittanceInformationUnstructured // .additionalInformation // "No description"' 2>/dev/null)
                    
                    # Color based on amount
                    if [ "${amount:0:1}" = "-" ]; then
                        amount_color="${RED}"
                    else
                        amount_color="${GREEN}"
                    fi
                    
                    echo -e "  ${YELLOW}$(format_date "$date")${NC}"
                    echo -e "    Amount: ${amount_color}$currency $amount${NC}"
                    echo -e "    Info: ${info:0:50}"
                    echo ""
                done
            else
                echo -e "${YELLOW}No transactions found${NC}"
            fi
        else
            echo -e "${YELLOW}No transactions available${NC}"
        fi
    fi
    echo ""
fi

# 7. Quick Actions
echo "========================================="
echo -e "${MAGENTA}Quick Actions${NC}"
echo "========================================="
echo ""
echo "1. Trigger manual sync:"
echo -e "   ${CYAN}curl -X POST $API_URL/v1/sync/trigger${NC}"
echo ""
echo "2. View service logs:"
echo -e "   ${CYAN}ssh $NAS_HOST 'sudo /usr/local/bin/docker logs -f bank-sync-service'${NC}"
echo ""
echo "3. Connect new bank:"
echo -e "   ${CYAN}./scripts/gc-flow.sh${NC}"
echo ""
echo "4. Refresh authentication:"
echo -e "   ${CYAN}curl -X POST $API_URL/v1/auth/refresh${NC}"
echo ""

# Auto-refresh option
echo "========================================="
read -p "Auto-refresh every 30 seconds? (y/n): " auto_refresh

if [ "$auto_refresh" = "y" ]; then
    while true; do
        sleep 30
        clear
        exec "$0"
    done
fi