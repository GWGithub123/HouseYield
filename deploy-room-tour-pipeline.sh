#!/bin/bash

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -f "$SCRIPT_DIR/.env" ]; then
    export $(grep -E '^(ROOM_TOUR_GCP_WORKER_|GCP_GPU_WORKER_)' "$SCRIPT_DIR/.env" | xargs)
fi

VM_NAME="${ROOM_TOUR_GCP_WORKER_INSTANCE:-${GCP_GPU_WORKER_INSTANCE:-photogrammetry-gpu-worker}}"
ZONE="${ROOM_TOUR_GCP_WORKER_ZONE:-${GCP_GPU_WORKER_ZONE:-us-central1-a}}"
PROJECT="${ROOM_TOUR_GCP_WORKER_PROJECT:-${GCP_GPU_WORKER_PROJECT:-}}"
REMOTE_SERVICE_DIR="${ROOM_TOUR_GCP_SERVICE_DIR:-/opt/room-tour-service}"

if [ -z "$VM_NAME" ] || [ -z "$ZONE" ]; then
    echo "ROOM_TOUR_GCP_WORKER_INSTANCE and ROOM_TOUR_GCP_WORKER_ZONE must be configured"
    exit 1
fi

REMOTE_SCRIPT_PATH="$REMOTE_SERVICE_DIR/process_room_tour.py"
LOCAL_SCRIPT_PATH="$SCRIPT_DIR/server/scripts/room_tour/process_room_tour.py"

if [ ! -f "$LOCAL_SCRIPT_PATH" ]; then
    echo "Missing local room-tour worker script: $LOCAL_SCRIPT_PATH"
    exit 1
fi

PROJECT_FLAG=""
if [ -n "$PROJECT" ]; then
    PROJECT_FLAG="--project=$PROJECT"
fi

echo "=============================================="
echo "Deploying Room-Tour Pipeline to GCP VM"
echo "=============================================="
echo "VM: $VM_NAME"
echo "Zone: $ZONE"
echo "Service Dir: $REMOTE_SERVICE_DIR"
echo ""

VM_STATUS=$(gcloud compute instances describe "$VM_NAME" --zone="$ZONE" $PROJECT_FLAG --format='get(status)' 2>/dev/null || echo "NOT_FOUND")
if [ "$VM_STATUS" = "NOT_FOUND" ]; then
    echo "VM not found: $VM_NAME"
    exit 1
fi

if [ "$VM_STATUS" = "TERMINATED" ]; then
    echo "Starting VM..."
    gcloud compute instances start "$VM_NAME" --zone="$ZONE" $PROJECT_FLAG
    sleep 30
fi

echo "Creating remote room-tour service directory..."
gcloud compute ssh "$VM_NAME" --zone="$ZONE" $PROJECT_FLAG --command="sudo mkdir -p $REMOTE_SERVICE_DIR /opt/room-tour-data && sudo chown \$(whoami) $REMOTE_SERVICE_DIR /opt/room-tour-data && chmod 777 /opt/room-tour-data"

echo "Uploading process_room_tour.py..."
gcloud compute scp "$LOCAL_SCRIPT_PATH" "$VM_NAME:$REMOTE_SCRIPT_PATH" --zone="$ZONE" $PROJECT_FLAG

echo "Making script executable..."
gcloud compute ssh "$VM_NAME" --zone="$ZONE" $PROJECT_FLAG --command="chmod +x $REMOTE_SCRIPT_PATH"

echo "Verifying deployment..."
gcloud compute ssh "$VM_NAME" --zone="$ZONE" $PROJECT_FLAG --command="/opt/room-tour-venv/bin/python3 $REMOTE_SCRIPT_PATH --help | head -5"

echo ""
echo "Room-tour worker deployed successfully"
echo "Remote entrypoint: $REMOTE_SCRIPT_PATH"