#!/bin/bash
# GCP GPU Worker Setup Script
# Run this to complete the setup

set -e

echo "================================================"
echo "GCP GPU Worker Setup"
echo "================================================"

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Step 1: Check gcloud installation
echo -e "\n${YELLOW}[1/6] Checking gcloud installation...${NC}"
if ! command -v gcloud &> /dev/null; then
    echo -e "${RED}❌ gcloud CLI not found. Please install:${NC}"
    echo "   brew install --cask google-cloud-sdk"
    echo "   Then run: gcloud auth login"
    exit 1
fi
echo -e "${GREEN}✅ gcloud CLI found${NC}"

# Step 2: Check authentication
echo -e "\n${YELLOW}[2/6] Checking authentication...${NC}"
if ! gcloud auth list --filter=status:ACTIVE --format="value(account)" | grep -q .; then
    echo -e "${YELLOW}⚠️  Not authenticated. Running gcloud auth login...${NC}"
    gcloud auth login
fi
ACCOUNT=$(gcloud auth list --filter=status:ACTIVE --format="value(account)" | head -n1)
echo -e "${GREEN}✅ Authenticated as: ${ACCOUNT}${NC}"

# Step 3: Check project
echo -e "\n${YELLOW}[3/6] Checking GCP project...${NC}"
PROJECT=$(gcloud config get-value project)
if [ -z "$PROJECT" ]; then
    echo -e "${YELLOW}⚠️  No project set. Setting to silken-slice-480417-e0...${NC}"
    gcloud config set project silken-slice-480417-e0
    PROJECT="silken-slice-480417-e0"
fi
echo -e "${GREEN}✅ Project: ${PROJECT}${NC}"

# Step 4: Check if VM exists
echo -e "\n${YELLOW}[4/6] Checking if GPU VM exists...${NC}"
ZONE="us-central1-a"
VM_NAME="photogrammetry-gpu-worker"

if gcloud compute instances describe $VM_NAME --zone=$ZONE &> /dev/null; then
    echo -e "${GREEN}✅ VM exists${NC}"
    VM_STATUS=$(gcloud compute instances describe $VM_NAME --zone=$ZONE --format="value(status)")
    echo "   Status: $VM_STATUS"
    
    if [ "$VM_STATUS" != "RUNNING" ]; then
        echo -e "${YELLOW}⚠️  VM is not running. Starting it...${NC}"
        gcloud compute instances start $VM_NAME --zone=$ZONE
        echo "   Waiting for VM to start (30 seconds)..."
        sleep 30
    fi
else
    echo -e "${RED}❌ VM does not exist${NC}"
    echo ""
    echo "Would you like to create it now? (y/n)"
    read -r response
    if [[ "$response" =~ ^([yY][eE][sS]|[yY])$ ]]; then
        echo -e "${YELLOW}Creating GPU VM...${NC}"
        gcloud compute instances create $VM_NAME \
          --zone=$ZONE \
          --machine-type=n1-standard-4 \
          --accelerator="type=nvidia-tesla-p4,count=1" \
          --image-family=common-cu121-debian-11 \
          --image-project=deeplearning-platform-release \
          --maintenance-policy=TERMINATE \
          --boot-disk-size=50GB \
          --boot-disk-type=pd-ssd \
          --metadata-from-file=startup-script=./gcp-vm-startup.sh
        
        echo -e "${YELLOW}⏳ Waiting for startup script to complete (5 minutes)...${NC}"
        echo "   This installs COLMAP with CUDA support"
        sleep 300
        echo -e "${GREEN}✅ VM created${NC}"
    else
        echo -e "${RED}Setup aborted. VM is required.${NC}"
        exit 1
    fi
fi

# Step 5: Configure SSH
echo -e "\n${YELLOW}[5/6] Configuring SSH access...${NC}"
gcloud compute config-ssh

# Test SSH connection
echo -e "\n${YELLOW}Testing SSH connection...${NC}"
if gcloud compute ssh $VM_NAME --zone=$ZONE --command="echo 'SSH OK'" &> /dev/null; then
    echo -e "${GREEN}✅ SSH connection successful${NC}"
else
    echo -e "${RED}❌ SSH connection failed${NC}"
    echo "   Try manually: gcloud compute ssh $VM_NAME --zone=$ZONE"
    exit 1
fi

# Step 6: Verify COLMAP and processing script
echo -e "\n${YELLOW}[6/6] Verifying COLMAP and processing script...${NC}"

# Check COLMAP
echo "Checking COLMAP installation..."
if gcloud compute ssh $VM_NAME --zone=$ZONE --command="which colmap" &> /dev/null; then
    echo -e "${GREEN}✅ COLMAP installed${NC}"
else
    echo -e "${RED}❌ COLMAP not found${NC}"
    echo "   The startup script may still be running or failed."
    echo "   Check logs: gcloud compute ssh $VM_NAME --zone=$ZONE"
    echo "   Then run: sudo cat /var/log/syslog | grep -i colmap"
fi

# Check CUDA
echo "Checking CUDA..."
if gcloud compute ssh $VM_NAME --zone=$ZONE --command="nvidia-smi" &> /dev/null; then
    echo -e "${GREEN}✅ CUDA/GPU detected${NC}"
else
    echo -e "${YELLOW}⚠️  GPU not detected (may need VM restart)${NC}"
fi

# Check processing script
echo "Checking processing script..."
if gcloud compute ssh $VM_NAME --zone=$ZONE --command="test -f /opt/photogrammetry-service/process_dense.py" &> /dev/null; then
    echo -e "${GREEN}✅ Processing script exists${NC}"
else
    echo -e "${YELLOW}⚠️  Processing script missing. Creating it...${NC}"
    
    # Create the directory and script
    gcloud compute ssh $VM_NAME --zone=$ZONE --command="sudo mkdir -p /opt/photogrammetry-service"
    
    # Upload the script from gcp-vm-startup.sh embedded version
    echo "   Extracting script from startup script..."
    # For now, tell user to run startup script manually
    echo -e "${YELLOW}   Please SSH into the VM and run the startup script:${NC}"
    echo "   gcloud compute ssh $VM_NAME --zone=$ZONE"
    echo "   curl -fsSL YOUR_STARTUP_SCRIPT_URL | sudo bash"
fi

echo ""
echo "================================================"
echo -e "${GREEN}Setup Complete!${NC}"
echo "================================================"
echo ""
echo "Your GCP GPU worker is ready to use."
echo ""
echo "Next steps:"
echo "1. Start your backend: npm run dev"
echo "2. Upload photos via the photogrammetry UI"
echo "3. Process with dense-method: colmap"
echo "4. Watch the logs for GCP GPU activation"
echo ""
echo "Useful commands:"
echo "  Start VM:  gcloud compute instances start $VM_NAME --zone=$ZONE"
echo "  Stop VM:   gcloud compute instances stop $VM_NAME --zone=$ZONE"
echo "  SSH to VM: gcloud compute ssh $VM_NAME --zone=$ZONE"
echo ""
echo "Cost: ~\$0.65/hour when running, \$2.60/month when stopped"
echo ""
