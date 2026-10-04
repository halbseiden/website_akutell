#!/usr/bin/env bash
# Runner fuer einzelne k6-Lasttest-Szenarien.
#
# Aufruf:
#   ./run.sh <szenario-datei>
#   ./run.sh 03-web-1000-parallel-5s.js
#
# Verlangt einen laufenden Stack (docker compose up -d) und das Compose-Netz
# `it-infra-verein_public-net`. k6 laeuft als Container in genau diesem Netz und spricht
# den Reverse-Proxy unter https://reverse-proxy/ an. Damit umgeht der Test das
# macOS-Port-Forwarding von Docker Desktop, das sonst der Engpass waere.
#
# Ergebnisse werden nach results/<szenario>.txt geschrieben.

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Aufruf: $0 <szenario-datei>"
  echo "Beispiel: $0 03-web-1000-parallel-5s.js"
  exit 1
fi

SCRIPT="$1"
HERE="$(cd "$(dirname "$0")" && pwd)"
NAME="$(basename "$SCRIPT" .js)"
OUT="$HERE/results/$NAME.txt"

if [ ! -f "$HERE/scenarios/$SCRIPT" ]; then
  echo "Szenario nicht gefunden: $HERE/scenarios/$SCRIPT"
  exit 1
fi

mkdir -p "$HERE/results"

echo "=== $NAME ==="
docker run --rm -i \
  --network it-infra-verein_public-net \
  --ulimit nofile=65536:65536 \
  -e K6_DISCARD_RESPONSE_BODIES=true \
  -v "$HERE/scenarios:/scenarios:ro" \
  grafana/k6 run "/scenarios/$SCRIPT" \
  2>&1 | tee "$OUT"

echo
echo "Ergebnis: $OUT"
