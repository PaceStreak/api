#!/usr/bin/env bash
# Runs `wrangler dev` with the real Cloudflare mailer path (MAILER=cloudflare, EMAIL_ENABLED=1) and throwaway
# secrets, against its own local D1 under .wrangler/email-local, so it never touches your `pnpm dev` state.
# The send_email binding is simulated locally: nothing is delivered. Wrangler logs each send
# ("send_email binding called with ...") and saves the raw MIME message under the Miniflare temp directory;
# `pnpm email:last` prints the newest one. See README "Testing email locally".
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-8788}"
STATE=".wrangler/email-local"
mkdir -p "$STATE"
VARS="$STATE/dev.vars"
key() { openssl rand -base64 32; }
{
  echo "ENVIRONMENT=development"
  echo "MAILER=cloudflare"
  echo "EMAIL_ENABLED=1"
  echo "IP_LIMITS_OFF=1"
  echo "COOKIE_DOMAIN="
  echo "CORS_ORIGINS=http://localhost:5173"
  echo "FRONTEND_URL=http://localhost:5173"
  echo "PUBLIC_API_URL=http://localhost:$PORT"
  printf 'JWT_KEYS={"current":"k1","keys":{"k1":"%s"}}\n' "$(key)"
  echo "PEPPER=$(key)"
  echo "DATA_KEY=$(key)"
  # Cloudflare's always-pass Turnstile test secret: any token, including none, passes.
  echo "TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA"
} >"$VARS"
pnpm -s wrangler d1 migrations apply pacestreak --local --persist-to "$STATE" >/dev/null
exec pnpm -s wrangler dev --port "$PORT" --env-file "$VARS" --persist-to "$STATE" "$@"
