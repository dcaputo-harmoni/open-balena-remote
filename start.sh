#!/bin/bash

# Start ttyd (one instance for all)
/usr/local/bin/ttyd \
    --url-arg \
    --client-option titleFixed="Open Balena Remote - SSH" \
    --base-path /ttyd \
    /usr/src/app/scripts/connect-ssh.sh \
    &

# Start open-balena-remote
node open-balena-remote.js &

sleep infinity
