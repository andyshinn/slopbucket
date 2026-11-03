#!/usr/bin/env bash
# Prints the Cloudflare Queues API URL for one queue (by name), for ops.yml steps
# that push messages: POST "$url/messages" or "$url/messages/batch".
# Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the environment.
set -euo pipefail
name="${1:?usage: queue-url.sh <queue name>}"
api="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/queues"
id=$(curl -fsS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$api?per_page=100" \
  | jq -r --arg n "$name" '.result[] | select(.queue_name == $n) | .queue_id')
[ -n "$id" ] || { echo "::error::Queue $name not found. Run the Bootstrap workflow first." >&2; exit 1; }
echo "$api/$id"
