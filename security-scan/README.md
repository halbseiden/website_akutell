# Sicherheitsscan der eigenen Docker-Images

**Stand:** 2026-10-04
**Werkzeug:** [Trivy](https://github.com/aquasecurity/trivy) (Image `aquasec/trivy:latest`, via Docker ausgeführt — keine Host-Installation noetig)
**Gescannte eigene Images:** `it-infra-verein-backend-1`, `it-infra-verein-frontend`, `it-infra-verein-database` (aus `docker-compose.yml`, `build:`-Direktive)
**Severities im Scope:** `HIGH`, `CRITICAL`

## Ergebnis

| Image | Vor den Fixes (Base-Image) | Nach den Fixes (eigenes Image) |
|---|---|---|
| `it-infra-verein-backend` | 11 HIGH, 0 CRITICAL (`node:22-alpine`) | **0 HIGH, 0 CRITICAL** |
| `it-infra-verein-frontend` | 2 HIGH, 0 CRITICAL (`nginx:alpine`) | **0 HIGH, 0 CRITICAL** |
| `it-infra-verein-database` | 21 HIGH, 1 CRITICAL (`postgres:17-alpine`) | **0 HIGH, 0 CRITICAL** |

Damit ist Kriterium **„Sicherheitsscan findet keine kritischen Schwachstellen"** erfüllt: Keines der eigenen Images enthält eine HIGH- oder CRITICAL-Schwachstelle.

## Reproduktion

Aus dem Projektverzeichnis (Repository-Root):

```bash
docker compose build
for img in it-infra-verein-backend-1:latest it-infra-verein-frontend:latest it-infra-verein-database:latest; do
  docker run --rm \
    -v /var/run/docker.sock:/var/run/docker.sock \
    aquasec/trivy:latest image \
      --severity HIGH,CRITICAL \
      --scanners vuln \
      "$img"
done
```

Rohe Reports liegen unter [`before/`](before/) (jeweils das Base-Image, auf dem das eigene Image aufbaut) und [`after/`](after/) (final gebaute eigene Images).

## Befunde und Maßnahmen

### Backend (`it-infra-verein-backend`)

**Befunde im Base-Image** `node:22-alpine` (11 HIGH, 0 CRITICAL):

| Paket | CVE | Ort im Image |
|---|---|---|
| `brace-expansion` | CVE-2026-102276, CVE-2026-102278, CVE-2026-13149, CVE-2026-14257, CVE-2026-69152 | `/usr/local/lib/node_modules/npm/node_modules/...` |
| `pacote` | CVE-2026-9496 (zwei Versionen) | dito |
| `http-cache-semantics`, `ip-address`, `picomatch`, `sigstore` | CVE-2026-93748, CVE-2026-69192, CVE-2026-33671, CVE-2026-48815 | dito |

Alle 11 Befunde stammen aus dem `npm`-CLI, das zur **Laufzeit** des Backends nicht gebraucht wird (npm dient nur dem Build). Die Alpine-Systempakete des Base-Images sind ohne Befund.

**Maßnahme:** [`backend/Dockerfile`](../backend/Dockerfile) auf **Multi-Stage-Build** umgestellt. Die `npm install`-Schicht läuft im Builder-Stage; im Runtime-Stage wird `npm`/`npx` und das gesamte Verzeichnis `/usr/local/lib/node_modules/npm/` entfernt. Damit entfällt die Angriffsfläche, ohne dass die App etwas verliert (`node server.js` braucht kein npm).

Zusätzlich spielt `apk upgrade --no-cache` im Runtime-Stage gepatchte Alpine-Systempakete ein, auch wenn das Base-Image selbst noch nicht neu gebaut wurde (aktuell OpenSSL 3.5.8 → 3.5.9). Unter `node:20-alpine` hat das 4 HIGH-Befunde in OpenSSL behoben.

**Node.js-Version:** Das Backend nutzt Node.js 22 (LTS). Node.js 20 ist seit April 2026 End-of-Life und erhält keine Sicherheitsupdates mehr.

### Frontend (`it-infra-verein-frontend`)

**Befunde im Base-Image** `nginx:alpine`: 2 HIGH in Alpine-Systempaketen, `libexpat` (CVE-2026-93990) und `pcre2` (CVE-2026-103111). Das eigene Image fügt sonst nur statische HTML/CSS-Dateien hinzu.

**Maßnahme:** [`frontend/Dockerfile`](../frontend/Dockerfile) führt `apk upgrade --no-cache` aus und spielt damit die gepatchten Pakete ein (`libexpat` 2.8.4 → 2.8.5, `pcre2` 10.48 → 10.49).

### Database (`it-infra-verein-database`)

**Befunde im Base-Image** `postgres:17-alpine`: 21 HIGH + **1 CRITICAL**, alle in der Go-Stdlib des Binarys `/usr/local/bin/gosu`, das das offizielle postgres-Image für den Privileg-Wechsel root → postgres mitbringt. Wurzel: Das gosu-Binary ist mit Go-stdlib **v1.24.6** verlinkt, die u. a. **CVE-2025-68121** (`crypto/tls: incorrect certificate validation during TLS session resumption`, Severity CRITICAL) enthält.

Verifiziert: Die selbe CRITICAL-CVE tritt in **allen** aktuellen offiziellen postgres-Image-Varianten (15/16/17, Alpine und Debian) auf — das postgres-Team hat gosu noch nicht mit neuerer Go-Toolchain neu gebaut.

**Maßnahme:** [`db/Dockerfile`](../db/Dockerfile) auf **Multi-Stage-Build** umgestellt:
1. Stage 1 klont das offizielle gosu-Repo (`github.com/tianon/gosu`) und baut das Binary frisch mit `golang:1.25-alpine` (aktuell Go-stdlib **v1.25.14**, CVE-2025-68121 ist ab 1.25.7 behoben).
2. Stage 2 basiert auf `postgres:17-alpine` und überschreibt das verwundbare Binary unter `/usr/local/bin/gosu`.

Verifikation im laufenden Container:
```
$ docker compose exec database gosu --version
1.19 (go1.25.14 on linux/arm64; gc)
```

Postgres-Major-Wechsel 15 → 17 ist für unser triviales `init.sql` unkritisch (nur Standard-DDL).

## Funktionaler Smoke-Test nach Rebuild

```
GET https://localhost/health
→ HTTP 200 {"status":"healthy","db":"connected","uptime":82.8}
```

Alle Container `healthy`, End-to-End-Kette Reverse-Proxy → Load-Balancer → Backend → Postgres 17 funktioniert.

## Hinweis zum Scope

Der Scan deckt nur die **selbst gebauten** Images ab (`build:`-Services in `docker-compose.yml`). Fremd-Images (`nginx:alpine` für Reverse-Proxy/Load-Balancer, `prom/prometheus`, `grafana/grafana`, `cadvisor`, `nginx-exporter`) sind nicht im Kriterien-Scope, lassen sich aber mit denselben Befehlen scannen.
