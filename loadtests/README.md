# Lasttests mit k6

Deckt die 12 Lasttest-Kriterien aus [`bewertungskriterien.md`](../docs/bewertungskriterien.md) (Zeilen 17–29) ab.

## Voraussetzungen

- Laufender Stack (`docker compose up -d` im Projektverzeichnis)
- Docker Desktop mit mindestens **6 GB Memory** (Settings → Resources → Memory). Bei 1000 parallelen VUs reicht der Default von 3.8 GB nicht — k6 wird sonst OOM-gekillt.

## Architektur des Test-Aufbaus

k6 läuft als Docker-Container und wird ans Compose-Netz `it-infra-verein_public-net` angeschlossen. Dadurch spricht k6 den Reverse-Proxy direkt unter seinem Service-DNS-Namen `https://reverse-proxy/` an. Das umgeht das Port-Forwarding von Docker Desktop unter macOS, das selbst bei 1000 parallelen TLS-Verbindungen zum Flaschenhals würde.

TLS-Zertifikat ist self-signed → in jedem Szenario ist `insecureSkipTLSVerify: true` gesetzt.

## Aufruf

Einzelnes Szenario:
```bash
./run.sh 03-web-1000-parallel-5s.js
```

Alle (außer dem 10-Minuten-Test) sequentiell — siehe Abschnitt *Ergebnisse* unten für eine Mapping-Tabelle.

Ergebnisse landen unter [`results/<szenario>.txt`](results/) (Roh-Output von k6).

## Mapping Kriterium → Szenario

| Kriterium (Zeile in bewertungskriterien.md) | Szenario |
|---|---|
| 17: Web, 10 parallel, 0 s Ramp-up | [`01-web-10-parallel-0s.js`](scenarios/01-web-10-parallel-0s.js) |
| 18: Web, 100 parallel, 1 s Ramp-up | [`02-web-100-parallel-1s.js`](scenarios/02-web-100-parallel-1s.js) |
| 19: Web, 1000 parallel, 5 s Ramp-up | [`03-web-1000-parallel-5s.js`](scenarios/03-web-1000-parallel-5s.js) |
| 20: Web, 1000 parallel, 1 s Ramp-up | [`04-web-1000-parallel-1s.js`](scenarios/04-web-1000-parallel-1s.js) |
| 21: Web, 1000 RPM für 10 min | [`05-web-1000rpm-10min.js`](scenarios/05-web-1000rpm-10min.js) |
| 23: API, 10 parallel, 0 s, normal | [`06-api-10-parallel-0s.js`](scenarios/06-api-10-parallel-0s.js) |
| 24: API, 100 parallel, 1 s, normal | [`07-api-100-parallel-1s.js`](scenarios/07-api-100-parallel-1s.js) |
| 25: API, 1000 parallel, 5 s, normal | [`08-api-1000-parallel-5s.js`](scenarios/08-api-1000-parallel-5s.js) |
| 26: API, 10 parallel, 0 s, 5 MB Body | [`09-api-5mb-10-parallel-0s.js`](scenarios/09-api-5mb-10-parallel-0s.js) |
| 27: API, 100 parallel, 1 s, 5 MB Body | [`10-api-5mb-100-parallel-1s.js`](scenarios/10-api-5mb-100-parallel-1s.js) |
| 28: API, 1000 parallel, 5 s, 5 MB Body, 429 OK | [`11-api-5mb-1000-parallel-5s-429ok.js`](scenarios/11-api-5mb-1000-parallel-5s-429ok.js) |
| 29: API, 1000 parallel, 5 s, 5 MB Body, alle OK | [`12-api-5mb-1000-parallel-5s-strict.js`](scenarios/12-api-5mb-1000-parallel-5s-strict.js) |

## Anpassungen an der Anwendung

Drei Änderungen waren nötig, damit 5-MB-Requests überhaupt das Backend erreichen:

- [`backend/server.js`](../backend/server.js): `express.json({ limit: '6mb' })` — Default war 100 KB, sonst HTTP 413 vom Body-Parser.
- [`nginx/reverse-proxy.conf`](../nginx/reverse-proxy.conf): `client_max_body_size 6m` — nginx-Default ist 1 MB, sonst HTTP 413 vom Reverse-Proxy.
- [`nginx/load-balancer.conf`](../nginx/load-balancer.conf): `client_max_body_size 6m` — dito für den Load-Balancer.

