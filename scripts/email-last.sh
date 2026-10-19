#!/usr/bin/env bash
# Prints the newest email captured by `pnpm dev:email`: its headers and the decoded plain-text part.
set -euo pipefail
cd "$(dirname "$0")/.."
f=$(ls -t .wrangler/tmp/email/*/email/*.eml 2>/dev/null | head -1 || true)
[ -n "$f" ] || { echo "no captured email under .wrangler/tmp/email yet" >&2; exit 1; }
echo "# $f"
sed -n '1,/^\r\?$/p' "$f"
# The text/plain part is base64 (src/lib/mailer/cloudflare.ts): decode the lines after its blank separator.
awk '/^Content-Type: text\/plain/{p=1} p&&/^\r?$/{if(++n==1)next} p&&n==1&&/^--/{exit} p&&n==1' "$f" | tr -d '\r' | base64 -d
echo
