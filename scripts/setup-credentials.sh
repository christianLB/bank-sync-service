#!/bin/bash

# Interactive GoCardless credential setup for NAS deployment

NAS_HOST="k2600x@192.168.1.11"
NAS_PATH="/volume1/docker/bank-sync-service"
API_URL="http://192.168.1.11:4010"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

clear
echo "========================================="
echo -e "${CYAN}GoCardless Credential Setup Wizard${NC}"
echo "========================================="
echo ""

# Step 1: Check current status
echo -e "${YELLOW}Step 1: Checking current configuration...${NC}"
echo ""

# Check if .env exists
env_exists=$(ssh $NAS_HOST "test -f $NAS_PATH/.env && echo 'yes' || echo 'no'" 2>/dev/null)

if [ "$env_exists" != "yes" ]; then
    echo -e "${YELLOW}Creating .env from template...${NC}"
    ssh $NAS_HOST "cd $NAS_PATH && sudo cp .env.example .env" 2>/dev/null
    echo -e "${GREEN}✓ .env file created${NC}"
else
    echo -e "${GREEN}✓ .env file exists${NC}"
fi

# Check current credentials
secret_id=$(ssh $NAS_HOST "grep '^GC_SECRET_ID=' $NAS_PATH/.env 2>/dev/null | cut -d'=' -f2" 2>/dev/null)
secret_key=$(ssh $NAS_HOST "grep '^GC_SECRET_KEY=' $NAS_PATH/.env 2>/dev/null | cut -d'=' -f2" 2>/dev/null)

needs_setup=false

