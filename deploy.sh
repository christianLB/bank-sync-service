#!/bin/bash

# Bank Sync Service Deployment Script
# Deploy to NAS: k2600x@192.168.1.11

set -e

# Configuration
NAS_HOST="k2600x@192.168.1.11"
NAS_PATH="/volume1/docker/bank-sync-service"
SERVICE_NAME="bank-sync-service"
DOCKER_NETWORK="bank-sync-net"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${GREEN}Bank Sync Service - NAS Deployment${NC}"
echo "======================================="

# Function to check SSH connection
check_ssh() {
    echo -e "${YELLOW}Checking SSH connection to NAS...${NC}"
    if ssh -o ConnectTimeout=5 $NAS_HOST "echo 'SSH OK'" > /dev/null 2>&1; then
        echo -e "${GREEN}✓ SSH connection successful${NC}"
        return 0
    else
        echo -e "${RED}✗ Cannot connect to NAS via SSH${NC}"
        echo "Please ensure:"
        echo "  1. NAS is powered on and accessible"
        echo "  2. SSH keys are configured"
        echo "  3. Network connection is available"
        return 1
    fi
}

# Function to prepare deployment
prepare_deployment() {
    echo -e "${YELLOW}Preparing deployment package...${NC}"
    
    # Check if npm packages are installed
    if [ ! -d "node_modules" ]; then
        echo -e "${YELLOW}Installing dependencies...${NC}"
        npm ci
    fi
    
    # Build TypeScript
    echo -e "${YELLOW}Building TypeScript...${NC}"
    npm run build
    
    # Create deployment archive
    echo -e "${YELLOW}Creating deployment archive...${NC}"
    tar -czf ${SERVICE_NAME}.tar.gz \
        --exclude='node_modules' \
        --exclude='.git' \
        --exclude='.env' \
        --exclude='*.log' \
        --exclude='data' \
        .
    
    echo -e "${GREEN}✓ Deployment package ready${NC}"
}

# Function to deploy to NAS
deploy_to_nas() {
    echo -e "${YELLOW}Deploying to NAS...${NC}"
    
    # Create directory on NAS
    echo "  Creating directory structure..."
    ssh $NAS_HOST "mkdir -p $NAS_PATH"
    
    # Copy deployment package
    echo "  Copying files to NAS..."
    scp ${SERVICE_NAME}.tar.gz $NAS_HOST:$NAS_PATH/
    
    # Extract and setup on NAS
    echo "  Extracting and setting up..."
    ssh $NAS_HOST << EOF
        cd $NAS_PATH
        tar -xzf ${SERVICE_NAME}.tar.gz
        rm ${SERVICE_NAME}.tar.gz
        
        # Check if .env exists
        if [ ! -f .env ]; then
            cp .env.example .env
            echo -e "${YELLOW}⚠ .env file created from template - please configure it${NC}"
        fi
        
        # Install dependencies on NAS
        echo "Installing dependencies on NAS..."
        docker run --rm -v \$(pwd):/app -w /app node:20-alpine npm ci --omit=dev
EOF
    
    # Cleanup local archive
    rm -f ${SERVICE_NAME}.tar.gz
    
    echo -e "${GREEN}✓ Files deployed to NAS${NC}"
}

# Function to build and start services
start_services() {
    echo -e "${YELLOW}Building and starting services on NAS...${NC}"
    
    ssh $NAS_HOST << EOF
        cd $NAS_PATH
        
        # Stop existing services
        docker-compose down 2>/dev/null || true
        
        # Build images
        echo "Building Docker images..."
        docker-compose build
        
        # Start services
        echo "Starting services..."
        docker-compose up -d
        
        # Wait for services to be ready
        echo "Waiting for services to start..."
        sleep 10
        
        # Check service status
        docker-compose ps
EOF
    
    echo -e "${GREEN}✓ Services started${NC}"
}

# Function to verify deployment
verify_deployment() {
    echo -e "${YELLOW}Verifying deployment...${NC}"
    
    # Check container status
    echo "  Checking container status..."
    ssh $NAS_HOST "cd $NAS_PATH && docker-compose ps"
    
    # Health check
    echo "  Running health check..."
    if curl -s -f http://192.168.1.11:4010/health > /dev/null 2>&1; then
        echo -e "${GREEN}✓ Health check passed${NC}"
        curl -s http://192.168.1.11:4010/health | jq .
    else
        echo -e "${RED}✗ Health check failed${NC}"
        echo "  Checking logs..."
        ssh $NAS_HOST "cd $NAS_PATH && docker-compose logs --tail=50 bank-sync-service"
        return 1
    fi
    
    # Ready check
    echo "  Running ready check..."
    if curl -s -f http://192.168.1.11:4010/ready > /dev/null 2>&1; then
        echo -e "${GREEN}✓ Ready check passed${NC}"
        curl -s http://192.168.1.11:4010/ready | jq .
    else
        echo -e "${YELLOW}⚠ Ready check failed - Redis might not be connected${NC}"
    fi
}

# Function to show post-deployment instructions
show_instructions() {
    echo ""
    echo -e "${GREEN}========================================${NC}"
    echo -e "${GREEN}Deployment Complete!${NC}"
    echo -e "${GREEN}========================================${NC}"
    echo ""
    echo "Service URLs:"
    echo "  API:     http://192.168.1.11:4010"
    echo "  Health:  http://192.168.1.11:4010/health"
    echo "  Ready:   http://192.168.1.11:4010/ready"
    echo ""
    echo "Next steps:"
    echo "  1. Configure .env file on NAS:"
    echo "     ssh $NAS_HOST"
    echo "     cd $NAS_PATH"
    echo "     nano .env"
    echo ""
    echo "  2. Add GoCardless credentials:"
    echo "     - GC_ACCESS_TOKEN"
    echo "     - GC_WEBHOOK_SECRET"
    echo ""
    echo "  3. Restart services after configuration:"
    echo "     make deploy-restart"
    echo ""
    echo "Useful commands:"
    echo "  View logs:        make deploy-logs"
    echo "  Check status:     make deploy-status"
    echo "  Restart services: make deploy-restart"
    echo "  Stop services:    make deploy-stop"
}

# Main deployment flow
main() {
    echo "Starting deployment process..."
    echo ""
    
    # Check SSH connection
    if ! check_ssh; then
        exit 1
    fi
    
    # Prepare deployment
    prepare_deployment
    
    # Deploy to NAS
    deploy_to_nas
    
    # Start services
    start_services
    
    # Verify deployment
    if verify_deployment; then
        show_instructions
    else
        echo -e "${RED}Deployment verification failed!${NC}"
        echo "Please check the logs for errors."
        exit 1
    fi
}

# Run main function
main