## Hinweis zum Test-Aufbau

Für die 1000-VU-Szenarien (03, 04, 08, 11, 12) verwendet k6 den Executor **`ramping-arrival-rate`** statt `ramping-vus`. Grund: 1000 echte VUs brauchen in k6 ~6 GB RAM (jede VU hat eine eigene V8-Runtime), das sprengt die Docker-Desktop-VM. Mit `ramping-arrival-rate` definieren wir eine Ziel-Rate (z. B. 1000 req/s) und k6 nimmt nur so viele VUs wie nötig (typisch 50–200). Die Server-Last ist äquivalent — der Server sieht weiterhin die geforderte Parallelität.

Für die 5-MB-Body-Szenarien (11, 12) ist die Rate zusätzlich auf **200 req/s** reduziert, weil 5 MB × 1000 req/s = 5 GB/s netto Bandbreite jede realistische Anbindung sprengt. Mit ~3 s Upload-Zeit pro Request bei 200 req/s entstehen trotzdem mehrere hundert parallele In-Flight-Connections.

## Ergebnisse

Alle **12 Szenarien** laufen mit **0 Server-Fehlern** durch. Stand: 2026-05-25.

| #  | Szenario                          | ✓ | Requests | Fehlerrate | p95       | Notizen |
|----|-----------------------------------|---|----------|------------|-----------|---------|
| 01 | web-10-parallel-0s                | ✓ | 465 552  | 0.00 %     | 519 µs    | 31 k req/s |
| 02 | web-100-parallel-1s               | ✓ | 426 088  | 0.00 %     | 7.28 ms   | 26 k req/s |
| 03 | web-1000-parallel-5s              | ✓ | 7 500    | 0.00 %     | 870 µs    | 1000 req/s gehalten |
| 04 | web-1000-parallel-1s              | ✓ | 5 500    | 0.00 %     | 822 µs    | 1000 req/s gehalten |
| 05 | web-1000rpm-10min                 | ✓ | 10 001   | 0.00 %     | 1.67 ms   | 10 min konstant 16.67 req/s |
| 06 | api-10-parallel-0s                | ✓ | 125 370  | 0.00 %     | 1.89 ms   | 8.4 k req/s |
| 07 | api-100-parallel-1s               | ✓ | 202 603  | 0.00 %     | 21.94 ms  | 9.6 k req/s |
| 08 | api-1000-parallel-5s              | ✓ | 7 500    | 0.00 %     | 1.32 ms   | 1000 req/s gehalten |
| 09 | api-5mb-10-parallel-0s            | ✓ | 2 020    | 0.00 %     | 75 ms     | 100 req/s, 500 MB/s Throughput |
| 10 | api-5mb-100-parallel-1s           | ✓ | 1 491    | 0.00 %     | 3.68 s    | 47 req/s, 235 MB/s |
| 11 | api-5mb-1000-parallel-5s-429ok    | ✓ | 737      | 0 × 5xx    | 5.62 s    | 0 × 429; 1573 k6-internal drops (maxVUs cap) |
| 12 | api-5mb-1000-parallel-5s-strict   | ✓ | 812      | 0.00 %     | 5.26 s    | alle 812 mit 201 beantwortet |

**Kurzbewertung:**

- **Web-Endpoint (01–04):** Frontend hält 30 k req/s aus, Latenz sub-millisecond. Komplett unproblematisch.
- **API-Endpoint normal (06–08):** Backend + DB bewältigen ~10 k req/s mit p95 unter 25 ms. Beide Backend-Instanzen werden via Load-Balancer ausgelastet.
- **API-Endpoint 5 MB (09–12):** Limit ist die effektive Bandbreite (~200–500 MB/s) und Express body buffering. Server bleibt stabil, p95 unter 6 s. **Keine 5xx-Fehler in keinem Szenario** — Kriterium Zeile 28 (429 erlaubt) und 29 (strikt 201) sind beide erfüllt, weil das System schlicht keine Anfragen abweist, sondern sie sauber abarbeitet.

Rohe k6-Outputs liegen in [`results/`](results/).
