#!/usr/bin/env bash
#
# mcp-ctl.sh — gestion du serveur MCP Dynamics (transport HTTP).
#
# stdio ne peut pas tourner en arrière-plan : le process est le client MCP, il
# naît et meurt avec lui. Le seul mode « daemon » est donc `dist/http.js`, et
# c'est ce que ce script pilote. Un ancien mcp-ctl.sh lançait `dist/index.js`
# avec nohup : le process mourait aussitôt, le script ne pouvait rien piloter.
#
#   ./mcp-ctl.sh start     démarre en arrière-plan, attend /healthz
#   ./mcp-ctl.sh stop      SIGTERM, puis SIGKILL au bout de 10 s
#   ./mcp-ctl.sh restart
#   ./mcp-ctl.sh status    PID + /healthz (tools, sessions, read-only)
#   ./mcp-ctl.sh logs [-f] NDJSON du serveur (stderr)
#   ./mcp-ctl.sh token     affiche le Bearer token à mettre côté client
#
# La configuration vit dans ./.env.http (gitignoré, créé au premier start) :
# MCP_DYNAMICS_HTTP_TOKEN est OBLIGATOIRE, le serveur refuse de démarrer sans.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$ROOT/.env.http"
LOG_DIR="$ROOT/logs"
LOG_FILE="$LOG_DIR/http.log"
PID_FILE="${XDG_RUNTIME_DIR:-/tmp}/mcp-dynamics/mcp-dynamics.pid"
MAIN="$ROOT/dist/http.js"
UNIT="mcp-dynamics.service"

# --- helpers ----------------------------------------------------------------

c_reset=$'\033[0m'; c_ok=$'\033[32m'; c_warn=$'\033[33m'; c_err=$'\033[31m'; c_dim=$'\033[2m'

info() { printf '%s\n' "$*"; }
ok()   { printf '%s✔%s %s\n' "$c_ok" "$c_reset" "$*"; }
warn() { printf '%s⚠%s %s\n' "$c_warn" "$c_reset" "$*" >&2; }
die()  { printf '%s✘%s %s\n' "$c_err" "$c_reset" "$*" >&2; exit 1; }
dim()  { printf '%s%s%s\n' "$c_dim" "$*" "$c_reset"; }

have_systemd_unit() {
  command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files "$UNIT" >/dev/null 2>&1
}

# Charge .env.http sans l'exporter dans l'environnement du script appelant.
load_env() {
  [ -f "$ENV_FILE" ] || return 0
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
}

# --- env --------------------------------------------------------------------

ensure_env() {
  if [ ! -f "$ENV_FILE" ]; then
    local token
    if command -v openssl >/dev/null 2>&1; then
      token="$(openssl rand -hex 32)"
    else
      token="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    fi
    umask 077
    cat >"$ENV_FILE" <<EOF
# Configuration du serveur MCP Dynamics — généré par mcp-ctl.sh le $(date -Is)
# Ce fichier contient un secret : ne le commit pas (il est couvert par .gitignore).
MCP_DYNAMICS_HTTP_TOKEN=$token
MCP_DYNAMICS_HTTP_HOST=127.0.0.1
MCP_DYNAMICS_HTTP_PORT=3000
# MCP_DYNAMICS_READONLY=0        # dé commenter EXPLICITEMENT pour autoriser les écritures
# DYNAMICS_INSTANCE_URL=https://servicenow.crm.dynamics.com
# MCP_DYNAMICS_ALLOWED_ENTITIES=opportunities,accounts
EOF
    chmod 600 "$ENV_FILE"
    ok "Configuration créée : $ENV_FILE"
  fi
  load_env
  [ -n "${MCP_DYNAMICS_HTTP_TOKEN:-}" ] \
    || die "MCP_DYNAMICS_HTTP_TOKEN vide dans $ENV_FILE — le serveur refuserait de démarrer."
  # Le fichier contient un secret : 600 obligatoire, sans faire échouer le script
  # si le chmod n'est pas disponible (montage exotique, FS en lecture seule).
  chmod 600 "$ENV_FILE" 2>/dev/null || true
}

port()  { printf '%s' "${MCP_DYNAMICS_HTTP_PORT:-3000}"; }
host()  { printf '%s' "${MCP_DYNAMICS_HTTP_HOST:-127.0.0.1}"; }
base()  { printf 'http://%s:%s' "$(host)" "$(port)"; }

# --- process ----------------------------------------------------------------

running_pid() {
  [ -f "$PID_FILE" ] || return 1
  local pid; pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  printf '%s' "$pid"
}

# Empêche deux daemons sur le même port : le fichier PID ment, on le nettoie.
port_owner() {
  if command -v ss >/dev/null 2>&1; then
    ss -ltnp 2>/dev/null | awk -v p=":"$(port)"$" '$4 ~ p {print $NF}' | head -1
  fi
}

health() { curl -fsS --max-time 3 "$(base)/healthz" 2>/dev/null; }

uptime_of() {
  local pid="$1" start elapsed
  start="$(ps -o lstart= -p "$pid" 2>/dev/null | sed 's/^ *//')" || return 1
  elapsed="$(ps -o etimes= -p "$pid" 2>/dev/null | tr -d ' ')"
  if [ -n "$elapsed" ]; then
    printf '%s — en ligne depuis %ss\n' "$start" "$elapsed"
  else
    printf '%s\n' "$start"
  fi
}

