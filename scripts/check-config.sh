#!/bin/bash

# Check GoCardless configuration on NAS

NAS_HOST="k2600x@192.168.1.11"
NAS_PATH="/volume1/docker/bank-sync-service"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo "========================================="
echo -e "${GREEN}GoCardless Configuration Check${NC}"
echo "========================================="
echo ""

# Step 1: Check if .env exists
echo -e "${YELLOW}1. Checking .env file on NAS...${NC}"
env_exists=$(ssh $NAS_HOST "test -f $NAS_PATH/.env && echo 'yes' || echo 'no'")

if [ "$env_exists" = "yes" ]; then
    echo -e "${GREEN}✓ .env file exists${NC}"
else
    echo -e "${RED}✗ .env file not found${NC}"
    echo ""
    echo "Creating .env from template..."
    ssh $NAS_HOST "cd $NAS_PATH && sudo cp .env.example .env"
fi

echo ""

# Step 2: Check current credentials (masked)
echo -e "${YELLOW}2. Checking current configuration...${NC}"
secret_id=$(ssh $NAS_HOST "grep '^GC_SECRET_ID=' $NAS_PATH/.env 2>/dev/null | cut -d'=' -f2")
secret_key=$(ssh $NAS_HOST "grep '^GC_SECRET_KEY=' $NAS_PATH/.env 2>/dev/null | cut -d'=' -f2")

if [ -z "$secret_id" ]; then
    echo -e "${RED}✗ GC_SECRET_ID not found in .env${NC}"
else
    if [[ "$secret_id" == *"YOUR_"* ]] || [[ "$secret_id" == *"REPLACE"* ]] || [ ${#secret_id} -lt 10 ]; then
        echo -e "${YELLOW}⚠ GC_SECRET_ID is still a placeholder: $secret_id${NC}"
    else
        masked="${secret_id:0:8}...${secret_id: -4}"
        echo -e "${GREEN}✓ GC_SECRET_ID is set: $masked${NC}"
    fi
fi

if [ -z "$secret_key" ]; then
    echo -e "${RED}✗ GC_SECRET_KEY not found in .env${NC}"
else
    if [[ "$secret_key" == *"YOUR_"* ]] || [[ "$secret_key" == *"REPLACE"* ]] || [ ${#secret_key} -lt 10 ]; then
        echo -e "${YELLOW}⚠ GC_SECRET_KEY is still a placeholder${NC}"
    else
        echo -e "${GREEN}✓ GC_SECRET_KEY is set (hidden)${NC}"
    fi
fi

echo ""

# Step 3: Check service status
echo -e "${YELLOW}3. Checking service status...${NC}"
container_status=$(ssh $NAS_HOST "sudo /usr/local/bin/docker ps --filter name=bank-sync-service --format '{{.Status}}' | head -1")

if [ -n "$container_status" ]; then
    echo -e "${GREEN}✓ Container is running: $container_status${NC}"
else
    echo -e "${RED}✗ Container is not running${NC}"
fi

echo ""

# Step 4: Test API connection
echo -e "${YELLOW}4. Testing API endpoint...${NC}"
health_response=$(curl -s http://192.168.1.11:4010/health 2>/dev/null)

if echo "$health_response" | grep -q '"ok":true'; then
    echo -e "${GREEN}✓ API is responding${NC}"
else
    echo -e "${RED}✗ API is not responding${NC}"
fi

echo ""
echo "========================================="
echo -e "${BLUE}How to Add Your GoCardless Credentials:${NC}"
echo "========================================="
echo ""
echo "1. Get your credentials from GoCardless:"
echo "   - Log in to: https://bankaccountdata.gocardless.com/"
echo "   - Go to: Developers → User Secrets"
echo "   - Create new secrets and download them"
echo ""
echo "2. SSH into your NAS:"
echo -e "   ${YELLOW}ssh $NAS_HOST${NC}"
echo ""
echo "3. Edit the .env file:"
echo -e "   ${YELLOW}cd $NAS_PATH${NC}"
echo -e "   ${YELLOW}sudo nano .env${NC}"
echo ""
echo "4. Replace these lines with your actual credentials:"
echo -e "   ${GREEN}GC_SECRET_ID=your-secret-id-here${NC}"
echo -e "   ${GREEN}GC_SECRET_KEY=your-secret-key-here${NC}"
echo ""
echo "5. Save and exit (Ctrl+X, Y, Enter)"
echo ""
echo "6. Restart the service:"
echo -e "   ${YELLOW}sudo /usr/local/bin/docker-compose restart${NC}"
echo ""
echo "7. Test the connection:"
echo -e "   ${YELLOW}exit  # back to your dev machine${NC}"
echo -e "   ${YELLOW}./scripts/test-gc-auth.sh${NC}"
echo ""
echo "========================================="

# Optional: Offer to open nano directly
echo ""
read -p "Would you like to edit the .env file now? (y/n): " edit_now

if [ "$edit_now" = "y" ]; then
    echo ""
    echo -e "${YELLOW}Opening .env file on NAS...${NC}"
    echo -e "${BLUE}Remember to:${NC}"
    echo "  1. Replace GC_SECRET_ID with your actual secret ID"
    echo "  2. Replace GC_SECRET_KEY with your actual secret key"
    echo "  3. Save with Ctrl+X, then Y, then Enter"
    echo ""
    echo "Press Enter to continue..."
    read
    
    ssh -t $NAS_HOST "cd $NAS_PATH && sudo nano .env"
    
    echo ""
    echo -e "${YELLOW}Restarting service...${NC}"
    ssh $NAS_HOST "cd $NAS_PATH && sudo /usr/local/bin/docker-compose restart"
    
    echo ""
    echo -e "${GREEN}Service restarted!${NC}"
    echo ""
    echo "Now run: ./scripts/test-gc-auth.sh"
fi