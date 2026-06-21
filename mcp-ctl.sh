#!/bin/bash
# Contrôle du serveur MCP Dynamics (usage manuel/debug)

SERVER="node /Users/frederic.farjon/Claude/mcp-dynamics/dist/index.js"
PID_FILE="/tmp/mcp-dynamics.pid"

status() {
  pid=$(pgrep -f "mcp-dynamics/dist/index.js" 2>/dev/null)
  if [ -n "$pid" ]; then
    echo "MCP Dynamics: actif (PID $pid)"
  else
    echo "MCP Dynamics: arrêté"
  fi
}

start() {
  pid=$(pgrep -f "mcp-dynamics/dist/index.js" 2>/dev/null)
  if [ -n "$pid" ]; then
    echo "Déjà en cours (PID $pid)"
    exit 0
  fi
  nohup $SERVER > /tmp/mcp-dynamics.log 2>&1 &
  echo $! > "$PID_FILE"
  echo "Démarré (PID $!)"
}

stop() {
  pid=$(pgrep -f "mcp-dynamics/dist/index.js" 2>/dev/null)
  if [ -z "$pid" ]; then
    echo "Pas en cours"
    exit 0
  fi
  kill "$pid" && echo "Arrêté (PID $pid)"
  rm -f "$PID_FILE"
}

case "$1" in
  start)  start ;;
  stop)   stop ;;
  restart) stop; sleep 1; start ;;
  status) status ;;
  *) echo "Usage: $0 {start|stop|restart|status}" ;;
esac
