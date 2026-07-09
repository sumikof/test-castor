#!/usr/bin/env bash
# TMS docker-compose 受け入れスモーク。空ボリュームで `docker compose up` した web に対して実行する。
# 使い方:  ./scripts/docker-smoke.sh [BASE_URL]   (既定 http://localhost:8788)
set -euo pipefail
B="${1:-http://localhost:8788}"
jar="$(mktemp)"; trap 'rm -f "$jar"' EXIT
say(){ printf '\n=== %s ===\n' "$1"; }

say "1. setup (組織+管理者を作成)"
code=$(curl -s -o /tmp/tms-setup.json -w '%{http_code}' -X POST "$B/api/v1/setup" \
  -H 'content-type: application/json' \
  -d '{"organization_name":"Org","admin_email":"a@example.com","admin_password":"password1","admin_display_name":"Admin"}')
[ "$code" = "201" ] || { echo "setup expected 201, got $code"; cat /tmp/tms-setup.json; exit 1; }

say "2. login (cookie jar 保存)"
curl -s -c "$jar" -X POST "$B/api/v1/auth/login" -H 'content-type: application/json' \
  -d '{"email":"a@example.com","password":"password1"}' >/dev/null
CSRF=$(awk '$6=="csrf"{print $7}' "$jar")
[ -n "$CSRF" ] || { echo "no csrf cookie"; exit 1; }

say "3. create project"
PID=$(curl -s -b "$jar" -H "x-csrf-token: $CSRF" -X POST "$B/api/v1/projects" \
  -H 'content-type: application/json' -d '{"name":"payment"}' | jq -r .id)
[ "$PID" != "null" ] && [ -n "$PID" ] || { echo "project create failed"; exit 1; }

say "4. issue satellite token"
TOKEN=$(curl -s -b "$jar" -H "x-csrf-token: $CSRF" -X POST "$B/api/v1/projects/$PID/tokens" \
  -H 'content-type: application/json' -d '{"name":"discovery-ci"}' | jq -r .token)
[ "$TOKEN" != "null" ] && [ -n "$TOKEN" ] || { echo "token issue failed"; exit 1; }

say "5-7. sync start / chunk / commit"
SYN=$(curl -s -H "authorization: Bearer $TOKEN" -X POST "$B/api/v1/projects/$PID/sync/start" \
  -H 'content-type: application/json' -d '{"origin":"discovery-v1"}' | jq -r .sync_token)
curl -s -H "authorization: Bearer $TOKEN" -X POST "$B/api/v1/projects/$PID/sync/$SYN/chunk" \
  -H 'content-type: application/json' \
  -d '{"observations":[{"external_ref":"com.example.T#m","fingerprint":"fp1","observed":{"title":"支払い成功","given":"残高あり","when":"支払う","then":"成功","parameters":[],"source_ref":{},"schema_version":"1.0"}}]}' >/dev/null
curl -s -H "authorization: Bearer $TOKEN" -X POST "$B/api/v1/projects/$PID/sync/$SYN/commit" >/dev/null

say "8. testcase_count が 1 に増えていること"
COUNT=$(curl -s -b "$jar" "$B/api/v1/projects" | jq '.items[0].testcase_count')
[ "$COUNT" = "1" ] || { echo "expected testcase_count 1, got $COUNT"; exit 1; }

echo -e "\nSMOKE OK: setup→login→project→token→sync→count=1 すべて成功"