ensure_built() {
  [ -d "$ROOT/node_modules" ] || die "node_modules absent — lance : npm install"
  if [ ! -f "$MAIN" ]; then
    info "dist/http.js absent, build…"
    (cd "$ROOT" && npm run build --silent)
  fi
  [ -f "$MAIN" ] || die "build impossible, $MAIN toujours absent"
}

# --- commandes --------------------------------------------------------------

do_start() {
  ensure_env
  ensure_built

  if have_systemd_unit && systemctl is-active --quiet "$UNIT" 2>/dev/null; then
    die "le service systemd $UNIT est déjà actif — utilise 'systemctl status $UNIT'."
  fi

  if pid="$(running_pid)"; then
    ok "Déjà démarré (PID $pid) sur $(base)"
    return 0
  fi
  rm -f "$PID_FILE"

  if owner="$(port_owner)" && [ -n "$owner" ]; then
    die "le port $(port) est déjà occupé par $owner. Change MCP_DYNAMICS_HTTP_PORT dans $ENV_FILE."
  fi

  mkdir -p "$LOG_DIR" "$(dirname "$PID_FILE")"
  : >>"$LOG_FILE"

  # setsid : le daemon survit à la fermeture du terminal et à Ctrl-C.
  setsid nohup node "$MAIN" >>"$LOG_FILE" 2>&1 &
  local pid=$!
  echo "$pid" >"$PID_FILE"

  local i
  for i in $(seq 1 40); do
    if health >/dev/null 2>&1; then
      ok "Démarré (PID $pid) — $(base)/mcp"
      dim "token   : $(./mcp-ctl.sh token)"
      dim "logs    : ./mcp-ctl.sh logs -f"
      return 0
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$PID_FILE"
      printf '%s\n' "--- dernières lignes de $LOG_FILE ---" >&2
      tail -n 20 "$LOG_FILE" >&2
      die "le serveur a quitté au démarrage (voir ci-dessus)."
    fi
    sleep 0.25
  done

  rm -f "$PID_FILE"
  tail -n 20 "$LOG_FILE" >&2
  die "pas de réponse sur /healthz après 10 s (voir $LOG_FILE)."
}

do_stop() {
  if ! pid="$(running_pid)"; then
    rm -f "$PID_FILE"
    info "Arrêté (rien à faire)."
    return 0
  fi

  kill -TERM "$pid" 2>/dev/null || true
  local i
  for i in $(seq 1 40); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.25
  done

  if kill -0 "$pid" 2>/dev/null; then
    warn "SIGTERM ignoré après 10 s, envoi de SIGKILL."
    kill -KILL "$pid" 2>/dev/null || true
    sleep 0.5
  fi

  rm -f "$PID_FILE"
  ok "Arrêté (PID $pid)."
}

do_status() {
  load_env
  local pid state=1
  if pid="$(running_pid)"; then state=0; fi

  if [ "$state" -ne 0 ]; then
    printf '%s● MCP Dynamics : arrêté%s   %s\n' "$c_err" "$c_reset" "$(base)"
    if have_systemd_unit && systemctl is-active --quiet "$UNIT" 2>/dev/null; then
      dim "  (le service systemd $UNIT est, lui, actif)"
    fi
    return 3
  fi

  printf '%s● MCP Dynamics : actif%s  PID %s  %s\n' \
    "$c_ok" "$c_reset" "$pid" "$(base)/mcp"
  dim "  démarré : $(uptime_of "$pid")"
  dim "  logs    : $LOG_FILE"

  local h
  if h="$(health)"; then
    if command -v jq >/dev/null 2>&1; then
      printf '  outils=%s  sessions=%s  read-only=%s\n' \
        "$(printf '%s' "$h" | jq -r '.tools')" \
        "$(printf '%s' "$h" | jq -r '.sessions')" \
        "$(printf '%s' "$h" | jq -r '.readonly')"
      dim "  instance : $(printf '%s' "$h" | jq -r '.environment.instance_url // "?"')"
    else
      printf '  %s\n' "$h"
    fi
    if [ "$(printf '%s' "$h" | sed -n 's/.*"readonly":\([a-z]*\).*/\1/p')" = "false" ]; then
      warn "  écritures ACTIVÉES sur le réseau (MCP_DYNAMICS_READONLY=0)."
    fi
  else
    warn "  /healthz ne répond pas — le process est vivant mais le service est mort."
    tail -n 20 "$LOG_FILE" >&2
    return 4
  fi
  return "$state"
}

do_logs() {
  load_env
  [ -f "$LOG_FILE" ] || die "pas encore de logs ($LOG_FILE). Lance './mcp-ctl.sh start'."
  if [ "${1:-}" = "-f" ]; then
    tail -n 0 -F "$LOG_FILE"
  else
    tail -n "${1:-50}" "$LOG_FILE"
  fi
}

do_token() {
  ensure_env
  printf '%s\n' "$MCP_DYNAMICS_HTTP_TOKEN"
}

# --- dispatch ---------------------------------------------------------------

# Affiche le bloc d'en-tête du fichier (commentaires initiaux), sans la suite.
usage() {
  awk 'NR==1 {next} /^#/ {sub(/^# ?/, ""); print; next} {exit}' "${BASH_SOURCE[0]}"
}

command="${1:-help}"; shift || true

case "$command" in
  start)          do_start ;;
  stop)           do_stop ;;
  restart)        do_stop; do_start ;;
  status)         do_status ;;
  logs)           do_logs "${1:-}" ;;
  token)          do_token ;;
  env)            printf '%s\n' "$ENV_FILE" ;;
  help|-h|--help) usage ;;
  *)              usage; exit 1 ;;
esac
