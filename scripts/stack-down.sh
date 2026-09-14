#!/usr/bin/env bash
# Stop the vellum stack.
fuser -k 8787/tcp 2>/dev/null
fuser -k 8788/tcp 2>/dev/null
sleep 1
echo "stack down"