if [ -z "$secret_id" ] || [[ "$secret_id" == *"YOUR_"* ]] || [ ${#secret_id} -lt 10 ]; then
    echo -e "${RED}✗ GC_SECRET_ID needs to be configured${NC}"
    needs_setup=true
else
    masked="${secret_id:0:8}...${secret_id: -4}"
    echo -e "${GREEN}✓ GC_SECRET_ID is configured: $masked${NC}"
fi

if [ -z "$secret_key" ] || [[ "$secret_key" == *"YOUR_"* ]] || [ ${#secret_key} -lt 10 ]; then
    echo -e "${RED}✗ GC_SECRET_KEY needs to be configured${NC}"
    needs_setup=true
else
    echo -e "${GREEN}✓ GC_SECRET_KEY is configured (hidden)${NC}"
fi

echo ""

# Step 2: Get credentials if needed
if [ "$needs_setup" = true ]; then
    echo "========================================="
    echo -e "${BLUE}Getting Your GoCardless Credentials${NC}"
    echo "========================================="
    echo ""
    echo "1. Open your browser and go to:"
    echo -e "   ${CYAN}https://bankaccountdata.gocardless.com/${NC}"
    echo ""
    echo "2. Log in with your GoCardless account"
    echo ""
    echo "3. Navigate to:"
    echo -e "   ${YELLOW}Developers → User Secrets${NC}"
    echo ""
    echo "4. Create new secrets if you don't have them"
    echo ""
    echo "5. Copy your Secret ID and Secret Key"
    echo ""
    
    read -p "Press Enter when you have your credentials ready..."
    echo ""
    
    # Prompt for credentials
    echo -e "${YELLOW}Enter your GoCardless credentials:${NC}"
    echo ""
    
    read -p "Secret ID: " new_secret_id
    read -s -p "Secret Key: " new_secret_key
    echo ""
    echo ""
    
    # Validate input
    if [ ${#new_secret_id} -lt 10 ] || [ ${#new_secret_key} -lt 10 ]; then
        echo -e "${RED}Error: Credentials appear to be too short${NC}"
        echo "Please ensure you've copied the complete values"
        exit 1
    fi
    
    # Update .env file
    echo -e "${YELLOW}Updating configuration...${NC}"
    
    # Create temporary file with updated credentials
    ssh $NAS_HOST "cd $NAS_PATH && sudo cp .env .env.backup" 2>/dev/null
    
    # Update credentials using sed
    ssh $NAS_HOST "cd $NAS_PATH && \
        sudo sed -i 's/^GC_SECRET_ID=.*/GC_SECRET_ID=$new_secret_id/' .env && \
        sudo sed -i 's/^GC_SECRET_KEY=.*/GC_SECRET_KEY=$new_secret_key/' .env" 2>/dev/null
    
    echo -e "${GREEN}✓ Credentials updated${NC}"
    echo ""
    
    # Restart service
    echo -e "${YELLOW}Restarting service...${NC}"
    ssh $NAS_HOST "cd $NAS_PATH && sudo /usr/local/bin/docker-compose restart" 2>/dev/null
    
    echo -e "${GREEN}✓ Service restarted${NC}"
    echo ""
    
    # Wait for service to be ready
    echo -e "${YELLOW}Waiting for service to be ready...${NC}"
    sleep 5
fi

# Step 3: Test authentication
echo "========================================="
echo -e "${CYAN}Testing GoCardless Authentication${NC}"
echo "========================================="
echo ""

echo -e "${YELLOW}Generating access token...${NC}"
response=$(curl -s -X POST "$API_URL/v1/auth/token" 2>/dev/null)

if echo "$response" | grep -q '"access"'; then
    echo -e "${GREEN}✓ Authentication successful!${NC}"
    echo ""
    
    # Extract token details
    access_len=$(echo "$response" | grep -o '"access":"[^"]*"' | cut -d'"' -f4 | wc -c)
    refresh_len=$(echo "$response" | grep -o '"refresh":"[^"]*"' | cut -d'"' -f4 | wc -c)
    
    echo "Token details:"
    echo -e "  Access token length: ${GREEN}$access_len${NC} characters"
    echo -e "  Refresh token length: ${GREEN}$refresh_len${NC} characters"
    echo ""
    
    # Test auth status
    echo -e "${YELLOW}Checking authentication status...${NC}"
    status_response=$(curl -s "$API_URL/v1/auth/status" 2>/dev/null)
    
    if echo "$status_response" | grep -q '"authenticated":true'; then
        echo -e "${GREEN}✓ Token is valid and stored${NC}"
        echo ""
    fi
    
    # Test institution list
    echo -e "${YELLOW}Testing institution endpoint...${NC}"
    inst_response=$(curl -s "$API_URL/v1/institutions?country=ES" 2>/dev/null)
    
    if echo "$inst_response" | grep -q '"institutions"'; then
        inst_count=$(echo "$inst_response" | grep -o '"id"' | wc -l)
        echo -e "${GREEN}✓ Successfully retrieved $inst_count Spanish institutions${NC}"
        echo ""
    fi
    
    echo "========================================="
    echo -e "${GREEN}SUCCESS! GoCardless integration is ready${NC}"
    echo "========================================="
    echo ""
    echo "Next steps:"
    echo ""
    echo "1. Link a bank account:"
    echo -e "   ${CYAN}./scripts/gc-flow.sh${NC}"
    echo ""
    echo "2. Check sync status:"
    echo -e "   ${CYAN}./scripts/check-sync.sh${NC}"
    echo ""
    echo "3. View service logs:"
    echo -e "   ${CYAN}ssh $NAS_HOST \"sudo /usr/local/bin/docker logs -f bank-sync-service\"${NC}"
    echo ""
    
else
    echo -e "${RED}✗ Authentication failed${NC}"
    echo ""
    echo "Response: $response"
    echo ""
    echo "Please check:"
    echo "1. Your credentials are correct"
    echo "2. The service is running"
    echo "3. Network connectivity to GoCardless API"
    echo ""
    echo "View logs with:"
    echo -e "${YELLOW}ssh $NAS_HOST \"sudo /usr/local/bin/docker logs --tail 50 bank-sync-service\"${NC}"
    exit 1
fi