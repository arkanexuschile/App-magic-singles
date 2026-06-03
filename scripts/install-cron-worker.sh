#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${APP_NAME:-shopify-price}"
SERVICE_NAME=""
TIMER_NAME=""
WORKER_SCRIPT=""
ENV_FILE="${ENV_FILE:-/var/www/shopify-price/.env}"
APP_PORT_FALLBACK="${APP_PORT_FALLBACK:-3000}"
SCHEDULE_ON_CALENDAR="${SCHEDULE_ON_CALENDAR:-*-*-* *:*:00}"

refresh_names() {
  SERVICE_NAME="${APP_NAME}-cron-worker.service"
  TIMER_NAME="${APP_NAME}-cron-worker.timer"
  WORKER_SCRIPT="/usr/local/bin/${APP_NAME}-cron-worker.sh"
}

usage() {
  cat <<EOF
Usage: $0 [--app-name NAME] [--env-file PATH] [--app-port PORT] [--schedule ONCALENDAR]

Options:
  -a, --app-name     Application name prefix for service/timer/script.
  -e, --env-file     Path to .env file used by the worker.
  -p, --app-port     Fallback app port if PORT is missing in .env.
  -s, --schedule     systemd OnCalendar expression.
  -h, --help         Show this help message.
EOF
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -a|--app-name)
        [[ $# -ge 2 ]] || die "Missing value for $1"
        APP_NAME="$2"
        shift 2
        ;;
      -e|--env-file)
        [[ $# -ge 2 ]] || die "Missing value for $1"
        ENV_FILE="$2"
        shift 2
        ;;
      -p|--app-port)
        [[ $# -ge 2 ]] || die "Missing value for $1"
        APP_PORT_FALLBACK="$2"
        shift 2
        ;;
      -s|--schedule)
        [[ $# -ge 2 ]] || die "Missing value for $1"
        SCHEDULE_ON_CALENDAR="$2"
        shift 2
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        die "Unknown argument: $1"
        ;;
    esac
  done
}

log() {
  echo "[cron-installer] $*"
}

die() {
  echo "[cron-installer][ERROR] $*" >&2
  exit 1
}

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    die "Run this installer as root (sudo)."
  fi
}

detect_os() {
  [[ -f /etc/os-release ]] || die "/etc/os-release not found."
  # shellcheck disable=SC1091
  source /etc/os-release
  local id="${ID:-unknown}"
  case "$id" in
    ubuntu|centos|rhel|rocky|almalinux)
      log "Detected supported distro: ${id}"
      ;;
    *)
      die "Unsupported distro '${id}'. Supported: ubuntu, centos/rhel/rocky/almalinux."
      ;;
  esac
}

require_cmds() {
  local missing=()
  local cmd
  for cmd in systemctl curl grep awk sed; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      missing+=("$cmd")
    fi
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    die "Missing required commands: ${missing[*]}"
  fi
}

read_env_value() {
  local key="$1"
  local value
  value="$(grep -E "^${key}=" "$ENV_FILE" | tail -n1 | sed -E "s/^${key}=//" | sed -E "s/^['\"]|['\"]$//g" || true)"
  echo "${value}"
}

validate_env() {
  [[ -f "$ENV_FILE" ]] || die "ENV file not found: $ENV_FILE"

  local warnings=()
  local cron_secret mode port

  cron_secret="$(read_env_value "CRON_SECRET")"
  mode="$(read_env_value "SYNC_SCHEDULER_MODE")"
  port="$(read_env_value "PORT")"

  if [[ -z "$cron_secret" ]]; then
    warnings+=("Missing CRON_SECRET in $ENV_FILE")
  fi
  if [[ -z "$mode" ]]; then
    warnings+=("Missing SYNC_SCHEDULER_MODE in $ENV_FILE (recommended: http)")
  elif [[ "$mode" != "http" ]]; then
    warnings+=("SYNC_SCHEDULER_MODE is '$mode' (recommended: http)")
  fi
  if [[ -z "$port" ]]; then
    warnings+=("Missing PORT in $ENV_FILE (will fallback to ${APP_PORT_FALLBACK})")
  fi

  if [[ ${#warnings[@]} -gt 0 ]]; then
    log "Configuration warnings:"
    local w
    for w in "${warnings[@]}"; do
      echo " - $w"
    done
    if [[ -z "$cron_secret" ]]; then
      die "Cannot continue without CRON_SECRET."
    fi
  fi
}

install_worker_script() {
  cat >"$WORKER_SCRIPT" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${ENV_FILE:-/var/www/shopify-price/.env}"
APP_PORT_FALLBACK="${APP_PORT_FALLBACK:-3000}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "[cron-worker][ERROR] ENV file not found: $ENV_FILE" >&2
  exit 1
fi

read_env_value() {
  local key="$1"
  local value
  value="$(grep -E "^${key}=" "$ENV_FILE" | tail -n1 | sed -E "s/^${key}=//" | sed -E "s/^['\"]|['\"]$//g" || true)"
  echo "${value}"
}

CRON_SECRET="$(read_env_value CRON_SECRET)"
PORT_VALUE="$(read_env_value PORT)"
APP_PORT="${PORT_VALUE:-$APP_PORT_FALLBACK}"

if [[ -z "$CRON_SECRET" ]]; then
  echo "[cron-worker][ERROR] Missing CRON_SECRET in $ENV_FILE" >&2
  exit 1
fi

curl -fsS -X POST "http://127.0.0.1:${APP_PORT}/internal/scheduler/tick" \
  -H "x-cron-secret: ${CRON_SECRET}" \
  -H "Content-Type: application/json" \
  >/dev/null

echo "[cron-worker] tick sent at $(date -u +"%Y-%m-%dT%H:%M:%SZ") on port ${APP_PORT}"
EOF

  chmod +x "$WORKER_SCRIPT"
  log "Installed worker script: $WORKER_SCRIPT"
}

install_systemd_units() {
  cat >/etc/systemd/system/"$SERVICE_NAME" <<EOF
[Unit]
Description=Run ${APP_NAME} cron worker tick once
After=network.target

[Service]
Type=oneshot
Environment=ENV_FILE=${ENV_FILE}
Environment=APP_PORT_FALLBACK=${APP_PORT_FALLBACK}
ExecStart=${WORKER_SCRIPT}
EOF

  cat >/etc/systemd/system/"$TIMER_NAME" <<EOF
[Unit]
Description=Run ${APP_NAME} cron worker every minute

[Timer]
OnCalendar=${SCHEDULE_ON_CALENDAR}
Persistent=true
Unit=${SERVICE_NAME}

[Install]
WantedBy=timers.target
EOF

  log "Installed systemd units: $SERVICE_NAME and $TIMER_NAME"
}

enable_timer() {
  systemctl daemon-reload
  systemctl enable --now "$TIMER_NAME"
  log "Timer enabled and started: $TIMER_NAME"
}

print_status() {
  echo
  log "Timer status:"
  systemctl status "$TIMER_NAME" --no-pager || true
  echo
  log "Next timer runs:"
  systemctl list-timers "$TIMER_NAME" --no-pager || true
  echo
  log "Worker service logs (recent):"
  journalctl -u "$SERVICE_NAME" -n 20 --no-pager || true
  echo
  log "Done."
}

main() {
  parse_args "$@"
  refresh_names
  require_root
  detect_os
  require_cmds
  validate_env
  install_worker_script
  install_systemd_units
  enable_timer
  print_status
}

main "$@"
