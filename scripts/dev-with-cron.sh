#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DEV_LOG="$ROOT_DIR/.tmp-dev.log"
DEV_PID=""

cleanup() {
  if [[ -n "${DEV_PID}" ]] && kill -0 "${DEV_PID}" 2>/dev/null; then
    echo "[dev-with-cron] stopping npm run dev (pid=${DEV_PID})"
    kill "${DEV_PID}" || true
  fi
}
trap cleanup EXIT INT TERM

echo "[dev-with-cron] starting npm run dev..."
npm run dev >"$DEV_LOG" 2>&1 &
DEV_PID=$!
echo "[dev-with-cron] dev pid: ${DEV_PID}"

is_reachable() {
  local base_url="$1"
  curl -fsS --max-time 2 "${base_url}/" >/dev/null 2>&1
}

detect_base_url() {
  local candidate=""
  local -a candidates=()

  if [[ -n "${APP_BASE_URL:-}" ]]; then
    candidates+=("${APP_BASE_URL%/}")
  fi

  if [[ -n "${SHOPIFY_APP_URL:-}" ]]; then
    candidates+=("${SHOPIFY_APP_URL%/}")
  fi

  local port="${PORT:-3000}"
  candidates+=(
    "http://localhost:${port}"
    "http://127.0.0.1:${port}"
    "http://localhost:3000"
    "http://127.0.0.1:3000"
  )

  for _ in $(seq 1 120); do
    for candidate in "${candidates[@]}"; do
      if is_reachable "$candidate"; then
        echo "$candidate"
        return 0
      fi
    done

    # Try to extract localhost URL from dev logs.
    if [[ -f "$DEV_LOG" ]]; then
      local detected
      detected="$(grep -Eo 'http://(localhost|127\.0\.0\.1):[0-9]+' "$DEV_LOG" | tail -n1 || true)"
      if [[ -n "$detected" ]] && is_reachable "$detected"; then
        echo "$detected"
        return 0
      fi
    fi

    sleep 1
  done

  return 1
}

BASE_URL="$(detect_base_url || true)"
if [[ -z "$BASE_URL" ]]; then
  echo "[dev-with-cron] could not detect local app URL."
  echo "[dev-with-cron] last dev logs:"
  tail -n 80 "$DEV_LOG" || true
  exit 1
fi

echo "[dev-with-cron] detected APP_BASE_URL=${BASE_URL}"
export APP_BASE_URL="$BASE_URL"

echo "[dev-with-cron] starting npm run cron:dev..."
npm run cron:dev

