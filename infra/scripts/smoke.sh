#!/usr/bin/env bash
# Smoke pós-deploy: GET /health (com retries por causa de cold start) e suíte de contrato.
# Uso: infra/scripts/smoke.sh https://roboflow-api-483331439325.us-central1.run.app
# Variável opcional: CONTRACT_TEST_TOKEN (ID token do Firebase) para endpoints de operador.
set -euo pipefail

BASE_URL="${1:?uso: smoke.sh <base-url>}"
BASE_URL="${BASE_URL%/}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

ok=0
for i in 1 2 3 4 5 6; do
  if body="$(curl -fsS --max-time 20 "$BASE_URL/health")" && echo "$body" | grep -q '"status"[[:space:]]*:[[:space:]]*"ok"'; then
    echo "health ok (tentativa $i)"
    ok=1
    break
  fi
  echo "health falhou (tentativa $i)"
  sleep 5
done
[ "$ok" = 1 ] || { echo "GET $BASE_URL/health não ficou ok" >&2; exit 1; }

cd "$ROOT/contracts"
npm ci
npm run contract:test -- --base-url "$BASE_URL"
echo "smoke ok"
