#!/bin/bash

# Direct GoCardless credential validation script

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

NAS_HOST="k2600x@192.168.1.11"
NAS_PATH="/volume1/docker/bank-sync-service"

clear
echo "========================================="
echo -e "${CYAN}GoCardless Credential Validator${NC}"
echo "========================================="
echo ""

# Get current credentials from NAS
echo -e "${YELLOW}Retrieving credentials from NAS...${NC}"
secret_id=$(ssh $NAS_HOST "grep '^GC_SECRET_ID=' $NAS_PATH/.env 2>/dev/null | cut -d'=' -f2" 2>/dev/null)
secret_key=$(ssh $NAS_HOST "grep '^GC_SECRET_KEY=' $NAS_PATH/.env 2>/dev/null | cut -d'=' -f2" 2>/dev/null)

if [ -z "$secret_id" ] || [ -z "$secret_key" ]; then
    echo -e "${RED}✗ Could not retrieve credentials from .env${NC}"
    exit 1
fi

# Show masked credentials
echo -e "Secret ID: ${CYAN}${secret_id:0:8}...${secret_id: -4}${NC}"
echo -e "Length: ${#secret_id} characters"
echo ""

# Test directly against GoCardless API
echo -e "${YELLOW}Testing credentials directly with GoCardless API...${NC}"
echo ""

# Try production endpoint
echo -e "${BLUE}1. Testing Production API${NC}"
PROD_RESPONSE=$(curl -s -X POST \
    https://bankaccountdata.gocardless.com/api/v2/token/new/ \
    -H "Content-Type: application/json" \
    -d "{\"secret_id\":\"$secret_id\",\"secret_key\":\"$secret_key\"}" \
    2>/dev/null)

if echo "$PROD_RESPONSE" | grep -q '"access"'; then
    echo -e "${GREEN}✓ SUCCESS! Credentials are valid for PRODUCTION${NC}"
    echo ""
    access_token=$(echo "$PROD_RESPONSE" | grep -o '"access":"[^"]*"' | cut -d'"' -f4)
    refresh_token=$(echo "$PROD_RESPONSE" | grep -o '"refresh":"[^"]*"' | cut -d'"' -f4)
    expires=$(echo "$PROD_RESPONSE" | grep -o '"access_expires":[0-9]*' | cut -d':' -f2)
    
    echo "Token details:"
    echo -e "  Access token: ${GREEN}${access_token:0:20}...${NC}"
    echo -e "  Expires in: ${GREEN}$expires${NC} seconds"
    echo ""
    
    # Test the token
    echo -e "${YELLOW}Testing token validity...${NC}"
    INST_RESPONSE=$(curl -s \
        https://bankaccountdata.gocardless.com/api/v2/institutions/?country=es \
        -H "Authorization: Bearer $access_token" \
        2>/dev/null)
    
    if echo "$INST_RESPONSE" | grep -q '"id"'; then
        inst_count=$(echo "$INST_RESPONSE" | grep -o '"id"' | wc -l)
        echo -e "${GREEN}✓ Token works! Retrieved $inst_count institutions${NC}"
    else
        echo -e "${RED}✗ Token validation failed${NC}"
    fi
    
elif echo "$PROD_RESPONSE" | grep -q 'Authentication failed'; then
    echo -e "${RED}✗ Production API rejected credentials${NC}"
    echo "Response: $PROD_RESPONSE"
    echo ""
    
    # Try sandbox endpoint
    echo -e "${BLUE}2. Testing Sandbox API${NC}"
    SANDBOX_RESPONSE=$(curl -s -X POST \
        https://ob.nordigen.com/api/v2/token/new/ \
        -H "Content-Type: application/json" \
        -d "{\"secret_id\":\"$secret_id\",\"secret_key\":\"$secret_key\"}" \
        2>/dev/null)
    
    if echo "$SANDBOX_RESPONSE" | grep -q '"access"'; then
        echo -e "${YELLOW}⚠ Credentials work for SANDBOX (not production)${NC}"
        echo ""
        echo "Your credentials are for the sandbox environment."
        echo "You need to:"
        echo "1. Log in to https://bankaccountdata.gocardless.com/"
        echo "2. Create PRODUCTION credentials"
        echo ""
    else
        echo -e "${RED}✗ Sandbox API also rejected credentials${NC}"
    fi
else
    echo -e "${RED}✗ Unexpected response from GoCardless${NC}"
    echo "Response: $PROD_RESPONSE"
fi

echo ""
echo "========================================="
echo -e "${BLUE}Credential Troubleshooting Guide${NC}"
echo "========================================="
echo ""

