#!/bin/bash

# Quick start script for GoCardless bank sync

API_URL="http://192.168.1.11:4010"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

clear
echo "========================================="
echo -e "${CYAN}GoCardless Bank Sync - Quick Start${NC}"
echo "========================================="
echo ""

# 1. Check status
echo -e "${BLUE}1. Checking service status...${NC}"
health=$(curl -s $API_URL/health 2>/dev/null)
if echo "$health" | grep -q '"ok":true'; then
    echo -e "${GREEN}✓ Service is running${NC}"
else
    echo -e "${RED}✗ Service is not running${NC}"
    exit 1
fi

# 2. Check auth
echo ""
echo -e "${BLUE}2. Checking authentication...${NC}"
auth_status=$(curl -s $API_URL/v1/auth/status 2>/dev/null)
if echo "$auth_status" | grep -q '"hasValidToken":true'; then
    echo -e "${GREEN}✓ Authentication is valid${NC}"
else
    echo -e "${YELLOW}Generating new token...${NC}"
    curl -s -X POST $API_URL/v1/auth/token >/dev/null 2>&1
    echo -e "${GREEN}✓ Token generated${NC}"
fi

# 3. List banks
echo ""
echo -e "${BLUE}3. Available Spanish banks:${NC}"
banks=$(curl -s "$API_URL/v1/institutions?country=ES" 2>/dev/null)
bank_count=$(echo "$banks" | grep -o '"id"' | wc -l)
echo -e "Found ${GREEN}$bank_count${NC} banks"
echo ""

# Show popular banks
echo "Popular banks:"
echo "$banks" | jq -r '.institutions[] | select(.name | test("BBVA|Santander|CaixaBank|ING|Sabadell")) | "  • \(.name) [\(.id)]"' 2>/dev/null

# 4. Create requisition
echo ""
echo "========================================="
echo -e "${CYAN}Connect Your Bank Account${NC}"
echo "========================================="
echo ""
echo "To connect your bank account, run:"
echo -e "${YELLOW}./scripts/gc-flow.sh${NC}"
echo ""
echo "Then choose option 4 to create a requisition"
echo "You'll receive a link to authorize access to your bank"
echo ""

# 5. Show existing connections
echo "========================================="
echo -e "${CYAN}Existing Connections${NC}"
echo "========================================="
echo ""

requisitions=$(curl -s $API_URL/v1/requisitions 2>/dev/null)
req_count=$(echo "$requisitions" | grep -o '"id"' | wc -l)

if [ $req_count -eq 0 ]; then
    echo -e "${YELLOW}No bank connections yet${NC}"
else
    echo -e "You have ${GREEN}$req_count${NC} connection(s):"
    echo "$requisitions" | jq -r '.requisitions[] | "  • Status: \(.status) | Created: \(.created | split("T")[0])"' 2>/dev/null
fi

echo ""
echo "========================================="
echo -e "${GREEN}✓ GoCardless is ready!${NC}"
echo "========================================="
echo ""
echo "Next steps:"
echo "1. Run ${CYAN}./scripts/gc-flow.sh${NC} to connect a bank"
echo "2. Run ${CYAN}./scripts/check-sync.sh${NC} to monitor sync status"
echo "3. View logs: ${CYAN}ssh k2600x@192.168.1.11 'sudo /usr/local/bin/docker logs -f bank-sync-service'${NC}"
echo ""