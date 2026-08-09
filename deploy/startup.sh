#!/bin/bash
# Compute Engine startup script. Runs as root on every boot; everything in it
# is idempotent, so a reboot is a no-op rather than a reinstall.
#
#   gcloud compute instances create ... --metadata-from-file startup-script=deploy/startup.sh
#
# Logs: journalctl -u google-startup-scripts -f
set -euxo pipefail

REPO="${BEE_REPO:-https://github.com/adamquan/bee.git}"
APP_DIR=/opt/bee/app
DATA_DIR=/opt/bee/data
DISK=/dev/disk/by-id/google-bee-data

# --- Docker ----------------------------------------------------------------
if ! command -v docker >/dev/null; then
  apt-get update
  apt-get install -y ca-certificates curl git
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

# --- Persistent disk -------------------------------------------------------
# The whole reason for a VM rather than Cloud Run: a real filesystem, so
# SQLite's locking works and practice history survives a restart.
mkdir -p "$DATA_DIR"
if [ -b "$DISK" ]; then
  # Only format a disk that has no filesystem — never one that already holds
  # the database.
  if ! blkid "$DISK" >/dev/null 2>&1; then
    mkfs.ext4 -m 0 -E lazy_itable_init=0,lazy_journal_init=0,discard "$DISK"
  fi
  grep -q "$DATA_DIR" /etc/fstab || \
    echo "$DISK $DATA_DIR ext4 discard,defaults,nofail 0 2" >> /etc/fstab
  mountpoint -q "$DATA_DIR" || mount "$DATA_DIR"
fi
# The containers run as uid 10001.
chown -R 10001:10001 "$DATA_DIR"

# --- Application -----------------------------------------------------------
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --ff-only
else
  git clone --depth 1 "$REPO" "$APP_DIR"
fi
cd "$APP_DIR"

# Secrets come from Secret Manager, never from the image or the repo. Written
# 0600 and owned by root; compose reads it as root.
if [ ! -f .env ] && command -v gcloud >/dev/null; then
  umask 077
  {
    echo "BEE_DOMAIN=$(curl -sf -H 'Metadata-Flavor: Google' \
      http://metadata.google.internal/computeMetadata/v1/instance/attributes/bee-domain || true)"
    echo "BEE_SITE_URL=https://$(curl -sf -H 'Metadata-Flavor: Google' \
      http://metadata.google.internal/computeMetadata/v1/instance/attributes/bee-domain || true)"
    gcloud secrets versions access latest --secret=bee-env 2>/dev/null || true
  } > .env
fi

docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml build
docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml up -d

echo "bee: up. Data on $DATA_DIR, logs via 'docker compose logs -f'."
