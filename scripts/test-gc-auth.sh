#!/bin/bash

# Quick test script to verify GoCardless credentials are working

API_BASE="http://192.168.1.11:4010/v1"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo "========================================="
echo "GoCardless Authentication Test"
echo "========================================="
echo ""

# Step 1: Check current auth status
echo -e "${YELLOW}1. Checking current auth status...${NC}"
response=$(curl -s "${API_BASE}/auth/status")
echo "$response" | jq .
echo ""

# Step 2: Generate token
echo -e "${YELLOW}2. Attempting to generate token...${NC}"
response=$(curl -s -X POST "${API_BASE}/auth/token")

if echo "$response" | jq -e '.error' > /dev/null 2>&1; then
    echo -e "${RED}✗ Authentication failed${NC}"
    echo "$response" | jq .
    echo ""
    echo -e "${YELLOW}Please check:${NC}"
    echo "  1. Your GC_SECRET_ID and GC_SECRET_KEY are set in .env on NAS"
    echo "  2. The credentials are correct (from GoCardless dashboard)"
    echo "  3. The service has been restarted after adding credentials:"
    echo "     ssh k2600x@192.168.1.11 'cd /volume1/docker/bank-sync-service && sudo /usr/local/bin/docker-compose restart'"
    exit 1
else
    echo -e "${GREEN}✓ Token generated successfully!${NC}"
    echo "$response" | jq .
fi

echo ""

# Step 3: Verify token is valid
echo -e "${YELLOW}3. Verifying token validity...${NC}"
response=$(curl -s "${API_BASE}/auth/status")
has_token=$(echo "$response" | jq -r '.hasValidToken')

if [ "$has_token" = "true" ]; then
    echo -e "${GREEN}✓ Valid token confirmed${NC}"
else
    echo -e "${RED}✗ Token validation failed${NC}"
fi

echo ""

# Step 4: Test fetching institutions
echo -e "${YELLOW}4. Testing API access - fetching Spanish banks...${NC}"
response=$(curl -s "${API_BASE}/institutions?country=ES")

if echo "$response" | jq -e '.institutions' > /dev/null 2>&1; then
    count=$(echo "$response" | jq '.count')
    echo -e "${GREEN}✓ Successfully fetched $count institutions${NC}"
    echo ""
    echo "First 5 banks:"
    echo "$response" | jq -r '.institutions[0:5][] | "  - \(.id): \(.name)"'
else
    echo -e "${RED}✗ Failed to fetch institutions${NC}"
    echo "$response" | jq .
fi

echo ""
echo "========================================="
echo -e "${GREEN}Test Complete!${NC}"
echo ""
echo "If all tests passed, you can now:"
echo "  1. Run 'make gc-flow' for interactive bank linking"
echo "  2. Or use individual commands:"
echo "     make gc-banks     - List banks"
echo "     make gc-requisition - Create bank link"
echo "     make gc-accounts   - List connected accounts"
echo "========================================="