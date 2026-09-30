#!/bin/bash
# Local builder on :5197 with the account's token for remote bindings (never printed).
set -Eeuo pipefail
cd "$(dirname "$0")/../.."
set -a; . ~/.config/nova/cloudflare.env; set +a
export DEV_MODE=true
exec bunx vite --port 5197 --strictPort --host 127.0.0.1
