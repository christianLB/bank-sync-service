#!/bin/bash

# Interactive Bank Sync Dashboard

API_URL="http://192.168.1.11:4010"
NAS_HOST="k2600x@192.168.1.11"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
WHITE='\033[1;37m'
NC='\033[0m'

# Box drawing characters
TL='┌'
TR='┐'
BL='└'
BR='┘'
H='─'
V='│'
T='┬'
B='┴'
L='├'
R='┤'
X='┼'

# Function to draw a box
draw_box() {
    local width=$1
    local title=$2
    local title_len=${#title}
    local padding=$(( (width - title_len - 2) / 2 ))
    
    # Top line with title
    echo -ne "${CYAN}${TL}"
    for ((i=0; i<padding; i++)); do echo -ne "${H}"; done
    echo -ne " ${WHITE}$title${CYAN} "
    for ((i=0; i<padding; i++)); do echo -ne "${H}"; done
    [ $(( (width - title_len - 2) % 2 )) -eq 1 ] && echo -ne "${H}"
    echo -e "${TR}${NC}"
}

close_box() {
    local width=$1
    echo -ne "${CYAN}${BL}"
    for ((i=0; i<width; i++)); do echo -ne "${H}"; done
    echo -e "${BR}${NC}"
}

# Clear screen and show header
show_header() {
    clear
    echo -e "${CYAN}╔════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║${WHITE}           BANK SYNC SERVICE - REAL-TIME DASHBOARD         ${CYAN}║${NC}"
    echo -e "${CYAN}╠════════════════════════════════════════════════════════════╣${NC}"
    echo -e "${CYAN}║${NC} $(date '+%Y-%m-%d %H:%M:%S')                                           ${CYAN}║${NC}"
    echo -e "${CYAN}╚════════════════════════════════════════════════════════════╝${NC}"
    echo ""
}

# Get data
fetch_data() {
    # Service health
    HEALTH=$(curl -s $API_URL/health 2>/dev/null)
    AUTH_STATUS=$(curl -s $API_URL/v1/auth/status 2>/dev/null)
    
    # Requisitions and accounts
    REQUISITIONS=$(curl -s $API_URL/v1/requisitions 2>/dev/null)
    ACCOUNTS=$(curl -s $API_URL/v1/accounts 2>/dev/null)
    
    # Parse data
    if [ -n "$REQUISITIONS" ] && echo "$REQUISITIONS" | jq -e '.results' >/dev/null 2>&1; then
        ACTIVE_REQS=$(echo "$REQUISITIONS" | jq '[.results[] | select(.status == "LN")] | length')
        TOTAL_REQS=$(echo "$REQUISITIONS" | jq '.count')
    else
        ACTIVE_REQS=0
        TOTAL_REQS=0
    fi
    
    if [ -n "$ACCOUNTS" ] && echo "$ACCOUNTS" | jq -e '.accounts' >/dev/null 2>&1; then
        UNIQUE_ACCOUNTS=$(echo "$ACCOUNTS" | jq '.accounts | map(.id) | unique | length')
    else
        UNIQUE_ACCOUNTS=0
    fi
}

show_dashboard() {
    show_header
    fetch_data
    
    # Row 1: Service Status
    draw_box 60 "SERVICE STATUS"
    
    # Health check
    if echo "$HEALTH" | grep -q '"ok":true' 2>/dev/null; then
        echo -e "${CYAN}${V}${NC} API Status:          ${GREEN}● ONLINE${NC}"
    else
        echo -e "${CYAN}${V}${NC} API Status:          ${RED}● OFFLINE${NC}"
    fi
    
    # Auth status
    if echo "$AUTH_STATUS" | grep -q '"hasValidToken":true' 2>/dev/null; then
        echo -e "${CYAN}${V}${NC} GoCardless Auth:     ${GREEN}● AUTHENTICATED${NC}"
    else
        echo -e "${CYAN}${V}${NC} GoCardless Auth:     ${YELLOW}● NOT AUTHENTICATED${NC}"
    fi
    
    # Container status
    CONTAINER_STATUS=$(ssh $NAS_HOST "sudo /usr/local/bin/docker ps --filter name=bank-sync-service --format '{{.Status}}' | head -1" 2>/dev/null)
    if [ -n "$CONTAINER_STATUS" ]; then
        echo -e "${CYAN}${V}${NC} Container:           ${GREEN}● RUNNING${NC} (${CONTAINER_STATUS})"
    else
        echo -e "${CYAN}${V}${NC} Container:           ${RED}● STOPPED${NC}"
    fi
    
    close_box 60
    echo ""
    
    # Row 2: Bank Connections
    draw_box 60 "BANK CONNECTIONS"
    echo -e "${CYAN}${V}${NC} Active Connections:  ${GREEN}$ACTIVE_REQS${NC} / $TOTAL_REQS total"
    echo -e "${CYAN}${V}${NC} Linked Accounts:     ${GREEN}$UNIQUE_ACCOUNTS${NC}"
    
    if [ "$ACTIVE_REQS" -gt 0 ] && [ -n "$REQUISITIONS" ]; then
        echo -e "${CYAN}${V}${NC}"
        echo -e "${CYAN}${V}${NC} ${YELLOW}Connected Banks:${NC}"
        echo "$REQUISITIONS" | jq -r '[.results[] | select(.status == "LN")] | .[:3] | .[] | "│ • \(.institutionId | split("_")[0]) - \(.accounts | length) account(s)"' 2>/dev/null | while read line; do
            echo -e "${CYAN}${line}${NC}"
        done
    fi
    close_box 60
    echo ""
    
    # Row 3: Account Details
    if [ "$UNIQUE_ACCOUNTS" -gt 0 ] && [ -n "$ACCOUNTS" ]; then
        draw_box 60 "ACCOUNT DETAILS"
        echo "$ACCOUNTS" | jq -r '.accounts | group_by(.id) | map(.[0]) | .[:3] | .[] | "│ • IBAN: \(.iban[0:4])...\(.iban[-4:]) (\(.currency)) - \(.status)"' 2>/dev/null | while read line; do
            echo -e "${CYAN}${line}${NC}"
        done
        close_box 60
        echo ""
    fi
    
    # Quick Actions Menu
    draw_box 60 "QUICK ACTIONS"
    echo -e "${CYAN}${V}${NC} [1] Connect New Bank    [4] View Logs"
    echo -e "${CYAN}${V}${NC} [2] Sync Accounts       [5] Restart Service"
    echo -e "${CYAN}${V}${NC} [3] Show Transactions   [6] Full Status Report"
    echo -e "${CYAN}${V}${NC}"
    echo -e "${CYAN}${V}${NC} [R] Refresh Dashboard   [Q] Quit"
    close_box 60
    echo ""
}

# Handle actions
handle_action() {
    case $1 in
        1)
            echo -e "${YELLOW}Starting bank connection flow...${NC}"
            ./scripts/gc-flow.sh
            read -p "Press Enter to continue..."
            ;;
        2)
            echo -e "${YELLOW}Syncing accounts...${NC}"
            if [ "$UNIQUE_ACCOUNTS" -gt 0 ]; then
                FIRST_ACCOUNT=$(echo "$ACCOUNTS" | jq -r '.accounts[0].id')
                curl -s -X POST "$API_URL/v1/sync/$FIRST_ACCOUNT" | jq '.'
            else
                echo -e "${RED}No accounts to sync${NC}"
            fi
            read -p "Press Enter to continue..."
            ;;
        3)
            echo -e "${YELLOW}Fetching transactions...${NC}"
            if [ "$UNIQUE_ACCOUNTS" -gt 0 ]; then
                FIRST_ACCOUNT=$(echo "$ACCOUNTS" | jq -r '.accounts[0].id')
                curl -s "$API_URL/v1/accounts/$FIRST_ACCOUNT/transactions?limit=10" 2>/dev/null | jq '.' || echo "No transactions endpoint available"
            else
                echo -e "${RED}No accounts available${NC}"
            fi
            read -p "Press Enter to continue..."
            ;;
        4)
            echo -e "${YELLOW}Showing recent logs...${NC}"
            ssh $NAS_HOST "sudo /usr/local/bin/docker logs --tail 30 bank-sync-service"
            read -p "Press Enter to continue..."
            ;;
        5)
            echo -e "${YELLOW}Restarting service...${NC}"
            ssh $NAS_HOST "cd /volume1/docker/bank-sync-service && sudo /usr/local/bin/docker-compose restart"
            echo -e "${GREEN}Service restarted${NC}"
            sleep 2
            ;;
        6)
            echo -e "${CYAN}=== FULL STATUS REPORT ===${NC}"
            echo ""
            echo -e "${YELLOW}Raw API Responses:${NC}"
            echo ""
            echo "Health:"
            echo "$HEALTH" | jq '.' 2>/dev/null || echo "N/A"
            echo ""
            echo "Auth Status:"
            echo "$AUTH_STATUS" | jq '.' 2>/dev/null || echo "N/A"
            echo ""
            echo "Requisitions (first 3):"
            echo "$REQUISITIONS" | jq '.results[:3]' 2>/dev/null || echo "N/A"
            echo ""
            echo "Accounts:"
            echo "$ACCOUNTS" | jq '.accounts | group_by(.id) | map(.[0])' 2>/dev/null || echo "N/A"
            echo ""
            read -p "Press Enter to continue..."
            ;;
        r|R)
            return 0
            ;;
        q|Q)
            echo -e "${GREEN}Goodbye!${NC}"
            exit 0
            ;;
        *)
            return 0
            ;;
    esac
}

# Main loop
main() {
    while true; do
        show_dashboard
        
        # Show auto-refresh timer
        echo -ne "${CYAN}Auto-refresh in: ${NC}"
        
        # Wait for input with timeout
        for i in {30..1}; do
            echo -ne "\r${CYAN}Auto-refresh in: ${YELLOW}${i}s${NC} | Enter action: "
            read -t 1 -n 1 action
            if [ $? -eq 0 ]; then
                echo ""
                handle_action "$action"
                break
            fi
        done
        
        # If no input, refresh
        if [ -z "$action" ]; then
            echo -ne "\r${CYAN}Refreshing...                       ${NC}\r"
        fi
    done
}

# Run the dashboard
main