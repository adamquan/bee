#!/bin/bash
# Create a directory for binaries
mkdir -p /opt/bin

# Download the latest Docker Compose binary
curl -L "https://github.com(uname -s)-$(uname -m)" -o /opt/bin/docker-compose
chmod +x /opt/bin/docker-compose

# Create your application workspace
mkdir -p /app
cat << 'EOF' > /app/docker-compose.yml
# paste your exact docker-compose.yml contents here
EOF

# Navigate and spin up the containers
cd /app
/opt/bin/docker-compose up -d

