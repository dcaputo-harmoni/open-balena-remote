#!/bin/bash

LOCALPORT="$1"
UUID="$2"
SSH_CONTAINER="$3"
USERNAME="$4"
SESSION_DIR="$5"

SSH_CMD="\
  stty sane; \
  export TMOUT=21600; \
  export TERM=linux; \
  export PS1='\[\033[01;32m\]${UUID:0:7}/host\[\033[00m\]:\[\033[01;34m\]\w\[\033[00m\]\$ ';"
if [ -z "$SSH_CONTAINER" ]; then
  SSH_CMD="${SSH_CMD} /bin/bash"
else
  SSH_CMD="${SSH_CMD} \
  export CONTAINER=\$(balena container ls -q --filter name=${SSH_CONTAINER}* | head -n 1); \
  if [ -z \"\$CONTAINER\" ]; then \
    echo 'Error: ${SSH_CONTAINER} container not found'; \
    exit 0; \
  fi; \
  balena exec -it \
    -e TMOUT=21600 \
    -e PROMPT_COMMAND='PS1=\"\[\033[01;32m\]\${BALENA_DEVICE_UUID:0:7}/\${BALENA_SERVICE_NAME}\[\033[00m\]:\[\033[01;34m\]\w\[\033[00m\]\$ \"' \
    \$CONTAINER /bin/bash"
fi

ssh -t $USERNAME@localhost -i $SESSION_DIR/privateKey -p $LOCALPORT -o StrictHostKeyChecking=no -o ServerAliveInterval=10 -o LogLevel=ERROR $SSH_CMD

sleep infinity