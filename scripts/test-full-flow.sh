#!/bin/bash

# Automated test script for complete GoCardless flow after credentials setup

API_URL="http://192.168.1.11:4010"
REDIRECT_URL="http://localhost:4010/v1/requisitions/callback"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# Test results
TESTS_PASSED=0
TESTS_FAILED=0

# Test function
run_test() {
    local test_name=$1
    local test_cmd=$2
    local expected_pattern=$3
    
    echo -ne "${YELLOW}Testing: ${NC}$test_name... "
    
    result=$(eval "$test_cmd" 2>/dev/null)
    
    if echo "$result" | grep -q "$expected_pattern"; then
        echo -e "${GREEN}✓ PASSED${NC}"
        ((TESTS_PASSED++))
        return 0
    else
        echo -e "${RED}✗ FAILED${NC}"
        echo -e "  Expected pattern: $expected_pattern"
        echo -e "  Got: ${result:0:100}..."
        ((TESTS_FAILED++))
        return 1
    fi
}

clear
echo "========================================="
echo -e "${CYAN}GoCardless Integration Test Suite${NC}"
echo "========================================="
echo ""

# 1. Health Check
echo -e "${BLUE}1. Service Health Checks${NC}"
echo "-----------------------------------------"
run_test "API Health" \
    "curl -s $API_URL/health" \
    '"ok":true'

run_test "Redis Connection" \
    "curl -s $API_URL/ready" \
    '"redis":"connected"'

echo ""

# 2. Authentication Tests
echo -e "${BLUE}2. Authentication Tests${NC}"
echo "-----------------------------------------"

# Generate token
echo -ne "${YELLOW}Testing: ${NC}Token Generation... "
TOKEN_RESPONSE=$(curl -s -X POST "$API_URL/v1/auth/token" 2>/dev/null)

if echo "$TOKEN_RESPONSE" | grep -q '"access"'; then
    echo -e "${GREEN}✓ PASSED${NC}"
    ((TESTS_PASSED++))
    
    # Extract tokens for later use
    ACCESS_TOKEN=$(echo "$TOKEN_RESPONSE" | grep -o '"access":"[^"]*"' | cut -d'"' -f4)
    REFRESH_TOKEN=$(echo "$TOKEN_RESPONSE" | grep -o '"refresh":"[^"]*"' | cut -d'"' -f4)
    
    # Show token info
    echo -e "  Access token: ${GREEN}${ACCESS_TOKEN:0:20}...${NC}"
    echo -e "  Token length: ${GREEN}${#ACCESS_TOKEN}${NC} characters"
else
    echo -e "${RED}✗ FAILED${NC}"
    echo "  Response: $TOKEN_RESPONSE"
    ((TESTS_FAILED++))
    echo ""
    echo -e "${RED}Cannot continue without authentication${NC}"
    exit 1
fi

run_test "Auth Status" \
    "curl -s $API_URL/v1/auth/status" \
    '"authenticated":true'

echo ""

# 3. Institution Tests
echo -e "${BLUE}3. Institution API Tests${NC}"
echo "-----------------------------------------"

# Test different countries
for country in ES GB DE FR; do
    run_test "Institutions for $country" \
        "curl -s '$API_URL/v1/institutions?country=$country'" \
        '"institutions":\['
done

# Get Spanish institutions for further testing
INST_RESPONSE=$(curl -s "$API_URL/v1/institutions?country=ES" 2>/dev/null)
INST_COUNT=$(echo "$INST_RESPONSE" | grep -o '"id"' | wc -l)
echo -e "  Found ${GREEN}$INST_COUNT${NC} Spanish institutions"

