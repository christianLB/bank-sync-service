#!/bin/bash

# GoCardless Flow Helper Script
# Interact with bank-sync-service on NAS

set -e

# Configuration
API_BASE="http://192.168.1.11:4010/v1"
COUNTRY_CODE="${GC_COUNTRY:-ES}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Helper functions
log_info() {
    echo -e "${BLUE}ℹ${NC} $1"
}

log_success() {
    echo -e "${GREEN}✓${NC} $1"
}

log_error() {
    echo -e "${RED}✗${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

# Check if jq is installed
if ! command -v jq &> /dev/null; then
    log_error "jq is required but not installed. Install it with: sudo apt-get install jq"
    exit 1
fi

# Main menu
show_menu() {
    echo ""
    echo -e "${GREEN}=== GoCardless Bank Sync Flow ===${NC}"
    echo ""
    echo "1) Check auth status"
    echo "2) Generate/refresh token"
    echo "3) List available banks"
    echo "4) Create requisition (link bank)"
    echo "5) Check requisition status"
    echo "6) List all requisitions"
    echo "7) List connected accounts"
    echo "8) Sync account transactions"
    echo "9) Check sync operation status"
    echo "10) Test full flow (guided)"
    echo ""
    echo "0) Exit"
    echo ""
    read -p "Select option: " choice
}

# 1. Check auth status
check_auth() {
    log_info "Checking authentication status..."
    
    response=$(curl -s "${API_BASE}/auth/status")
    
    if echo "$response" | jq -e '.hasValidToken' > /dev/null 2>&1; then
        has_token=$(echo "$response" | jq -r '.hasValidToken')
        if [ "$has_token" = "true" ]; then
            log_success "Valid token exists"
        else
            log_warning "No valid token. Run option 2 to generate one."
        fi
    else
        log_error "Failed to check auth status"
        echo "$response" | jq .
    fi
}

# 2. Generate token
generate_token() {
    log_info "Generating access token..."
    
    response=$(curl -s -X POST "${API_BASE}/auth/token")
    
    if echo "$response" | jq -e '.status' > /dev/null 2>&1; then
        status=$(echo "$response" | jq -r '.status')
        if [ "$status" = "success" ]; then
            log_success "Token generated successfully"
        else
            log_error "Failed to generate token"
            echo "$response" | jq .
        fi
    else
        log_error "Error generating token:"
        echo "$response" | jq .
    fi
}

# 3. List banks
list_banks() {
    read -p "Enter country code (default: $COUNTRY_CODE): " country
    country=${country:-$COUNTRY_CODE}
    
    log_info "Fetching banks for country: $country..."
    
    response=$(curl -s "${API_BASE}/institutions?country=${country}")
    
    if echo "$response" | jq -e '.institutions' > /dev/null 2>&1; then
        count=$(echo "$response" | jq '.count')
        log_success "Found $count institutions"
        echo ""
        echo "$response" | jq -r '.institutions[] | "\(.id) - \(.name)"' | head -20
        
        if [ "$count" -gt 20 ]; then
            echo ""
            log_info "Showing first 20 of $count institutions"
        fi
    else
        log_error "Failed to fetch institutions"
        echo "$response" | jq .
    fi
}

# 4. Create requisition
create_requisition() {
    log_info "Create a new requisition to link a bank account"
    echo ""
    
    # List some popular Spanish banks
    echo "Popular Spanish banks:"
    echo "  BBVA_BBVAESMM - BBVA"
    echo "  CAIXABANK_CAIXESBB - CaixaBank"
    echo "  SANTANDER_BSCHESMM - Santander"
    echo "  ING_INGDESMMXXX - ING"
    echo "  SABADELL_BSABESBB - Sabadell"
    echo ""
    
    read -p "Enter institution ID (or press enter to list all): " institution_id
    
    if [ -z "$institution_id" ]; then
        list_banks
        echo ""
        read -p "Enter institution ID: " institution_id
    fi
    
    if [ -z "$institution_id" ]; then
        log_error "Institution ID is required"
        return
    fi
    
    read -p "Enter reference (optional, press enter to skip): " reference
    read -p "Max historical days (default: 90): " max_days
    read -p "Access valid for days (default: 90): " valid_days
    
    # Build JSON payload
    json_payload="{\"institutionId\": \"$institution_id\""
    [ -n "$reference" ] && json_payload="${json_payload}, \"reference\": \"$reference\""
    [ -n "$max_days" ] && json_payload="${json_payload}, \"maxHistoricalDays\": $max_days"
    [ -n "$valid_days" ] && json_payload="${json_payload}, \"accessValidForDays\": $valid_days"
    json_payload="${json_payload}}"
    
    log_info "Creating requisition..."
    
    response=$(curl -s -X POST "${API_BASE}/requisitions" \
        -H "Content-Type: application/json" \
        -d "$json_payload")
    
    if echo "$response" | jq -e '.id' > /dev/null 2>&1; then
        req_id=$(echo "$response" | jq -r '.id')
        link=$(echo "$response" | jq -r '.link')
        
        log_success "Requisition created!"
        echo ""
        echo -e "${GREEN}Requisition ID:${NC} $req_id"
        echo ""
        echo -e "${YELLOW}IMPORTANT: Open this link in your browser to authorize:${NC}"
        echo -e "${BLUE}$link${NC}"
        echo ""
        echo "After authorization, run option 5 with ID: $req_id"
        
        # Save to file for convenience
        echo "$req_id" > .last_requisition_id
    else
        log_error "Failed to create requisition"
        echo "$response" | jq .
    fi
}

# 5. Check requisition status
check_requisition() {
    # Try to use last requisition ID if available
    if [ -f .last_requisition_id ]; then
        last_id=$(cat .last_requisition_id)
        read -p "Enter requisition ID (last: $last_id): " req_id
        req_id=${req_id:-$last_id}
    else
        read -p "Enter requisition ID: " req_id
    fi
    
    if [ -z "$req_id" ]; then
        log_error "Requisition ID is required"
        return
    fi
    
    log_info "Checking requisition status..."
    
    response=$(curl -s "${API_BASE}/requisitions/${req_id}")
    
    if echo "$response" | jq -e '.id' > /dev/null 2>&1; then
        status=$(echo "$response" | jq -r '.status')
        status_desc=$(echo "$response" | jq -r '.statusDescription')
        accounts=$(echo "$response" | jq -r '.accounts | length')
        
        echo ""
        echo -e "${GREEN}Requisition Details:${NC}"
        echo "  ID: $req_id"
        echo "  Status: $status - $status_desc"
        echo "  Accounts linked: $accounts"
        
        if [ "$status" = "LN" ] && [ "$accounts" -gt 0 ]; then
            log_success "Bank account(s) successfully linked!"
            echo ""
            echo "Account IDs:"
            echo "$response" | jq -r '.accounts[]' | while read -r acc_id; do
                echo "  - $acc_id"
                echo "$acc_id" > .last_account_id
            done
        elif [ "$status" = "CR" ]; then
            log_warning "Waiting for user authorization..."
            echo "Please open the link in your browser to complete authorization"
        elif [ "$status" = "EX" ]; then
            log_error "Requisition has expired. Create a new one."
        elif [ "$status" = "RJ" ]; then
            log_error "Authorization was rejected by user"
        fi
    else
        log_error "Failed to get requisition"
        echo "$response" | jq .
    fi
}

# 6. List all requisitions
list_requisitions() {
    log_info "Fetching all requisitions..."
    
    response=$(curl -s "${API_BASE}/requisitions")
    
    if echo "$response" | jq -e '.results' > /dev/null 2>&1; then
        count=$(echo "$response" | jq '.count')
        log_success "Found $count requisitions"
        echo ""
        
        echo "$response" | jq -r '.results[] | "ID: \(.id)\n  Status: \(.status)\n  Institution: \(.institutionId)\n  Created: \(.created)\n  Accounts: \(.accounts | length)\n"'
    else
        log_error "Failed to list requisitions"
        echo "$response" | jq .
    fi
}

# 7. List accounts
list_accounts() {
    log_info "Fetching connected accounts..."
    
    response=$(curl -s "${API_BASE}/accounts")
    
    if echo "$response" | jq -e '.accounts' > /dev/null 2>&1; then
        count=$(echo "$response" | jq '.accounts | length')
        
        if [ "$count" -eq 0 ]; then
            log_warning "No accounts connected yet"
            echo "Use option 4 to create a requisition and link a bank account"
        else
            log_success "Found $count account(s)"
            echo ""
            echo "$response" | jq -r '.accounts[] | "ID: \(.id)\n  Name: \(.name)\n  IBAN: \(.iban)\n  Currency: \(.currency)\n  Balance: \(.balance)\n  Status: \(.status)\n  Last Sync: \(.lastSyncAt // "Never")\n"'
        fi
    else
        log_error "Failed to fetch accounts"
        echo "$response" | jq .
    fi
}

# 8. Sync transactions
sync_transactions() {
    # Try to use last account ID if available
    if [ -f .last_account_id ]; then
        last_id=$(cat .last_account_id)
        read -p "Enter account ID (last: $last_id): " account_id
        account_id=${account_id:-$last_id}
    else
        read -p "Enter account ID: " account_id
    fi
    
    if [ -z "$account_id" ]; then
        log_error "Account ID is required"
        return
    fi
    
    read -p "From date (YYYY-MM-DD, optional): " from_date
    read -p "To date (YYYY-MM-DD, optional): " to_date
    
    # Build JSON payload
    json_payload="{}"
    [ -n "$from_date" ] && json_payload="{\"fromDate\": \"$from_date\"}"
    [ -n "$to_date" ] && json_payload=$(echo "$json_payload" | jq ". + {\"toDate\": \"$to_date\"}")
    
    log_info "Starting sync for account: $account_id..."
    
    response=$(curl -s -X POST "${API_BASE}/sync/${account_id}" \
        -H "Content-Type: application/json" \
        -d "$json_payload")
    
    if echo "$response" | jq -e '.operationId' > /dev/null 2>&1; then
        op_id=$(echo "$response" | jq -r '.operationId')
        log_success "Sync started!"
        echo "Operation ID: $op_id"
        echo "$op_id" > .last_operation_id
        echo ""
        echo "Use option 9 to check sync status"
    else
        log_error "Failed to start sync"
        echo "$response" | jq .
    fi
}

# 9. Check operation status
check_operation() {
    # Try to use last operation ID if available
    if [ -f .last_operation_id ]; then
        last_id=$(cat .last_operation_id)
        read -p "Enter operation ID (last: $last_id): " op_id
        op_id=${op_id:-$last_id}
    else
        read -p "Enter operation ID: " op_id
    fi
    
    if [ -z "$op_id" ]; then
        log_error "Operation ID is required"
        return
    fi
    
    log_info "Checking operation status..."
    
    response=$(curl -s "${API_BASE}/operations/${op_id}")
    
    if echo "$response" | jq -e '.operationId' > /dev/null 2>&1; then
        status=$(echo "$response" | jq -r '.status')
        processed=$(echo "$response" | jq -r '.processed')
        
        echo ""
        echo -e "${GREEN}Operation Details:${NC}"
        echo "$response" | jq .
        
        if [ "$status" = "completed" ]; then
            log_success "Sync completed! Processed $processed transactions"
        elif [ "$status" = "in_progress" ]; then
            log_info "Sync in progress... Processed $processed transactions so far"
        elif [ "$status" = "failed" ]; then
            log_error "Sync failed!"
        fi
    else
        log_error "Operation not found"
        echo "$response" | jq .
    fi
}

# 10. Full flow test
test_full_flow() {
    echo ""
    echo -e "${GREEN}=== Guided GoCardless Setup ===${NC}"
    echo ""
    echo "This will guide you through the complete flow:"
    echo "1. Generate auth token"
    echo "2. Create requisition"
    echo "3. Link bank account"
    echo "4. Sync transactions"
    echo ""
    read -p "Continue? (y/n): " confirm
    
    if [ "$confirm" != "y" ]; then
        return
    fi
    
    # Step 1: Generate token
    echo ""
    log_info "Step 1: Generating authentication token..."
    generate_token
    sleep 2
    
    # Step 2: List banks
    echo ""
    log_info "Step 2: Listing available banks..."
    list_banks
    
    # Step 3: Create requisition
    echo ""
    log_info "Step 3: Creating requisition..."
    create_requisition
    
    # Wait for user to complete auth
    echo ""
    log_warning "Please complete the authorization in your browser"
    read -p "Press enter after completing authorization..."
    
    # Step 4: Check requisition
    echo ""
    log_info "Step 4: Checking requisition status..."
    check_requisition
    
    # Step 5: List accounts
    echo ""
    log_info "Step 5: Listing connected accounts..."
    list_accounts
    
    # Step 6: Sync
    echo ""
    read -p "Would you like to sync transactions now? (y/n): " sync_now
    if [ "$sync_now" = "y" ]; then
        sync_transactions
    fi
    
    echo ""
    log_success "Setup complete!"
}

# Main loop
while true; do
    show_menu
    
    case $choice in
        1) check_auth ;;
        2) generate_token ;;
        3) list_banks ;;
        4) create_requisition ;;
        5) check_requisition ;;
        6) list_requisitions ;;
        7) list_accounts ;;
        8) sync_transactions ;;
        9) check_operation ;;
        10) test_full_flow ;;
        0) 
            log_info "Goodbye!"
            exit 0
            ;;
        *)
            log_error "Invalid option"
            ;;
    esac
    
    echo ""
    read -p "Press enter to continue..."
done