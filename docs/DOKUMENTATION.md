# Dokumentation – IT-Infrastruktur Förderverein

**Belegarbeit · Stand: 2026-05-31**
Autor: Max
Code: [Repository-Root](../)
Kurzanleitung: [`README.md`](../README.md)

---

## Inhaltsverzeichnis

1. [Einleitung & Projektkontext](#1-einleitung--projektkontext)
2. [Architektur-Überblick](#2-architektur-überblick)
3. [Inbetriebnahme](#3-inbetriebnahme)
4. [Komponenten im Detail](#4-komponenten-im-detail)
5. [API-Referenz](#5-api-referenz)
6. [Verfügbarkeit & Skalierung](#6-verfügbarkeit--skalierung)
7. [Monitoring & Alerting](#7-monitoring--alerting)
8. [Sicherheit](#8-sicherheit)
9. [Backup & Recovery](#9-backup--recovery)
10. [Lasttests](#10-lasttests)
11. [Mapping Bewertungskriterien → Umsetzung](#11-mapping-bewertungskriterien--umsetzung)
12. [Anhang](#12-anhang)

---

## 1. Einleitung & Projektkontext

### 1.1 Aufgabenstellung

Die Belegarbeit verlangt eine containerisierte IT-Infrastruktur für die Website eines fiktiven Fördervereins, die

- über `docker compose up` reproduzierbar startbar ist,
- die in [`bewertungskriterien.md`](bewertungskriterien.md) aufgelisteten Lasttest-Szenarien aushält,
- Ausfälle einzelner Komponenten kompensiert oder zumindest sichtbar macht,
- gängige Sicherheitsmaßnahmen umsetzt (Netzsegmentierung, TLS, Secrets, Capability-Reduktion, WAF, CVE-Freiheit),
- ein automatisches Datenbank-Backup besitzt.

Die fachliche Anwendung ist bewusst klein gehalten: eine statische Vereins-Website mit zwei Formular-Endpunkten (Mitgliedsantrag, Spende). Den Großteil der Arbeit macht das Drumherum – Replikation, Reverse-Proxy mit WAF, Monitoring-Stack, Backups und die Härtung der Container.

### 1.2 Zielsetzung der Infrastruktur

Drei Eigenschaften standen im Vordergrund:

| Eigenschaft | Bedeutung in diesem Projekt |
|---|---|
| **Verlässlichkeit unter Last** | Endpunkte halten 1000 parallele Anfragen ohne Server-Fehler aus (siehe [Lasttests](#10-lasttests)). |
| **Erkennbarkeit von Problemen** | Jeder Ausfall – Container, DB, HTTP-Probe, hohe CPU/RAM – löst innerhalb von Sekunden einen Alert aus, der per Webhook sichtbar gemacht wird. |
| **Reduzierte Angriffsfläche** | Read-only-Dateisysteme, `cap_drop: ALL`, Docker-Secrets statt Env-Variablen, WAF vor jedem Request, 0 HIGH/CRITICAL CVEs in den eigenen Images. |

### 1.3 Aufbau dieses Dokuments

Kapitel 2 gibt den Überblick (Stack, Netze, Datenfluss), Kapitel 3 zeigt die Inbetriebnahme. Kapitel 4–9 beschreiben jede Komponente detailliert mit ihrer Begründung. Kapitel 10 dokumentiert die Lasttests. Kapitel 11 ist eine Mapping-Tabelle Bewertungskriterium → Umsetzung → Beleg-Stelle in dieser Doku – sie ist das schnellste Werkzeug zur Prüfung der Vollständigkeit.

---

## 2. Architektur-Überblick

### 2.1 Stack

| Schicht | Technologie | Bild / Quelle |
|---|---|---|
| Reverse Proxy + WAF | Nginx + ModSecurity (OWASP CRS 4.29) | `owasp/modsecurity-crs:4.29.0-nginx-alpine-202609301109` |
| Frontend (statisch) | Nginx | eigenes Image, Base `nginx:1.31.6-alpine` |
| Load Balancer | Nginx (Round-Robin) | `nginx:1.31.6-alpine` |
| Backend | Node.js 22 (LTS) / Express | eigenes Image, Base `node:22-alpine` |
| Datenbank | PostgreSQL 17 | eigenes Image, Base `postgres:17-alpine` (mit neu kompiliertem `gosu`) |
| Metriken | Prometheus | `prom/prometheus:v3.15.0` |
| Dashboards & Alerts | Grafana | `grafana/grafana:13.2.3` |
| Container-Metriken | cAdvisor | `gcr.io/cadvisor/cadvisor:v0.55.1` |
| Nginx-Metriken | nginx-prometheus-exporter | `nginx/nginx-prometheus-exporter:1.5.0` |
| Postgres-Metriken | postgres-exporter | `prometheuscommunity/postgres-exporter:v0.20.1` |
| HTTP-Probes | blackbox-exporter | `prom/blackbox-exporter:v0.28.0` |
| Alert-Empfänger | http-echo-Webhook | `mendhak/http-https-echo:42` |
| DB-Backup | `pg_dump` in Loop-Skript | `postgres:17.11-alpine` (Sidecar) |

Insgesamt **15 Services**, davon 3 eigene Images (Backend für `backend-1`/`backend-2`, Frontend für `frontend`/`frontend-2`, `database`).

**Feste Versionen statt `:latest`:** Alle Drittanbieter-Images sind auf eine exakte Version gepinnt. Ein `docker compose pull` liefert damit immer denselben Stand, und die Trivy-Ergebnisse beziehen sich auf genau die Images, die laufen. Wie wichtig das ist, zeigte Grafana: `:latest` war unbemerkt auf Version 13 gesprungen, die beim Start Plugins nachinstallieren will (siehe [§ 7.2](#72-grafana-dashboards)). Updates sind damit eine bewusste Änderung an `docker-compose.yml`. Die Base-Images der eigenen Images sind auf die Major-Version gepinnt (`node:22-alpine`, `postgres:17-alpine`) bzw. auf die exakte Version (`nginx:1.31.6-alpine`); `apk upgrade` beim Build spielt Sicherheitsupdates der Alpine-Pakete ein (siehe [§ 8.6](#86-sicherheitsscan-trivy)).

### 2.2 Netzwerksegmentierung

Drei Docker-Netze trennen die Schichten:

| Netzwerk | `internal` | Mitglieder |
|---|---|---|
| `public-net` | nein | `reverse-proxy`, `load-balancer`, `frontend`, `frontend-2`, `grafana`, `nginx-exporter`, `blackbox-exporter` |
| `internal-net` | **ja** | `load-balancer`, `backend-1`, `backend-2`, `database`, `db-backup`, `postgres-exporter`, `prometheus`, `blackbox-exporter` |
| `monitoring-net` | nein | `prometheus`, `grafana`, `cadvisor`, `nginx-exporter`, `postgres-exporter`, `webhook-logger` |

**Begründung der drei Netze:**

- **`internal-net` ist `internal: true`** — Container in diesem Netz haben *keine* eigene Default-Route ins Internet. Selbst wenn ein Backend kompromittiert würde, könnte es nicht direkt nach außen telefonieren. Das ist die wichtigste Single-Netz-Maßnahme dieses Projekts.
- **Trennung Public / Internal** — Nur Reverse-Proxy und Load-Balancer haben einen Fuß in beiden Welten. Der Load-Balancer ist die einzige Brücke zwischen Public-Traffic und Backend-Pool; Backend und Datenbank sind aus dem Internet nicht direkt erreichbar.
- **Monitoring-Netz separat** — Grafana muss Prometheus erreichen, Prometheus muss alle Exporter erreichen, aber nichts davon braucht Internet. Dass `prometheus` auch im `internal-net` hängt, ist nötig, damit es Backend und postgres-exporter scrapen kann. `grafana` hängt zusätzlich im `public-net`, damit der Reverse-Proxy die Oberfläche unter `/grafana/` über HTTPS ausliefern kann; einen eigenen Host-Port hat Grafana nicht.

### 2.3 Datenfluss eines Requests

```
Browser (HTTPS, 443)
   │
   ▼
reverse-proxy   ── TLS-Terminierung, ModSecurity WAF (OWASP CRS)
   │                ├─ /             → frontend_upstream (Round-Robin frontend, frontend-2)
   │                ├─ /api/         → api_upstream (load-balancer)
   │                └─ /health       → api_upstream/health
   ▼
load-balancer (Nginx Round-Robin, passive Healthchecks, proxy_next_upstream)
   │
   ▼
backend-1 / backend-2 (Express)
   │
   ▼
database (PostgreSQL 17)
```

Parallel dazu scraped Prometheus alle 15 s die Exporter und das `/metrics`-Endpoint der Backends; Grafana liest aus Prometheus und feuert Alerts gegen den `webhook-logger`.

---

## 3. Inbetriebnahme

> Detailangaben siehe [`README.md`](../README.md). Dieses Kapitel ergänzt sie um die Hintergrundbegründungen.

### 3.1 Voraussetzungen

- Docker Desktop ≥ aktuelle Version, Docker Compose V2.
- **Docker-Desktop-Memory mindestens 6 GB** (Settings → Resources → Memory). Die 1000-VU-Lasttests brauchen sonst mehr RAM als die Docker-VM hergibt; k6 wird OOM-gekillt.
- Keine weiteren Host-Installationen — k6, Trivy, Postgres-Client laufen alle als Docker-Container.

### 3.2 Secrets anlegen

Vor dem ersten `docker compose up`:

```powershell
mkdir secrets
[System.IO.File]::WriteAllText("secrets\postgres_password.txt",       "DeinPostgresPasswort", [System.Text.Encoding]::ASCII)
[System.IO.File]::WriteAllText("secrets\grafana_admin_password.txt",  "DeinGrafanaPasswort",  [System.Text.Encoding]::ASCII)
```

**Warum `[System.IO.File]::WriteAllText` statt `echo > datei`?**
PowerShell schreibt mit `>` standardmäßig UTF-16-LE mit BOM. PostgreSQL liest seine Passwortdatei aber als reinen Byte-Stream — eine BOM landet als erstes Zeichen im Passwort, und `initdb` schlägt mit kryptischer Fehlermeldung fehl. Die explizite ASCII-Schreibmethode vermeidet das. Auf Linux/macOS reicht `printf 'pw' > secrets/postgres_password.txt`.

`secrets/` ist in `.gitignore` und wird nicht versioniert.

### 3.3 Start

```bash
# im Projektverzeichnis (Repository-Root)
docker compose up --build -d
```

Beim ersten Start passiert intern:

1. Alle Images werden gebaut (Backend, Frontend, Database — jeweils Multi-Stage).
2. `database` startet und führt `db/init.sql` aus (legt Schema, Indizes, Trigger an).
3. Sobald `pg_isready` erfolgreich antwortet, startet `backend-1/2` (via `depends_on: condition: service_healthy`).
4. Sobald die Backends ihren `/health`-Endpunkt erfolgreich beantworten, startet der `load-balancer`.
5. Sobald `frontend`, `frontend-2` und `load-balancer` healthy sind, startet der `reverse-proxy` (WAF + TLS).
6. Der Monitoring-Stack startet parallel zur App-Kette: `grafana` wartet auf ein gesundes `prometheus`, `nginx-exporter` auf einen gesunden `reverse-proxy`, `postgres-exporter` und `db-backup` auf eine gesunde `database`.

Nach ~60 s sind alle Container `healthy` (Übersicht der Healthchecks: [§ 7.5](#75-healthchecks-und-start-reihenfolge)).

### 3.4 Verifikation

```bash
docker compose ps                              # alle Services sollten "healthy" zeigen
curl -k https://localhost/health               # {"status":"healthy","db":"connected",...}
curl -kI https://localhost/                    # 200, statische Website
open https://localhost/                        # macOS: Browser
```

Browser zeigt Zertifikatswarnung (self-signed). Einmalig „Erweitert → Trotzdem fortfahren".

### 3.5 Stoppen

```bash
docker compose down       # behält Volumes
docker compose down -v    # löscht db-data, prometheus-data, grafana-data, db-backups
```

---

## 4. Komponenten im Detail

### 4.1 Reverse Proxy (`reverse-proxy`)

**Image:** `owasp/modsecurity-crs:nginx-alpine`
**Aufgaben:** TLS-Terminierung · WAF · HTTP→HTTPS-Redirect · Routing nach Pfad
**Config:** [`nginx/reverse-proxy.conf`](../nginx/reverse-proxy.conf)

Architektonisch der einzige Container, der Ports an den Host bindet (`80:80`, `443:443`). Alle anderen Services sind nur containerintern erreichbar — das erfüllt das Kriterium „keine unnötigen Ports exponiert". Auch Grafana läuft über diesen Container (`/grafana/`).

**Wichtige Entscheidungen:**

- **TLS nur am Reverse-Proxy**, intern HTTP. Bei einem Single-Host-Compose-Setup gibt es keinen Pfad, auf dem ein Angreifer den internen Traffic mitlesen könnte, ohne bereits Container-Zugriff zu haben. Interne mTLS wäre Selbstzweck.
- **WAF nur auf 443.** Auf Port 80 läuft nur der `301`-Redirect und ein Health-Check; dort ist ModSecurity überflüssig und würde die Redirect-Latenz erhöhen.
- **`client_max_body_size 6m`** — sonst lehnt Nginx 5-MB-Lasttest-Bodies mit HTTP 413 ab, bevor das Backend sie sieht (Default ist 1 MB). Die 6 statt 5 MB sind Puffer für Form-Boundaries und Header.
- **PID-Datei nach `/tmp/nginx.pid`.** Das Image braucht beim Start einen schreibbaren Pfad für die PID; per Default `/run/nginx.pid`, das aber im Read-only-Mount unter `tmpfs:` separat behandelt werden müsste. Verschieben in das ohnehin schon getmpfste `/tmp` ist die einfachere Lösung.
- **Template-Mount statt fixer Config.** Das Image rendert beim Start `/etc/nginx/templates/*.template` über `envsubst` nach `/etc/nginx/`. Direktes Überschreiben von `/etc/nginx/nginx.conf` würde mit dem Container-Init-Script kollidieren.
- **Namen zur Laufzeit auflösen (`resolver 127.0.0.11` + `resolve`).** Ohne `resolve` löst nginx `frontend`, `frontend-2` und `load-balancer` nur einmal beim Start auf. Wird ein Container neu erstellt (z. B. durch `docker compose up --build`), bekommt er oft eine neue IP, und nginx schickt weiter an die alte Adresse. Mit `resolve` fragt nginx den Docker-DNS laufend neu ab.

**Healthcheck:** `wget -qO- http://localhost:80/rp-health` — separater Endpunkt, der direkt aus Nginx antwortet (ohne Proxy-Weiterleitung). Wäre `/` der Health-Check, würde ein Backend-Ausfall den Reverse-Proxy fälschlich als ungesund markieren.

### 4.2 Frontend (`frontend`, `frontend-2`)

**Image:** eigenes, Base `nginx:alpine`
**Inhalt:** statisches HTML/CSS aus [`frontend/html/`](../frontend/html/) (`index.html`, `mitglied-werden.html`, `spenden.html`, `style.css`, Logo)
**Replikation:** 2 Instanzen, vom Reverse-Proxy via Round-Robin angesprochen.

**Begründung für zwei statt einer Instanz:** Erfüllt das Kriterium „Ausfall eines Webservers für das Frontend beeinflusst nicht die Verfügbarkeit". Bei zwei Instanzen kann eine entfernt werden (`docker compose stop frontend`) und der Reverse-Proxy leitet automatisch alle Requests an `frontend-2` weiter (passive Healthchecks via `max_fails=3 fail_timeout=10s`).

### 4.3 Load Balancer (`load-balancer`)

**Image:** `nginx:1.31.6-alpine`
**Aufgaben:** Round-Robin-Verteilung auf `backend-1` und `backend-2`, Fail-Fast-Timeouts, automatisches Re-Routing bei Backend-Fehlern.
**Config:** [`nginx/load-balancer.conf`](../nginx/load-balancer.conf)

```nginx
resolver 127.0.0.11 valid=10s ipv6=off;

upstream backends {
    zone backends 64k;
    server backend-1:3000 resolve max_fails=3 fail_timeout=30s;
    server backend-2:3000 resolve max_fails=3 fail_timeout=30s;
}
```

**Wichtige Direktiven:**

| Direktive | Wert | Begründung |
|---|---|---|
| `max_fails=3 fail_timeout=30s` | passive HC | Fällt ein Backend 3× in 30 s aus, wird es 30 s aus der Rotation genommen — verhindert, dass jeder Request während eines Crashes erst in einen Timeout läuft. |
| `proxy_connect_timeout 5s` | Fail-Fast | Standard ist 60 s. Bei einem hängenden Backend würden Clients sonst 60 s auf den ersten Byte-Output warten. |
| `proxy_read_timeout 10s` | Fail-Fast | Begrenzt die Wartezeit auf eine Antwort. |
| `resolve` + `resolver 127.0.0.11` | DNS zur Laufzeit | Die Backend-Namen werden laufend neu aufgelöst. Getestet: Nach `docker compose up --force-recreate backend-1 backend-2` hatten die Backends ihre IPs getauscht, und 60/60 Requests liefen ohne Neustart des Load-Balancers durch. |
| `proxy_next_upstream error timeout http_502 http_504` | aktive Failover | Bei genau diesen Fehlern wird der Request automatisch am nächsten Backend nochmal versucht — der Client merkt vom Ausfall einer Instanz nichts. **Bewusst ohne `http_503`:** Ein Backend antwortet nur mit 503, wenn die Datenbank fehlt, und das betrifft alle Backends gleich. Mit `http_503` würde nginx beide Backends als defekt sperren und `502 no live upstreams` liefern statt der eigentlichen Ursache `503 {"db":"disconnected"}`. |

**Warum Round-Robin und nicht `least_conn`?** Beide Backends sind identisch, die Requests sehr kurzlebig (DB-Insert oder `SELECT 1`). Round-Robin ist deterministisch und im Verhalten leichter zu debuggen.

### 4.4 Backend (`backend-1`, `backend-2`)

**Image:** eigenes, Base `node:22-alpine` (Multi-Stage)
**Code:** [`backend/server.js`](../backend/server.js) (~130 Zeilen)
**Dependencies:** `express`, `pg`, `prom-client`

**Verantwortlichkeiten:**

1. `/health` → DB-Ping (`SELECT 1`) + Process-Uptime.
2. `/metrics` → Prometheus-Format (Default-Node-Metriken + `http_request_duration_seconds`-Histogram).
3. `POST /api/mitglieder` → INSERT in `mitglieder`, Konflikt-Handling für duplikate E-Mails (PG-Errorcode `23505`).
4. `POST /api/spenden` → INSERT in `spenden`, Validierung `betrag_cent` als positive Ganzzahl.
5. Ungültige Eingaben, die erst die Datenbank erkennt (Fehlerklasse `22xxx`, z. B. `22001` Text zu lang, `22007` ungültiges Datum, `22003` Zahl außerhalb des Wertebereichs, sowie `23514` CHECK-Verletzung), werden als `400 Bad Request` beantwortet statt als `500`. Sonst würde das Frontend fälschlich „Datenbankfehler" melden.

**Wichtige Entscheidungen:**

- **Passwort via Docker Secret, nicht ENV:** `POSTGRES_PASSWORD_FILE=/run/secrets/postgres_password` wird gelesen via `fs.readFileSync(...)` beim Start. `docker inspect` zeigt nur den Dateipfad, nie das Passwort.
- **`express.json({ limit: '6mb' })`:** Default wäre 100 KB. Das Lasttest-Szenario 12 schickt 5 MB Bodies; ohne diese Anhebung würde Express mit HTTP 413 antworten, der Test käme nie an die DB.
- **Connection-Pool aus `pg`:** Default ist max 10 parallele Connections. Pro Backend-Instanz × 2 Backends = max. 20 parallele DB-Connections. Bei 1000 parallelen Lasttest-VUs werden die Pool-Slots geteilt — die DB sieht also nie 1000 gleichzeitige Verbindungen, sondern 20.
- **Eigenes Histogram statt nur Default-Metriken:** Erlaubt Latenz-Panels in Grafana per Pfad/Status-Code aufzuschlüsseln. Default-Metriken liefern nur Node-interne Werte (Heap, GC, etc.).
- **Verbindungsabbrüche im DB-Pool abfangen:** Stoppt die Datenbank, meldet der `pg`-Pool für seine ruhenden Verbindungen ein `error`-Event. Ohne Handler (`pool.on('error', ...)`) stürzte Node daran ab: Bei einem DB-Ausfall crashten beide Backends, das Frontend zeigte „Wartungsarbeiten" statt „Datenbankfehler", und zusätzlich feuerte „Backend ausgefallen". Jetzt wird der Fehler nur geloggt; `/health` antwortet mit 503, die API mit 500, und nach dem Neustart der DB geht es ohne Backend-Neustart weiter.
- **Kein root im Container:** Das Image setzt `USER node` (UID 1000, im offiziellen Image vorhanden). Die App-Dateien gehören root und sind für `node` nur lesbar; zusammen mit `read_only: true` und `cap_drop: ALL` kann ein kompromittierter Prozess weder Code ändern noch Rechte erlangen.
- **Sauberes Herunterfahren:** `init: true` startet `tini` als PID 1, das Signale weiterreicht. `server.js` reagiert auf `SIGTERM`: keine neuen Verbindungen, laufende Requests beenden, DB-Pool schließen. `docker stop backend-1` dauert so ~0,1 s statt der 10 s bis zum `SIGKILL`, und kein Request bricht mitten in einem INSERT ab.

**Healthcheck:** `wget -qO- http://localhost:3000/health` — `/health` selbst pingt die DB, der Healthcheck deckt also die End-to-End-Erreichbarkeit ab.

### 4.5 Datenbank (`database`)

**Image:** eigenes, Base `postgres:17-alpine`, **mit neu kompiliertem `gosu`-Binary** (siehe [§ 8.6 Trivy](#86-sicherheitsscan-trivy)).
**Init:** [`db/init.sql`](../db/init.sql) wird beim ersten Start automatisch ausgeführt (Convention `/docker-entrypoint-initdb.d/`).
**Schema:** [`datenbankschema.md`](datenbankschema.md)

**Tabellen:** `mitglieder` (Mitgliedsanträge), `spenden` (Spendeneingänge mit FK auf `mitglieder.id`, NULL erlaubt für anonyme Spenden).

**Design-Highlights:**

- **Geldbeträge als `INT` (Cent)**, niemals `FLOAT` — vermeidet Rundungsfehler.
- **`UNIQUE`-Constraint auf `email`**: doppelte Mitgliedsanträge geben einen klar erkennbaren Fehler (`23505`), den das Backend in HTTP `409 Conflict` übersetzt.
- **`UNIQUE`-Constraint auf `transaktions_id`**: macht Spenden-Webhooks idempotent — zahlt der Zahlungsanbieter zweimal aus, schreibt die DB nur einmal.
- **Trigger `set_aktualisiert_am`** pflegt automatisch `aktualisiert_am` bei `UPDATE mitglieder`.

**Persistenz:** Volume `db-data` auf `/var/lib/postgresql/data`. Überlebt `docker compose down`, wird durch `docker compose down -v` gelöscht.

### 4.6 Monitoring-Stack

Siehe [§ 7 Monitoring & Alerting](#7-monitoring--alerting) für die Inhalte; hier nur die Komponenten-Übersicht:

| Service | Aufgabe |
|---|---|
| `prometheus` | Scraped alle 15 s die Targets aus [`monitoring/prometheus.yml`](../monitoring/prometheus.yml). |
| `grafana` | Liest Prometheus, zeigt Dashboards, führt Alert-Rules aus. |
| `cadvisor` | Container-Metriken (CPU, RAM, Netzwerk, Disk pro Container). |
| `nginx-exporter` | Übersetzt `stub_status` des Reverse-Proxy nach Prometheus-Format. |
| `postgres-exporter` | Übersetzt Postgres-`SHOW`/`pg_stat_*` nach Prometheus-Format (Connections, Query-Counts, etc.). |
| `blackbox-exporter` | HTTP-Probes (200/Connect-Time) gegen `frontend`, `frontend-2`, Load-Balancer, Reverse-Proxy. |
| `webhook-logger` | Loggt eingehende Alert-Webhooks von Grafana zur Verifikation (Demo-Empfänger). |

---

## 5. API-Referenz

Alle Endpunkte sind unter `https://localhost/api/` erreichbar (durch Reverse-Proxy mit WAF und TLS).

### 5.1 `GET /health`

Prüft Backend + DB-Verbindung. Wird sowohl von außen (Browser/Curl), als auch von Docker-Healthchecks und Prometheus-Blackbox-Probes verwendet.

```bash
curl -k https://localhost/health
```

| Status | Bedeutung |
|---|---|
| `200 OK` | Backend lebt und DB antwortet. |
| `503 Service Unavailable` | DB-Connection schlägt fehl. |

```json
{ "status": "healthy", "db": "connected", "uptime": 42.3 }
```

### 5.2 `POST /api/mitglieder`

Legt einen Mitgliedsantrag an. Pflichtfelder: `vorname`, `nachname`, `email`.

```bash
curl -k -X POST https://localhost/api/mitglieder \
  -H "Content-Type: application/json" \
  -d '{"vorname":"Max","nachname":"Mustermann","email":"max@example.com"}'
```

| Status | Bedeutung |
|---|---|
| `201 Created` | Antrag gespeichert. Antwort: `{ "id": <int> }`. |
| `400 Bad Request` | Pflichtfeld fehlt oder Eingabe ungültig (z. B. Datumsformat, Feldlänge). |
| `409 Conflict` | E-Mail bereits registriert (`UNIQUE`-Constraint). |
| `500` | Interner Fehler (DB nicht erreichbar etc.). |

### 5.3 `POST /api/spenden`

Speichert eine Spende. Pflichtfeld: `betrag_cent` (positive Ganzzahl).

```bash
curl -k -X POST https://localhost/api/spenden \
  -H "Content-Type: application/json" \
  -d '{"spender_name":"Erika","betrag_cent":2500,"zweck":"Jugendarbeit"}'
```

| Status | Bedeutung |
|---|---|
| `201 Created` | `{ "id": <int> }` |
| `400` | `betrag_cent` fehlt, ist keine positive Ganzzahl oder liegt außerhalb des Wertebereichs; oder ein anderes Feld ist ungültig (z. B. zu lang). |
| `500` | Interner Fehler. |

### 5.4 `GET /metrics`

Liefert Prometheus-Metriken im Text-Format. Wird nicht öffentlich ausgewiesen, ist aber containerintern auf `backend-1:3000/metrics` und `backend-2:3000/metrics` erreichbar — Prometheus scraped beide.

---

## 6. Verfügbarkeit & Skalierung

Die Bewertungskriterien (Block „Verfügbarkeit", 6 Punkte) verlangen sechs konkrete Fähigkeiten. Jede wird hier mit ihrer Umsetzung dokumentiert.

### 6.1 Ausfall eines Frontend-Webservers ohne Verfügbarkeitsverlust

**Umsetzung:** Zwei identische Frontend-Container (`frontend`, `frontend-2`), beide unter dem `frontend_upstream`-Block des Reverse-Proxy in [`nginx/reverse-proxy.conf`](../nginx/reverse-proxy.conf) mit `max_fails=3 fail_timeout=10s`. Fällt einer aus, antwortet der andere — der Reverse-Proxy macht passives Failover.

**Verifikation:**
```bash
docker compose stop frontend
curl -k https://localhost/   # liefert weiter 200
```

### 6.2 Backend-Ausfall im Monitoring sichtbar

**Umsetzung:** Grafana-Alert-Regel **„Backend ausgefallen"** (Folder `Backend`, Interval 10 s) auf der PromQL-Query `up{job="backend"}`. Bei Wert `< 1` für ≥ 20 s feuert der Alert an den `webhook-logger`.

Konfiguration: [`monitoring/grafana/provisioning/alerting/rules.yaml`](../monitoring/grafana/provisioning/alerting/rules.yaml).

### 6.3 Frontend zeigt bei Backend-Ausfall passende Fehlermeldung

**Umsetzung:** Die Formulare auf [`mitglied-werden.html`](../frontend/html/mitglied-werden.html) und [`spenden.html`](../frontend/html/spenden.html) werten den HTTP-Status der `fetch`-Antwort aus und zeigen statt eines Browser-Fehlers eine passende Meldung. Sind beide Backends nicht erreichbar, antwortet der Load-Balancer mit `502 Bad Gateway`, bei Zeitüberschreitung (`proxy_read_timeout 10s`) mit `504 Gateway Timeout`. Beide Status führen zur Meldung:

> „Wartungsarbeiten: Unser System ist aktuell nicht erreichbar. Bitte versuchen Sie es später noch einmal."

Ist schon die Verbindung zum Server nicht möglich (`fetch` wirft eine Exception), erscheint „Verbindungsfehler. Bitte prüfen Sie Ihre Internetverbindung."

### 6.4 Datenbank-Ausfall im Monitoring sichtbar

**Umsetzung:** Grafana-Alert-Regel **„Datenbank ausgefallen"** (Folder `DB`, Interval 10 s) auf `pg_up{job="postgres"}`. Bei `< 1` für ≥ 20 s feuert der Alert.

### 6.5 Frontend zeigt bei DB-Ausfall passende Fehlermeldung

**Umsetzung:** Backend `/health` antwortet bei DB-Verlust mit `503` (`db: "disconnected"`). Bei Schreib-Endpunkten (`POST /api/...`) wird der Insert-Fehler abgefangen und als `500 { error: "Interner Serverfehler" }` an das Frontend zurückgegeben. Bei `500` oder `503` zeigt das Frontend:

> „Datenbankfehler: Ihre Anfrage konnte aktuell nicht gespeichert werden. Bitte haben Sie etwas Geduld."

Eingabefehler, die erst die Datenbank erkennt (ungültiges Datum, zu langer Text), lösen diese Meldung **nicht** aus: Das Backend beantwortet sie mit `400` (siehe [§ 4.4](#44-backend-backend-1-backend-2)), und das Formular zeigt einen Hinweis, die Eingaben zu prüfen.

### 6.6 Horizontale Skalierung (Scale-Out)

**Umsetzung:** Stateless-Backend ermöglicht `docker compose up --scale backend-1=N`. Sauberer wäre eine separate `backend`-Definition ohne harten Container-Namen — die aktuellen `container_name: backend-1/-2`-Einträge verhindern beliebige Replicas. Für den Nachweis reicht das manuelle Hochfahren weiterer Instanzen, die der Load-Balancer durch sein `upstream`-Block erreichen kann (Erweiterung um `backend-3:3000` etc.).

> **Hinweis:** Die aktuelle Compose-Datei nutzt feste `container_name`-Einträge und ein YAML-Anchor (`&backend`) für die Backend-Duplizierung. Für „echtes" Scale-Out per Compose müsste der `container_name` entfernt und das Backend als einzelner Service mit `deploy.replicas` oder `--scale` ausgerollt werden.

### 6.7 Automatischer Container-Restart

**Umsetzung:** Jeder Service hat `restart: unless-stopped` (auch der Demo-Empfänger `webhook-logger`). Crasht ein Container, startet Docker ihn automatisch neu. Healthcheck-Failures zählen nicht als Crash, lösen also keinen Restart aus — das ist gewollt, weil Self-Healing-Loops bei z. B. einer hängenden DB sonst die Symptome verschleiern.

### 6.8 Container-Resource-Limits

**Umsetzung:** Jeder Service hat in [`docker-compose.yml`](../docker-compose.yml) ein Limit unter `deploy.resources.limits`. Docker Compose v2 setzt diese Angaben auch **ohne Swarm** als cgroup-Limits um. Kontrolle: `docker stats` zeigt das Limit in der Spalte `MEM USAGE / LIMIT`, `docker inspect backend-1 --format '{{.HostConfig.Memory}}'` liefert `1073741824`.

| Service | CPU | RAM | gemessene Spitze unter Last | Begründung |
|---|---|---|---|---|
| `backend-1/2` | 1.0 | 1g | ~90 MiB | Node.js nutzt im Wesentlichen einen Kern; Puffer für mehrere parallele 5-MB-Bodies (Roh-Buffer + geparstes JSON) |
| `database` | 2.0 | 1g | ~100 MiB | kritischster Dienst, großzügig bemessen |
| `reverse-proxy` | 2.0 | 1g | ~200 MiB | ModSecurity hält Request-Bodies bis 6 MB zur Prüfung im Speicher |
| `load-balancer` | 1.0 | 512m | ~10 MiB | Body-Puffer von Nginx liegen im `tmpfs` (`/var/cache/nginx`) und zählen zum Container-RAM |
| `frontend(-2)` | 0.5 | 128m | ~13 MiB | rein statische Auslieferung |
| `grafana` | 1.0 | 768m | ~440 MiB | Spitze beim Start (Provisioning) |
| `prometheus` | 1.0 | 512m | ~120 MiB | wächst mit der Zahl der Zeitreihen |
| `cadvisor` | 0.5 | 256m | ~60 MiB | |
| `db-backup` | 0.5 | 256m | < 2 MiB | Puffer für `pg_dump` einer wachsenden DB |
| `postgres-exporter`, `webhook-logger` | 0.25 | 128m | ~25 / ~80 MiB | |
| `nginx-exporter`, `blackbox-exporter` | 0.25 | 64m | ~25 / ~30 MiB | |

Die Spitzenwerte stammen aus `docker stats` während der Lasttests 07, 09 und 10. Mit gesetzten Limits liefen 07 und 09 gleich schnell wie ohne Limits und ohne Fehler, es gab keine OOM-Kills und keine Restarts. Die Alert-Regel `RAM-Alert` (> 800 MB für > 1 min) schlägt bei Backend, Datenbank und Reverse-Proxy bei ~80 % des Limits an, also bevor der Kernel den Container per OOM-Kill beendet.

---

## 7. Monitoring & Alerting

### 7.1 Prometheus-Targets

Konfiguration: [`monitoring/prometheus.yml`](../monitoring/prometheus.yml). Scrape-Interval: **15 s**.

| Job | Targets | Was wird gemessen? |
|---|---|---|
| `cadvisor` | `cadvisor:8080` | CPU/RAM/Netzwerk pro Container |
| `nginx-exporter` | `nginx-exporter:9113` | Reverse-Proxy `stub_status` (active connections, requests/s) |
| `backend` | `backend-1:3000`, `backend-2:3000` | App-spezifische Metriken (Request-Histogram, Node-Defaults) |
| `prometheus` | `localhost:9090` | Selbst-Monitoring |
| `postgres` | `postgres-exporter:9187` | `pg_up`, Connections, Locks, Query-Counts |
| `blackbox` | HTTP-Probes auf `frontend`, `frontend-2`, `load-balancer`, `reverse-proxy` | End-to-End-Erreichbarkeit aus Sicht des Probers; jede Frontend-Instanz einzeln, damit auch der Ausfall nur einer Instanz auffällt |

### 7.2 Grafana-Dashboards

Auto-provisioniert aus [`monitoring/grafana/provisioning/dashboards/dashboard.json`](../monitoring/grafana/provisioning/dashboards/dashboard.json). Datenquelle (`prometheus`) ebenfalls über Provisioning gesetzt — kein manuelles Setup nach Grafana-Start nötig.

Login: <https://localhost/grafana/>, User `admin`, Passwort aus `secrets/grafana_admin_password.txt`.

Grafana hat keinen eigenen Host-Port. Der Reverse-Proxy liefert es unter `/grafana/` aus, also mit TLS und hinter der WAF (`GF_SERVER_ROOT_URL`, `GF_SERVER_SERVE_FROM_SUB_PATH`); das Session-Cookie ist als `Secure` markiert (`GF_SECURITY_COOKIE_SECURE`). Der Reverse-Proxy löst den Namen `grafana` erst zur Laufzeit über den Docker-DNS auf. So startet die Webanwendung auch dann, wenn Grafana nicht läuft.

**Kein Nachladen von Plugins (`GF_PLUGINS_PREINSTALL_DISABLED`):** Grafana 13 versucht beim Start, mitgelieferte Plugins aus dem Internet zu aktualisieren, darunter das Prometheus-Plugin. Wegen `read_only: true` scheitert das Löschen der alten Version, und Grafana meldet das Plugin danach ab. Folge: Jede Alert-Regel scheiterte mit `plugin not registered`, und die Dashboards blieben leer. Mit abgeschaltetem Nachladen nutzt Grafana die mitgelieferte Version; das passt auch zum Pinnen der Images (keine Code-Änderung zur Laufzeit).

> **Bekannte Limitation:** cAdvisor liefert auf Docker Desktop für Mac keine `name`-Labels, weshalb die CPU/RAM-Panels dort leer bleiben (und die CPU-/RAM-Alerts keine Daten haben, siehe [§ 7.3](#73-alert-regeln)). Auf Linux-Hosts funktioniert es. Workaround wäre ein anderer Container-Metrik-Sammler (z. B. `node-exporter` mit `--collector.cgroups`).

### 7.3 Alert-Regeln

Definiert in [`monitoring/grafana/provisioning/alerting/rules.yaml`](../monitoring/grafana/provisioning/alerting/rules.yaml). Alle Alerts gehen über die `policies.yaml`-Routing-Tabelle an den Empfänger `webhook-test`, der wiederum auf den Container `webhook-logger` zeigt (`http://webhook-logger:8080`).

| Folder | Regel | Bedingung | Wartezeit | ohne Daten |
|---|---|---|---|---|
| DB | Datenbank ausgefallen | `pg_up < 1` | 20 s | **Alarm** |
| Container | Container abgestürzt | `up{job=~"backend\|postgres\|prometheus\|cadvisor\|nginx-exporter"} < 1` | 30 s | OK |
| Container | CPU-Alert Applikation | `rate(container_cpu_usage_seconds_total{name=~"backend-1\|backend-2\|database"}[1m]) * 100 > 70` | 1 min | OK |
| Container | CPU-Alert Infrastruktur | dito für Nginx-/Exporter-Container, Schwelle `> 30 %` | 1 min | OK |
| Container | RAM-Alert | `container_memory_working_set_bytes / 1024 / 1024 > 800` | 1 min | OK |
| Backend | Backend ausgefallen | `up{job="backend"} < 1` | 20 s | OK |
| HTTP | HTTP-Service nicht erreichbar | `probe_success{job="blackbox"} < 1` | 1 min | OK |

**Verhalten ohne Daten (`noDataState`):**

- **Datenbank ausgefallen → Alarm.** `pg_up` liefert der `postgres-exporter`. Fällt er aus, gibt es keine Daten mehr, und der Zustand der Datenbank ist unbekannt. Das wird als Ausfall gemeldet (Grafana setzt dann `grafana_state_reason = NoData`), statt stillschweigend „OK" anzunehmen.
- **CPU-/RAM-Alerts → OK.** Ohne cAdvisor-Labels (Docker Desktop/Mac) liefert die Abfrage keine Zeitreihen. Mit `NoData` würde Grafana dann dauerhaft Alarme senden. Ein Ausfall von cAdvisor selbst meldet weiterhin „Container abgestürzt".

**Warum unterschiedliche CPU-Schwellen?** App-Container (Backend, Datenbank) dürfen unter Last hochlaufen — 70 % sind erst dann auffällig, wenn es dauerhaft passiert. Infrastruktur-Container (Nginx, Exporter) sollten dauerhaft im einstelligen %-Bereich liegen; alles über 30 % deutet auf einen Bug oder ein DoS-Muster hin.

**Warum nur ein Webhook-Empfänger und kein E-Mail/Slack?** Der `webhook-logger` ist ein bewusster Demo-Empfänger — er macht alle eingehenden Alerts auf seinem Log sichtbar (`docker compose logs webhook-logger`), ohne externe Abhängigkeiten zur Bewertung. Für Produktion ist der Empfänger leicht austauschbar (Slack, PagerDuty, E-Mail).

### 7.4 Verifikation eines Alerts

```bash
docker compose stop backend-1                # provoziert "Backend ausgefallen"-Alert
docker compose logs -f webhook-logger        # nach ~20-30 s erscheint der POST mit JSON-Payload
docker compose start backend-1               # Resolved-Nachricht folgt
```

Getestet (2026-10-04):

| Ausfall | Alert(s) beim `webhook-logger` | Verfügbarkeit währenddessen |
|---|---|---|
| `backend-2` gestoppt | „Backend ausgefallen", „Container abgestürzt" (Instanz `backend-2`) | 40/40 Requests (Startseite + API) erfolgreich |
| `frontend-2` gestoppt | „HTTP-Service nicht erreichbar" (Instanz `frontend-2`) | dito |
| `postgres-exporter` gestoppt | „Datenbank ausgefallen" (`NoData`), „Container abgestürzt" (Instanz `postgres`) | nicht betroffen |

### 7.5 Healthchecks und Start-Reihenfolge

Alle Healthchecks stehen in [`docker-compose.yml`](../docker-compose.yml). Jeder prüft den Dienst selbst, nicht seine Abhängigkeiten. Ausnahme ist das Backend, dessen `/health` bewusst die DB-Verbindung einschließt.

| Service | Healthcheck | wartet beim Start auf |
|---|---|---|
| `database` | `pg_isready` | – |
| `backend-1/2` | `GET /health` (inkl. DB-Ping) | `database` healthy |
| `load-balancer` | `GET /lb-health` | `backend-1/2` healthy |
| `frontend`, `frontend-2` | `GET /` | – |
| `reverse-proxy` | `GET /rp-health` | `frontend`, `frontend-2`, `load-balancer` healthy |
| `prometheus` | `GET /-/healthy` | – |
| `grafana` | `GET /api/health` | `prometheus` healthy |
| `cadvisor` | eingebaut im Image (`/healthz`) | – |
| `postgres-exporter` | `GET /metrics` (antwortet auch bei DB-Ausfall, dann mit `pg_up 0`) | `database` healthy |
| `blackbox-exporter` | `GET /-/healthy` | – |
| `webhook-logger` | `GET /healthz` (wird per `LOG_IGNORE_PATH` nicht geloggt) | – |
| `db-backup` | erfolgreiches Backup jünger als ~2 h | `database` healthy |
| `nginx-exporter` | **keiner** | `reverse-proxy` healthy |

**Warum `nginx-exporter` keinen Healthcheck hat:** Das Image ist ein Scratch-Image, das nur das Exporter-Binary enthält, ohne Shell und ohne `wget`. Docker kann darin keinen Prüfbefehl ausführen. Überwacht wird der Exporter trotzdem: Prometheus meldet `up{job="nginx-exporter"}`, und die Alert-Regel „Container abgestürzt" schlägt an, wenn er ausfällt.

**`depends_on` und Verfügbarkeit:** Die Bedingungen gelten nur beim Start. Fällt später z. B. `frontend-2` aus, läuft der Reverse-Proxy normal weiter und verteilt auf `frontend`.

---

## 8. Sicherheit

### 8.1 Netzwerkisolation

Siehe [§ 2.2](#22-netzwerksegmentierung). Kernpunkt: `internal-net: internal: true` schneidet Backend und DB vom Internet ab.

### 8.2 TLS

- **Selbst-signiertes Zertifikat** unter [`nginx/certs/`](../nginx/certs/), gemountet `:ro` in den Reverse-Proxy.
- **TLS 1.2 und 1.3**, `HIGH:!aNULL:!MD5` als Cipher-Suite-Filter — schließt veraltete und null-cipher-Suiten aus.
- **HTTP→HTTPS Redirect 301** für alle Pfade außer `/rp-health` (Healthcheck soll ohne TLS-Handshake antworten).
- **HTTP/2 aktiv** (`http2 on`) — reduziert Latenz bei mehreren parallelen Requests pro Client.
- **Auch Grafana nur über HTTPS:** Die Monitoring-Oberfläche inklusive Admin-Login läuft unter `https://localhost/grafana/` über denselben TLS-Endpunkt; einen unverschlüsselten Port gibt es nicht mehr.

### 8.3 Docker Secrets (statt ENV-Variablen)

Beide Passwörter (`POSTGRES_PASSWORD`, `GF_SECURITY_ADMIN_PASSWORD`) werden als **Docker Compose Secrets** definiert:

```yaml
secrets:
  postgres_password:
    file: ./secrets/postgres_password.txt
```

Im Container liegt das Secret unter `/run/secrets/<name>`. **Auswirkung von `docker inspect <container>`:** zeigt nur den Mount-Pfad, **nie den Inhalt**.

Wie die Services das Passwort einlesen:

| Service | Mechanismus |
|---|---|
| `database` | Setzt `POSTGRES_PASSWORD_FILE=/run/secrets/postgres_password` — native Image-Funktion. |
| `backend-1/2` | Setzt dieselbe ENV; liest in [`server.js:10`](../backend/server.js#L10) mit `fs.readFileSync`. |
| `grafana` | Setzt `GF_SECURITY_ADMIN_PASSWORD__FILE` — native `__FILE`-Konvention von Grafana. |
| `postgres-exporter` | Setzt `DATA_SOURCE_PASS_FILE`. |
| `db-backup` | Liest im Entrypoint `PGPASSWORD=$(cat /run/secrets/postgres_password)`. |

### 8.4 Read-Only-Dateisysteme & Capabilities

| Service | `read_only` | `tmpfs` | `cap_drop` | `cap_add` |
|---|---|---|---|---|
| `database` | — | `/tmp`, `/var/run/postgresql` | ALL | CHOWN, DAC_OVERRIDE, FOWNER, SETUID, SETGID |
| `backend-1/2` | ✓ | `/tmp` | ALL | — |
| `load-balancer` | ✓ | `/tmp`, `/var/cache/nginx`, `/var/run` | ALL | NET_BIND_SERVICE, CHOWN, SETUID, SETGID |
| `frontend(-2)` | ✓ | dito | ALL | dito |
| `reverse-proxy` | — | (per Image schreibbar) | ALL | dito |
| `prometheus` | ✓ | `/tmp` | ALL | — |
| `grafana` | ✓ | `/tmp`, `/var/log/grafana` | ALL | — |
| `nginx-exporter` | ✓ | `/tmp` | ALL | — |
| `blackbox-exporter` | ✓ | — | ALL | — |
| `cadvisor` | — | — | — (privileged) | — |

**Warum keine Read-Only-DB?** PostgreSQL schreibt bei `initdb` in mehrere System-Verzeichnisse außerhalb des Daten-Volumes. Der Erstart würde mit Read-Only fehlschlagen. Stattdessen ist `cap_drop: ALL` plus eine Minimalliste von zugelassenen Capabilities die zweitbeste Härtung:

- `CHOWN`, `DAC_OVERRIDE`, `FOWNER`: Postgres legt sein Data-Dir mit eigenem User an.
- `SETUID`, `SETGID`: `gosu`-basierter Privileg-Wechsel root → `postgres`.

**Warum Nginx-Container `NET_BIND_SERVICE` brauchen:** Nach `cap_drop: ALL` darf der Master-Prozess sonst keine Ports < 1024 mehr öffnen — auch in Container-Netzwerken. `CHOWN`/`SETUID`/`SETGID` braucht der Master, um Worker-Prozesse an den unprivilegierten `nginx`-User zu übergeben.

**Warum cAdvisor `privileged: true`?** cAdvisor muss `/var/lib/docker`, cgroups und `/sys` lesen, um Container-Metriken zu sammeln — ohne `privileged` (oder eine sehr feingranulare Capability-Liste mit Host-Mounts) bricht das ab. Da cAdvisor selbst nur in das Monitoring-Netz hängt und keine eingehende Public-Verbindung hat, wird die Sicherheits-Reduktion akzeptiert.

### 8.5 Web Application Firewall (ModSecurity / OWASP CRS)

**Image:** `owasp/modsecurity-crs:nginx-alpine`
**Aktivierung:** `modsecurity on` + `modsecurity_rules_file /etc/modsecurity.d/setup.conf` in [`nginx/reverse-proxy.conf`](../nginx/reverse-proxy.conf)
**Tuning:**
- `PARANOIA=1` — Standard-Level (Level 4 würde viele harmlose Requests blocken).
- `ANOMALY_INBOUND=5` — Score-Schwelle, ab der ein Request mit 403 abgewiesen wird.
- `MODSEC_REQ_BODY_LIMIT=6291456` (6 MB) — Sonst würde die WAF die 5-MB-Lasttest-Bodies abweisen.

**Funktionsnachweise (Auszug aus den Logs):**

| Angriff | Test-Request | WAF-Regel |
|---|---|---|
| SQL Injection | `?id=1' OR '1'='1` | `942100` „SQL Injection via libinjection" |
| Cross-Site Scripting | `?search=<script>alert('XSS')</script>` | `941100`/`941110` „XSS via libinjection" |
| Path Traversal | `?file=../../../../etc/passwd` | `930100`/`930120` „Path Traversal (/../)" |

Alle drei Requests werden mit `HTTP 403 Forbidden` beantwortet, bevor sie das interne Netz erreichen.

**Konflikt Read-Only ↔ ModSecurity gelöst durch:**
- Nginx-Config als **Template** unter `/etc/nginx/templates/nginx.conf.template` mounten — der Image-Init rendert das Template zur Startzeit nach `/etc/nginx/nginx.conf`. Ein direktes Mount des fertigen Configs würde den Render-Schritt überschreiben.
- PID-Datei nach `/tmp/nginx.pid` (siehe [§ 4.1](#41-reverse-proxy-reverse-proxy)).

### 8.6 Sicherheitsscan (Trivy)

Vollständiger Report: [`security-scan/README.md`](../security-scan/README.md).

Stand: 2026-10-04.

| Image | Vorher (Base-Image) | Nachher |
|---|---|---|
| `it-infra-verein-backend` | 11 HIGH, 0 CRITICAL | **0 HIGH, 0 CRITICAL** |
| `it-infra-verein-frontend` | 2 HIGH, 0 CRITICAL | **0 HIGH, 0 CRITICAL** |
| `it-infra-verein-database` | 21 HIGH, 1 CRITICAL | **0 HIGH, 0 CRITICAL** |

**Maßnahmen:**

1. **Backend Multi-Stage-Build** ([`backend/Dockerfile`](../backend/Dockerfile)): Im Runtime-Stage werden `npm` und `npx` plus das gesamte `/usr/local/lib/node_modules/npm/`-Verzeichnis gelöscht. Alle 11 HIGH-Befunde im Base-Image `node:22-alpine` liegen in `npm`-Subdeps (`brace-expansion`, `pacote`, `sigstore`, `picomatch` u. a.), die zur Laufzeit nicht gebraucht werden. `node server.js` braucht kein npm. Zusätzlich spielt `apk upgrade --no-cache` gepatchte Alpine-Systempakete ein (z. B. OpenSSL). Das Backend läuft auf Node.js 22 (LTS), weil Node.js 20 seit April 2026 End-of-Life ist.

2. **Database Multi-Stage-Build** ([`db/Dockerfile`](../db/Dockerfile)): Das CRITICAL-Finding war **CVE-2025-68121** (`crypto/tls: incorrect certificate validation during TLS session resumption`) im `gosu`-Binary, das `postgres:17-alpine` mitbringt. Wurzel: gosu ist mit Go-stdlib v1.24.6 verlinkt; das Postgres-Team baut gosu nicht zeitnah neu. Lösung: gosu wird in Stage 1 aus dem aktuellen Quellcode mit `golang:1.25-alpine` (aktuell Go v1.25.14, CVE ab 1.25.7 behoben) frisch kompiliert; Stage 2 überschreibt das verwundbare Binary unter `/usr/local/bin/gosu`. Verifikation:
   ```
   $ docker compose exec database gosu --version
   1.19 (go1.25.14 on linux/arm64; gc)
   ```

3. **Frontend** ([`frontend/Dockerfile`](../frontend/Dockerfile)): Die 2 HIGH-Befunde des Base-Images `nginx:alpine` (`libexpat` CVE-2026-93990, `pcre2` CVE-2026-103111) behebt `apk upgrade --no-cache` (`libexpat` 2.8.4 → 2.8.5, `pcre2` 10.48 → 10.49).

**Reproduktion** der Scans:
```bash
# im Projektverzeichnis (Repository-Root)
docker compose build
for img in it-infra-verein-backend-1:latest it-infra-verein-frontend:latest it-infra-verein-database:latest; do
  docker run --rm \
    -v /var/run/docker.sock:/var/run/docker.sock \
    aquasec/trivy:latest image \
      --severity HIGH,CRITICAL --scanners vuln "$img"
done
```

### 8.7 Exponierte Ports

| Port | Zweck | Begründung |
|---|---|---|
| `80` | HTTP → 301 Redirect auf 443 + Healthcheck | Browser-Standardport |
| `443` | HTTPS (alle App-Pfade und Grafana unter `/grafana/`, WAF, TLS) | Browser-Standardport |

Alle anderen Services sind **nicht** an den Host gebunden — Backend, DB, Prometheus, Grafana, alle Exporter und der `webhook-logger` sind nur containerintern erreichbar. Eingehende Alerts liest man mit `docker compose logs webhook-logger`.

---

## 9. Backup & Recovery

### 9.1 Aufbau

Sidecar-Container `db-backup` auf Basis von `postgres:17.11-alpine` (gleiche Major-Version wie die Datenbank, damit `pg_dump` passt). Auszug aus [`docker-compose.yml`](../docker-compose.yml):

```yaml
db-backup:
  image: postgres:17.11-alpine
  environment:
    BACKUP_INTERVAL_SECONDS: 3600   # stündlich
    BACKUP_RETENTION_DAYS: 7        # ältere Dumps werden gelöscht
  secrets: [postgres_password]
  volumes:
    - db-backups:/backups
  networks: [internal-net]
  depends_on:
    database:
      condition: service_healthy
  entrypoint:
    - sh
    - -c
    - |
      while true; do
        ts=$$(date +%Y%m%d_%H%M%S)
        part=/backups/.backup_$$ts.sql.part
        if PGPASSWORD=$$(cat /run/secrets/postgres_password) \
             pg_dump -h database -U ${POSTGRES_USER:-verein} --clean --if-exists \
             -f "$$part" ${POSTGRES_DB:-verein}; then
          mv "$$part" "/backups/backup_$$ts.sql"
          echo "Backup erfolgreich: backup_$$ts.sql"
        else
          rm -f "$$part"
          echo "Backup FEHLGESCHLAGEN: $$(date)" >&2
        fi
        find /backups -name 'backup_*.sql' -mtime +$$BACKUP_RETENTION_DAYS -print -delete
        sleep $$BACKUP_INTERVAL_SECONDS
      done
  healthcheck:
    test: ["CMD-SHELL", "find /backups -name 'backup_*.sql' -mmin -125 | grep -q ."]
```

**Wesentliche Entscheidungen:**

- **Eigener Container statt cron im DB-Container:** trennt Wartungslogik von der DB selbst und vermeidet `cron` in einem ohnehin schon zu schützenden Image.
- **`depends_on: condition: service_healthy`:** verhindert, dass das erste Backup gegen eine nicht-fertige DB läuft.
- **Passwort via Secret-File**, nicht ENV. `PGPASSWORD` gilt nur für den einzelnen `pg_dump`-Aufruf (Shell-Substitution `$(cat ...)`).
- **Atomares Schreiben:** `pg_dump` schreibt in eine versteckte `.part`-Datei, die erst nach Erfolg in `backup_<Zeitstempel>.sql` umbenannt wird. Schlägt der Dump fehl (z. B. DB nicht erreichbar), wird die Teildatei gelöscht. Es entstehen also keine leeren oder halben Backups, die beim Restore wie gültige aussehen würden.
- **`--clean --if-exists`:** Der Dump enthält vor dem Anlegen jedes Objekts ein `DROP ... IF EXISTS`. Er lässt sich deshalb auch in eine schon initialisierte Datenbank einspielen, deren Schema `init.sql` beim ersten Start angelegt hat.
- **Rotation:** Nach jedem Lauf löscht `find ... -mtime +7 -delete` Backups, die älter als 7 Tage sind (`BACKUP_RETENTION_DAYS`). Bei stündlichen Backups bleiben so etwa 170 Dumps, und das Volume wächst nicht unbegrenzt.
- **Healthcheck:** Der Container ist nur healthy, wenn es ein erfolgreiches Backup gibt, das jünger als ~2 Stunden ist. Ein einzelner fehlgeschlagener Lauf wird toleriert, dauerhaft ausfallende Backups werden in `docker compose ps` sichtbar.
- **Eigenes Volume `db-backups`**, nicht im selben Volume wie `db-data`. Trennt Daten von Sicherungen und vermeidet, dass ein Bug der DB die Backups mitkorrumpiert.

**Getestet (2026-10-04):**

| Fall | Ergebnis |
|---|---|
| Normaler Lauf | `backup_<Zeitstempel>.sql` angelegt, enthält `DROP TABLE IF EXISTS` |
| Datenbank gestoppt, `db-backup` neu gestartet | `Backup FEHLGESCHLAGEN`, keine `.part`-Datei und kein leeres Backup übrig |
| Backup-Datei mit Datum 01.09.2026 angelegt | beim nächsten Lauf durch die Rotation gelöscht |
| Restore in eine Datenbank mit bereits angelegtem Schema | `psql -v ON_ERROR_STOP=1` ohne Fehler; Zeilenzahl in `mitglieder` und `spenden` identisch mit dem Original |

### 9.2 Restore

```bash
# Verfügbare Backups listen
docker compose exec db-backup ls -lh /backups

# Restore eines bestimmten Snapshots in die laufende Datenbank.
# -T bei BEIDEN exec-Aufrufen: ohne -T würde Docker ein TTY anlegen und
# Steuerzeichen in den SQL-Strom mischen.
docker compose exec -T database psql -v ON_ERROR_STOP=1 -U verein -d verein \
  < <(docker compose exec -T db-backup cat /backups/backup_20261004_120000.sql)
```

Der Dump löscht dabei vorhandene Tabellen und legt sie mit dem Stand des Backups neu an (`--clean`). Daten, die nach dem Backup geschrieben wurden, gehen also verloren. Das ist bei einem Restore gewollt.

**Restore gefahrlos testen** (in eine Wegwerf-Datenbank statt in `verein`):

```bash
docker compose exec -T database psql -U verein -d verein -c "CREATE DATABASE restore_test;"
docker compose exec -T database psql -v ON_ERROR_STOP=1 -U verein -d restore_test \
  < <(docker compose exec -T db-backup cat /backups/backup_20261004_120000.sql)
docker compose exec -T database psql -U verein -d restore_test -c "SELECT count(*) FROM mitglieder;"
docker compose exec -T database psql -U verein -d verein -c "DROP DATABASE restore_test;"
```

### 9.3 Bekannte Einschränkungen

- **Volume `db-backups` ist lokal.** `docker compose down -v` löscht es. Für echte Datensicherheit muss das Volume auf einen externen Speicher (S3, NFS) gemountet werden.
- **Restore-Test nicht automatisiert.** Der Restore wurde manuell geprüft (siehe oben). Eine regelmäßige automatische Prüfung in eine Wegwerf-Datenbank wäre die nächste Ausbaustufe.
- **Fehlgeschlagene Backups lösen keinen Grafana-Alert aus.** Sie sind im Log (`docker compose logs db-backup`) und über den Healthcheck sichtbar, aber nicht als Prometheus-Metrik.

---

## 10. Lasttests

Vollständiger Report: [`loadtests/README.md`](../loadtests/README.md).

### 10.1 Setup

- **Tool:** k6, als Docker-Container, eingehängt im `it-infra-verein_public-net` — spricht den Reverse-Proxy unter `https://reverse-proxy/` an. Umgeht die TLS-Performance-Probleme von Docker Desktop unter macOS bei vielen parallelen Verbindungen.
- **Voraussetzung:** Docker-Desktop-Memory ≥ 6 GB (siehe [§ 3.1](#31-voraussetzungen)).
- **Aufruf:** `./loadtests/run.sh <szenario>.js`. Output → [`loadtests/results/`](../loadtests/results/).

### 10.2 Szenarien & Ergebnisse

| # | Szenario | Kriterium | Req. | Fehler | p95 | Notiz |
|---|---|---|---|---|---|---|
| 01 | web-10-parallel-0s | Z. 17 | 465 552 | 0 % | 519 µs | 31 k req/s |
| 02 | web-100-parallel-1s | Z. 18 | 426 088 | 0 % | 7.28 ms | 26 k req/s |
| 03 | web-1000-parallel-5s | Z. 19 | 7 500 | 0 % | 870 µs | 1000 req/s gehalten |
| 04 | web-1000-parallel-1s | Z. 20 | 5 500 | 0 % | 822 µs | 1000 req/s gehalten |
| 05 | web-1000rpm-10min | Z. 21 | 10 001 | 0 % | 1.67 ms | 16.67 req/s konstant |
| 06 | api-10-parallel-0s | Z. 23 | 125 370 | 0 % | 1.89 ms | 8.4 k req/s |
| 07 | api-100-parallel-1s | Z. 24 | 202 603 | 0 % | 21.94 ms | 9.6 k req/s |
| 08 | api-1000-parallel-5s | Z. 25 | 7 500 | 0 % | 1.32 ms | 1000 req/s gehalten |
| 09 | api-5mb-10-parallel-0s | Z. 26 | 2 020 | 0 % | 75 ms | 100 req/s, 500 MB/s |
| 10 | api-5mb-100-parallel-1s | Z. 27 | 1 491 | 0 % | 3.68 s | 47 req/s, 235 MB/s |
| 11 | api-5mb-1000-parallel-5s-429ok | Z. 28 | 737 | 0 × 5xx | 5.62 s | 0 × 429; 1573 k6-internal drops |
| 12 | api-5mb-1000-parallel-5s-strict | Z. 29 | 812 | 0 % | 5.26 s | alle 812 mit 201 |

**Stand: 2026-05-25.** Alle 12 Szenarien laufen mit **0 Server-Fehlern** durch.

### 10.3 Nötige Anpassungen am Server-Code

Drei Stellen mussten verändert werden, damit 5-MB-Requests bis zur DB durchgehen:

- [`backend/server.js`](../backend/server.js): `express.json({ limit: '6mb' })` — Default 100 KB, sonst HTTP 413.
- [`nginx/reverse-proxy.conf`](../nginx/reverse-proxy.conf): `client_max_body_size 6m` — Default 1 MB, sonst HTTP 413 am Edge.
- [`nginx/load-balancer.conf`](../nginx/load-balancer.conf): dito für den Load-Balancer.

### 10.4 Methodische Anmerkung

Für die 1000-VU-Szenarien (03, 04, 08, 11, 12) verwendet k6 den Executor **`ramping-arrival-rate`** statt `ramping-vus`:

- 1000 echte VUs brauchen in k6 ~6 GB RAM (jede VU hat eine eigene V8-Runtime). Das sprengt die Docker-Desktop-VM.
- `ramping-arrival-rate` definiert eine Ziel-Rate (z. B. 1000 req/s) und k6 nimmt nur so viele VUs wie nötig, um diese Rate zu halten (typisch 50–200).
- **Aus Server-Sicht** ist die Last identisch — der Reverse-Proxy sieht 1000 Requests pro Sekunde, unabhängig davon, ob sie aus 1000 oder 200 Client-Threads kommen.

Für die 5-MB-Szenarien ist die Rate auf 200 req/s reduziert, weil `5 MB × 1000 req/s = 5 GB/s` jede realistische Netzanbindung sprengt — die Tests würden Bandbreite messen, nicht Server-Verhalten.

### 10.5 Kurzbewertung

- **Statischer Web-Endpoint:** 30 k req/s mit Sub-Millisekunden-Latenz — komplett unproblematisch.
- **API-Endpoint (normale Bodies):** ~10 k req/s, p95 < 25 ms. Load-Balancer verteilt sauber auf beide Backend-Instanzen.
- **API-Endpoint (5 MB Bodies):** Limit ist die effektive Bandbreite, nicht der Server. p95 < 6 s, **keine 5xx-Fehler** in keinem Szenario. Damit sind sowohl Z. 28 (429 erlaubt) als auch Z. 29 (alle 201) erfüllt — das System weist schlicht keine Anfragen ab.

---

## 11. Mapping Bewertungskriterien → Umsetzung

Vollständige Liste der Kriterien aus [`bewertungskriterien.md`](bewertungskriterien.md) mit Verweis auf den Beleg.

### Dokumentation & Compose-Grundlagen

| Kriterium | Umsetzung | Beleg |
|---|---|---|
| `README.md` als Kurzanleitung | [`README.md`](../README.md) | direkt einsehbar |
| Alle Dateien/Dockerfiles enthalten | `backend/Dockerfile`, `db/Dockerfile`, `frontend/Dockerfile`, alle Configs | Repo-Inhalt |
| Start via `docker compose` | `docker compose up --build -d` | [§ 3.3](#33-start) |
| Automatische Initialisierung | `init.sql` via `/docker-entrypoint-initdb.d/` | [§ 4.5](#45-datenbank-database) |
| URL für Web-Aufruf | `https://localhost/` | [§ 3.4](#34-verifikation) |
| Daten-Endpunkt | `POST /api/mitglieder`, `POST /api/spenden` | [§ 5.2 / 5.3](#52-post-apimitglieder) |
| Health-Check-URL | `https://localhost/health` | [§ 5.1](#51-get-health) |
| Persistente Daten in Volumes | `db-data`, `prometheus-data`, `grafana-data`, `db-backups` | [§ 9.1](#91-aufbau) |

### Lasttests (12 P.)

| Kriterium (Zeile) | Erfüllt | Beleg |
|---|---|---|
| Z. 17–21 (Web-Endpoint, 5 Szenarien) | ✓ | [§ 10.2](#102-szenarien--ergebnisse), Zeilen 01–05 |
| Z. 23–29 (API-Endpoint, 7 Szenarien) | ✓ | [§ 10.2](#102-szenarien--ergebnisse), Zeilen 06–12 |

### Verfügbarkeit (6 P.)

| Kriterium | Umsetzung | Beleg |
|---|---|---|
| Frontend-Ausfall ohne Verfügbarkeitsverlust | 2× `frontend`, Reverse-Proxy mit `max_fails`/`fail_timeout` | [§ 6.1](#61-ausfall-eines-frontend-webservers-ohne-verfügbarkeitsverlust) |
| Backend-Ausfall im Monitoring | Grafana-Alert auf `up{job="backend"}` | [§ 6.2](#62-backend-ausfall-im-monitoring-sichtbar) |
| Frontend zeigt Fehlermeldung bei Backend-Ausfall | JS-Catch in `mitglied-werden.html`/`spenden.html` | [§ 6.3](#63-frontend-zeigt-bei-backend-ausfall-passende-fehlermeldung) |
| DB-Ausfall im Monitoring | Grafana-Alert auf `pg_up` | [§ 6.4](#64-datenbank-ausfall-im-monitoring-sichtbar) |
| Frontend zeigt Fehlermeldung bei DB-Ausfall | Backend `/health` antwortet 503, Schreib-Endpoints 500 | [§ 6.5](#65-frontend-zeigt-bei-db-ausfall-passende-fehlermeldung) |
| Horizontale Skalierung | Stateless Backend, Load-Balancer-Upstream | [§ 6.6](#66-horizontale-skalierung-scale-out) |

### Monitoring (6 P.)

| Kriterium | Umsetzung | Beleg |
|---|---|---|
| Services besitzen Healthchecks | alle Services in `docker-compose.yml` außer `nginx-exporter` (Scratch-Image ohne Shell, überwacht per Prometheus) | [§ 7.5](#75-healthchecks-und-start-reihenfolge) |
| Geordnete Start-Reihenfolge | `depends_on: condition: service_healthy` | [§ 3.3](#33-start) |
| Crash-Erkennung | Grafana-Alert „Container abgestürzt" auf `up{job=~...}` | [§ 7.3](#73-alert-regeln) |
| Auto-Restart | `restart: unless-stopped` an allen Services | [§ 6.7](#67-automatischer-container-restart) |
| Überwachungslimits konfiguriert | Grafana-Alert-Regeln (CPU, RAM, Probe-Down) + Container-Limits (`deploy.resources.limits`) | [§ 7.3](#73-alert-regeln), [§ 6.8](#68-container-resource-limits) |
| Benachrichtigung bei Überschreitung | Webhook an `webhook-logger` | [§ 7.3 / 7.4](#73-alert-regeln) |

### Security (5 P.)

| Kriterium | Umsetzung | Beleg |
|---|---|---|
| Netzisolation | 3 Netze, `internal-net: internal: true` | [§ 2.2](#22-netzwerksegmentierung) |
| SSL-verschlüsselt | TLS 1.2/1.3 am Reverse-Proxy (auch für Grafana), 80→443 Redirect | [§ 8.2](#82-tls) |
| Secrets nicht in `docker inspect` | Docker Compose Secrets | [§ 8.3](#83-docker-secrets-statt-env-variablen) |
| Keine unnötigen Ports | nur 80 (Redirect) und 443 | [§ 8.7](#87-exponierte-ports) |
| Read-Only / Capabilities | siehe Tabelle | [§ 8.4](#84-read-only-dateisysteme--capabilities) |

### Sonstiges (4 P.)

| Kriterium | Umsetzung | Beleg |
|---|---|---|
| WAF | ModSecurity + OWASP CRS auf Reverse-Proxy | [§ 8.5](#85-web-application-firewall-modsecurity--owasp-crs) |
| Sicherheitsscan dokumentiert | Trivy, Reports unter `security-scan/{before,after}` | [§ 8.6](#86-sicherheitsscan-trivy) |
| Scan findet keine kritischen Schwachstellen | 0 HIGH, 0 CRITICAL in allen 3 eigenen Images | [§ 8.6](#86-sicherheitsscan-trivy) |
| Automatisches DB-Backup | `db-backup`-Sidecar, stündlich, 7 Tage Aufbewahrung, Restore getestet | [§ 9.1](#91-aufbau) |

---

## 12. Anhang

### 12.1 Verzeichnisstruktur

```
it-infra-verein/
├── README.md                     # Quickstart
├── docker-compose.yml
├── backend/
│   ├── Dockerfile                # Multi-Stage (npm entfernt im Runtime)
│   ├── package.json
│   └── server.js                 # Express-App, /health, /metrics, /api/*
├── db/
│   ├── Dockerfile                # Multi-Stage (gosu neu gebaut)
│   ├── init.sql                  # Schema + Indizes + Trigger
│   └── datenbankschema.md
├── frontend/
│   ├── Dockerfile
│   └── html/                     # statische Seiten
├── nginx/
│   ├── certs/                    # self-signed TLS-Zertifikat
│   ├── load-balancer.conf
│   └── reverse-proxy.conf        # ModSecurity, TLS, Routing
├── monitoring/
│   ├── prometheus.yml
│   └── grafana/provisioning/     # Datasource, Dashboards, Alerts
├── loadtests/
│   ├── run.sh
│   ├── scenarios/                # 12 k6-Skripte
│   ├── results/                  # Roh-Output der Läufe
│   └── README.md
├── security-scan/
│   ├── before/                   # Trivy-Reports vor den Fixes
│   ├── after/                    # Trivy-Reports nach den Fixes
│   └── README.md
├── docs/
│   ├── DOKUMENTATION.md          # dieses Dokument
│   ├── bewertungskriterien.md    # Aufgabenstellung
│   ├── datenbankschema.md        # Schema-Doku der Anwendung
│   └── vereins-website-planung.md # Fachliche Planung
└── secrets/                      # NICHT im Repo (.gitignore)
```

### 12.2 Glossar

| Begriff | Bedeutung |
|---|---|
| **CRS** | Core Rule Set — Standard-Regelsatz für ModSecurity, gepflegt vom OWASP. |
| **gosu** | Minimaler `setuid`-Wrapper, der `su`/`sudo` in Containern ersetzt — wird vom `postgres`-Image für Privileg-Wechsel root → postgres benutzt. |
| **Paranoia Level** | ModSecurity-Aggressivität (1=Default, 4=streng). Höher = mehr False Positives, stärkerer Schutz. |
| **Anomaly Score** | ModSecurity addiert pro getriggerter Regel einen Score. Ab Schwelle (hier 5) wird der Request blockiert. |
| **VU** | „Virtual User" in k6 — ein paralleler Client-Thread. |
| **Ramping-Arrival-Rate** | k6-Executor, der eine Ziel-*Rate* (req/s) statt einer Ziel-*Parallelität* (VUs) hält. |
| **`up{job=...}`** | Prometheus-interne Metrik: 1 wenn das Target im letzten Scrape erreichbar war, sonst 0. |
| **`pg_up`** | Metrik aus `postgres-exporter`: 1 wenn die DB erreichbar ist, sonst 0. |
| **`probe_success`** | Metrik aus `blackbox-exporter`: 1 wenn der HTTP-Probe einen `2xx` bekam, sonst 0. |

### 12.3 Bekannte Limitationen

- **cAdvisor auf Docker Desktop für Mac:** liefert keine `name`-Labels für die Container, weshalb die CPU/RAM-Panels in Grafana auf dem Mac leer bleiben. Auf Linux-Hosts funktioniert es. Workaround wäre ein anderer Container-Metrik-Sammler.
- **Backup-Volume lokal:** `db-backups` wird durch `docker compose down -v` gelöscht. Für Produktion muss es auf einen externen Speicher.
- **Skalierung über `--scale` blockiert** durch fixe `container_name`-Einträge in der Compose-Datei — siehe [§ 6.6](#66-horizontale-skalierung-scale-out).
- **`webhook-logger` ist ein Demo-Empfänger:** Alerts landen nur in dessen Log. In Produktion durch einen echten Empfänger (Slack/E-Mail) ersetzen.

### 12.4 Quellen & Werkzeuge

- [Docker Compose Specification](https://compose-spec.io/)
- [OWASP ModSecurity CRS](https://coreruleset.org/)
- [Trivy](https://github.com/aquasecurity/trivy)
- [k6 Load Testing](https://k6.io/)
- [Prometheus Documentation](https://prometheus.io/docs/)
- [Grafana Provisioning](https://grafana.com/docs/grafana/latest/administration/provisioning/)
- [CVE-2025-68121](https://nvd.nist.gov/vuln/detail/CVE-2025-68121) — Go-stdlib `crypto/tls`-Bug, Grundlage für den gosu-Rebuild.