if ! echo "$PROD_RESPONSE" | grep -q '"access"'; then
    echo -e "${YELLOW}Your credentials are not working. Common issues:${NC}"
    echo ""
    echo "1. ${CYAN}Wrong environment:${NC}"
    echo "   - Production: https://bankaccountdata.gocardless.com/"
    echo "   - Sandbox: https://ob.nordigen.com/"
    echo "   Make sure you're using PRODUCTION credentials"
    echo ""
    echo "2. ${CYAN}Credentials not activated:${NC}"
    echo "   - New accounts may need email verification"
    echo "   - Check your email for activation links"
    echo ""
    echo "3. ${CYAN}Expired or revoked credentials:${NC}"
    echo "   - Credentials can be revoked from the dashboard"
    echo "   - Create new ones if needed"
    echo ""
    echo "4. ${CYAN}Copy/paste errors:${NC}"
    echo "   - Make sure no extra spaces or line breaks"
    echo "   - The secret_key is usually very long (100+ chars)"
    echo ""
    echo "========================================="
    echo -e "${BLUE}How to Get New Credentials${NC}"
    echo "========================================="
    echo ""
    echo "1. Go to: ${CYAN}https://bankaccountdata.gocardless.com/${NC}"
    echo "2. Log in with your account"
    echo "3. Navigate to: ${YELLOW}Developers → User Secrets${NC}"
    echo "4. Click: ${GREEN}+ New Secret${NC}"
    echo "5. Download or copy the credentials"
    echo "6. Run: ${CYAN}./scripts/setup-credentials.sh${NC}"
    echo ""
    
    # Offer to help update credentials
    echo "========================================="
    read -p "Would you like to enter new credentials now? (y/n): " update_now
    
    if [ "$update_now" = "y" ]; then
        echo ""
        echo -e "${YELLOW}Enter your new GoCardless credentials:${NC}"
        echo "(Get them from https://bankaccountdata.gocardless.com/)"
        echo ""
        
        read -p "Secret ID: " new_secret_id
        read -s -p "Secret Key: " new_secret_key
        echo ""
        echo ""
        
        # Validate input
        if [ ${#new_secret_id} -lt 10 ] || [ ${#new_secret_key} -lt 50 ]; then
            echo -e "${RED}Error: Credentials appear too short${NC}"
            echo "Secret ID should be ~36 chars (UUID format)"
            echo "Secret Key should be 100+ chars"
            exit 1
        fi
        
        # Test new credentials first
        echo -e "${YELLOW}Testing new credentials...${NC}"
        TEST_RESPONSE=$(curl -s -X POST \
            https://bankaccountdata.gocardless.com/api/v2/token/new/ \
            -H "Content-Type: application/json" \
            -d "{\"secret_id\":\"$new_secret_id\",\"secret_key\":\"$new_secret_key\"}" \
            2>/dev/null)
        
        if echo "$TEST_RESPONSE" | grep -q '"access"'; then
            echo -e "${GREEN}✓ New credentials are valid!${NC}"
            echo ""
            
            # Update .env file
            echo -e "${YELLOW}Updating configuration...${NC}"
            ssh $NAS_HOST "cd $NAS_PATH && \
                sudo cp .env .env.backup && \
                sudo sed -i 's/^GC_SECRET_ID=.*/GC_SECRET_ID=$new_secret_id/' .env && \
                sudo sed -i 's/^GC_SECRET_KEY=.*/GC_SECRET_KEY=$new_secret_key/' .env" 2>/dev/null
            
            echo -e "${GREEN}✓ Configuration updated${NC}"
            echo ""
            
            # Restart service
            echo -e "${YELLOW}Restarting service...${NC}"
            ssh $NAS_HOST "cd $NAS_PATH && sudo /usr/local/bin/docker-compose restart" 2>/dev/null
            
            echo -e "${GREEN}✓ Service restarted${NC}"
            echo ""
            echo "Now run: ${CYAN}./scripts/gc-flow.sh${NC} to connect your bank"
            
        else
            echo -e "${RED}✗ New credentials also failed${NC}"
            echo "Response: $TEST_RESPONSE"
            echo ""
            echo "Please verify you're using PRODUCTION credentials from:"
            echo "https://bankaccountdata.gocardless.com/"
        fi
    fi
else
    echo -e "${GREEN}Your credentials are working correctly!${NC}"
    echo ""
    echo "The service should now be able to authenticate."
    echo "Run ${CYAN}./scripts/gc-flow.sh${NC} to connect your bank account."
fi