# Extract first institution ID
INST_ID=$(echo "$INST_RESPONSE" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
if [ -n "$INST_ID" ]; then
    echo -e "  Sample institution: ${GREEN}$INST_ID${NC}"
fi

echo ""

# 4. Agreement Tests
echo -e "${BLUE}4. End User Agreement Tests${NC}"
echo "-----------------------------------------"

if [ -n "$INST_ID" ]; then
    # Create agreement
    echo -ne "${YELLOW}Testing: ${NC}Agreement Creation... "
    AGREEMENT_RESPONSE=$(curl -s -X POST "$API_URL/v1/agreements" \
        -H "Content-Type: application/json" \
        -d "{\"institutionId\":\"$INST_ID\",\"maxHistoricalDays\":90,\"accessValidForDays\":90,\"accessScope\":[\"balances\",\"details\",\"transactions\"]}" 2>/dev/null)
    
    if echo "$AGREEMENT_RESPONSE" | grep -q '"id"'; then
        echo -e "${GREEN}✓ PASSED${NC}"
        ((TESTS_PASSED++))
        
        AGREEMENT_ID=$(echo "$AGREEMENT_RESPONSE" | grep -o '"id":"[^"]*"' | cut -d'"' -f4)
        echo -e "  Agreement ID: ${GREEN}$AGREEMENT_ID${NC}"
    else
        echo -e "${RED}✗ FAILED${NC}"
        echo "  Response: $AGREEMENT_RESPONSE"
        ((TESTS_FAILED++))
    fi
    
    # List agreements
    run_test "List Agreements" \
        "curl -s '$API_URL/v1/agreements'" \
        '"agreements":\['
fi

echo ""

# 5. Requisition Tests
echo -e "${BLUE}5. Requisition Flow Tests${NC}"
echo "-----------------------------------------"

if [ -n "$INST_ID" ]; then
    # Create requisition
    echo -ne "${YELLOW}Testing: ${NC}Requisition Creation... "
    REQ_RESPONSE=$(curl -s -X POST "$API_URL/v1/requisitions" \
        -H "Content-Type: application/json" \
        -d "{\"institutionId\":\"$INST_ID\",\"redirectUrl\":\"$REDIRECT_URL\"}" 2>/dev/null)
    
    if echo "$REQ_RESPONSE" | grep -q '"id"'; then
        echo -e "${GREEN}✓ PASSED${NC}"
        ((TESTS_PASSED++))
        
        REQ_ID=$(echo "$REQ_RESPONSE" | grep -o '"id":"[^"]*"' | cut -d'"' -f4)
        REQ_LINK=$(echo "$REQ_RESPONSE" | grep -o '"link":"[^"]*"' | cut -d'"' -f4)
        
        echo -e "  Requisition ID: ${GREEN}$REQ_ID${NC}"
        echo -e "  Auth link: ${CYAN}${REQ_LINK:0:50}...${NC}"
    else
        echo -e "${RED}✗ FAILED${NC}"
        echo "  Response: $REQ_RESPONSE"
        ((TESTS_FAILED++))
    fi
    
    # Get requisition status
    if [ -n "$REQ_ID" ]; then
        run_test "Get Requisition Status" \
            "curl -s '$API_URL/v1/requisitions/$REQ_ID'" \
            '"status":"'
    fi
    
    # List requisitions
    run_test "List Requisitions" \
        "curl -s '$API_URL/v1/requisitions'" \
        '"requisitions":\['
fi

echo ""

# 6. Account Tests (will fail without completed requisition)
echo -e "${BLUE}6. Account API Tests${NC}"
echo "-----------------------------------------"

run_test "List Accounts (expect empty)" \
    "curl -s '$API_URL/v1/accounts'" \
    '\['

echo ""

# 7. Sync Tests
echo -e "${BLUE}7. Synchronization Tests${NC}"
echo "-----------------------------------------"

run_test "Sync Status" \
    "curl -s '$API_URL/v1/sync/status'" \
    '"accounts":\['

echo ""

# Summary
echo "========================================="
echo -e "${CYAN}Test Results Summary${NC}"
echo "========================================="
echo ""
echo -e "Tests Passed: ${GREEN}$TESTS_PASSED${NC}"
echo -e "Tests Failed: ${RED}$TESTS_FAILED${NC}"
echo ""

if [ $TESTS_FAILED -eq 0 ]; then
    echo -e "${GREEN}✓ All tests passed successfully!${NC}"
    echo ""
    echo "The GoCardless integration is fully operational."
    echo ""
    echo "To complete bank account linking:"
    echo "1. Run: ./scripts/gc-flow.sh"
    echo "2. Choose option 1 to start the complete flow"
    echo "3. Follow the authorization link to connect your bank"
    echo ""
else
    echo -e "${YELLOW}⚠ Some tests failed${NC}"
    echo ""
    echo "Please review the failures above and:"
    echo "1. Check service logs: ssh k2600x@192.168.1.11 'sudo /usr/local/bin/docker logs --tail 50 bank-sync-service'"
    echo "2. Verify credentials are correct"
    echo "3. Ensure network connectivity to GoCardless API"
    echo ""
fi

# Optional: Show next steps if requisition was created
if [ -n "$REQ_LINK" ]; then
    echo "========================================="
    echo -e "${BLUE}Bank Authorization Link${NC}"
    echo "========================================="
    echo ""
    echo "A test requisition was created. To connect a bank account:"
    echo ""
    echo -e "${CYAN}$REQ_LINK${NC}"
    echo ""
    echo "This link will expire in 5 minutes."
    echo ""
fi