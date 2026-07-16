#!/bin/bash
set -e

# Go interne, fixe sur 8080 (indépendant du PORT global de Render)
PORT=8080 /usr/local/bin/livescore-go &

# Rust interne, se connecte à l'API TS en local
UPSTREAM_WS="ws://127.0.0.1:${PORT:-3000}" /usr/local/bin/livescore-rust &

# Collector Python en tâche de fond
python3 /app/collector/collector.py &

# API TS = processus principal, au premier plan (port public $PORT)
cd /app/ts
exec npm start
