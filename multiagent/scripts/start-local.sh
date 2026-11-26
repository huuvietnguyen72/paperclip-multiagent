#!/usr/bin/env bash
# Khởi động Paperclip (cổng 3100) cùng cổng webhook Telegram (cổng 3190) trên máy cá nhân.
#
#   PAPERCLIP_CHAT_WEBHOOK_PUBLIC_URL=https://<tên-miền-ngrok> ./multiagent/scripts/start-local.sh
#
# Chạy trong một cửa sổ terminal riêng (WSL Ubuntu) để server không bị tắt cùng công cụ khác.
# ngrok chạy riêng: `ngrok http 3190` (chỉ trỏ vào cổng 3190, KHÔNG BAO GIỜ trỏ vào 3100).
# Bỏ trống PAPERCLIP_CHAT_WEBHOOK_PUBLIC_URL nếu không dùng Telegram: khi đó chỉ chạy Paperclip.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_DIR="${PAPERCLIP_LOG_DIR:-$HOME}"
cd "$ROOT"

gate_pid=""
if [[ -n "${PAPERCLIP_CHAT_WEBHOOK_PUBLIC_URL:-}" ]]; then
  node multiagent/tools/webhook-gate.mjs >> "$LOG_DIR/webhook-gate.log" 2>&1 &
  gate_pid=$!
  echo "webhook gate: cổng ${GATE_PORT:-3190}, log $LOG_DIR/webhook-gate.log (pid $gate_pid)"
  echo "Telegram webhook: $PAPERCLIP_CHAT_WEBHOOK_PUBLIC_URL"
fi
trap '[[ -n "$gate_pid" ]] && kill "$gate_pid" 2>/dev/null || true' EXIT

echo "Paperclip: http://localhost:3100"
pnpm dev
