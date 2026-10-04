# Förderverein – IT-Infrastruktur

Containerisierte Web-Infrastruktur für die Vereinswebsite des Fördervereins.  
Stack: **Nginx** (Reverse Proxy + Load Balancer) · **Node.js / Express** (Backend, 2× repliziert) · **PostgreSQL** (Datenbank) · **Prometheus + Grafana** (Monitoring).

---

## Voraussetzungen

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (oder Docker Engine + Docker Compose Plugin)

> TLS-Zertifikate (`nginx/certs/server.crt` und `server.key`) sind bereits im Repository enthalten.

---

## Starten

### Was ist bereits im Repository enthalten

| | Datei / Verzeichnis | Aktion nötig? |
|---|---|---|
| ✅ | Alle Dockerfiles und Quellcode | nein |
| ✅ | Nginx-Konfigurationen | nein |
| ✅ | Frontend-HTML/CSS | nein |
| ✅ | Monitoring-Konfiguration (Prometheus, Grafana) | nein |
| ✅ | TLS-Zertifikate (`nginx/certs/`) | nein |
| ✅ | Datenbank-Initialisierungsscript | nein |
| ❌ | `secrets/postgres_password.txt` | **muss angelegt werden** |
| ❌ | `secrets/grafana_admin_password.txt` | **muss angelegt werden** |

### 1. Secrets anlegen

Passwörter werden nicht als Umgebungsvariablen gesetzt (wären in `docker inspect` sichtbar), sondern als **Docker Secrets** als Dateien eingebunden:

```powershell
mkdir secrets

# Passwörter nach Wunsch anpassen.
# Wichtig: [System.IO.File]::WriteAllText verwenden, damit die Datei ohne BOM und ohne Null-Bytes gespeichert wird – andernfalls schlägt PostgreSQL-initdb fehl.
[System.IO.File]::WriteAllText("secrets\postgres_password.txt",       "DeinPostgresPasswort", [System.Text.Encoding]::ASCII)
[System.IO.File]::WriteAllText("secrets\grafana_admin_password.txt",  "DeinGrafanaPasswort",  [System.Text.Encoding]::ASCII)
```

Der `secrets/`-Ordner ist in `.gitignore` eingetragen und wird nie versioniert.

### 2. Infrastruktur starten

```bash
# Im Projektverzeichnis (Repository-Root) ausführen
docker compose up --build -d
```

Alle Initialisierungsschritte (Datenbankschema anlegen, Abhängigkeiten) werden automatisch beim ersten Start ausgeführt.  
Mit `docker compose logs -f` können laufende Logs verfolgt werden.

### Stoppen

```bash
docker compose down          # Container stoppen (Volumes bleiben erhalten)
docker compose down -v       # Container und Volumes entfernen (Datenverlust!)
```

---

## URLs

| Zweck | URL |
|---|---|
| **Startseite** | <https://localhost/> |
| **Mitglied werden** | <https://localhost/mitglied-werden.html> |
| **Spenden** | <https://localhost/spenden.html> |
| **Health-Check (Anwendung + DB)** | <https://localhost/health> |
| **Grafana Monitoring-Dashboard** | <https://localhost/grafana/> (admin / Passwort aus `secrets/grafana_admin_password.txt`) |
| **Eingegangene Alerts** | `docker compose logs -f webhook-logger` |

> **Hinweis:** Da ein selbst-signiertes Zertifikat verwendet wird, muss die Browser-Sicherheitswarnung beim ersten Aufruf einmalig bestätigt werden (`Erweitert → Trotzdem fortfahren`).

---

## API-Endpunkte

Alle API-Endpunkte sind unter `https://localhost/api/` erreichbar.

### `GET /health`

Prüft die Verfügbarkeit des Backends sowie die Datenbankverbindung.

```bash
curl -k https://localhost/health
```

**Erfolgreiche Antwort (`200 OK`):**
```json
{ "status": "healthy", "db": "connected", "uptime": 42.3 }
```

---

### `POST /api/mitglieder` – Mitgliedsantrag einreichen

Legt einen neuen Mitgliedsantrag in der Datenbank an.

**Pflichtfelder:** `vorname`, `nachname`, `email`

```bash
curl -k -X POST https://localhost/api/mitglieder \
  -H "Content-Type: application/json" \
  -d '{
    "vorname":      "Max",
    "nachname":     "Mustermann",
    "email":        "max@example.com",
    "telefon":      "0123456789",
    "geburtsdatum": "1990-01-15",
    "adresse_str":  "Musterstraße 1",
    "adresse_plz":  "12345",
    "adresse_ort":  "Musterstadt",
    "mitgliedstyp": "regulaer"
  }'
```

**Erfolgreiche Antwort (`201 Created`):**
```json
{ "id": 1 }
```

| Status | Bedeutung |
|---|---|
| `201 Created` | Antrag erfolgreich gespeichert |
| `400 Bad Request` | Pflichtfeld fehlt oder Eingabe ungültig (z. B. Datumsformat, Feldlänge) |
| `409 Conflict` | E-Mail bereits registriert |

---

### `POST /api/spenden` – Spende einreichen

Erfasst eine Spende in der Datenbank.

**Pflichtfelder:** `betrag_cent` (positiver ganzzahliger Cent-Betrag)

```bash
curl -k -X POST https://localhost/api/spenden \
  -H "Content-Type: application/json" \
  -d '{
    "spender_name":  "Erika Musterfrau",
    "spender_email": "erika@example.com",
    "betrag_cent":   2500,
    "waehrung":      "EUR",
    "zweck":         "Jugendarbeit",
    "zahlungsart":   "ueberweisung"
  }'
```

**Erfolgreiche Antwort (`201 Created`):**
```json
{ "id": 1 }
```

| Status | Bedeutung |
|---|---|
| `201 Created` | Spende erfolgreich gespeichert |
| `400 Bad Request` | `betrag_cent` fehlt oder ungültig, oder ein anderes Feld ist ungültig (z. B. zu lang) |

---

## Architektur-Überblick

### Netzwerke

| Netzwerk | Dienste |
|---|---|
| `public-net` | reverse-proxy, load-balancer, frontend, frontend-2, grafana, nginx-exporter, blackbox-exporter |
| `internal-net` | load-balancer, backend-1, backend-2, database, db-backup, postgres-exporter, prometheus, blackbox-exporter |
| `monitoring-net` | prometheus, grafana, cadvisor, nginx-exporter, postgres-exporter, webhook-logger |

Nach außen sind nur die Ports **80** (Weiterleitung auf HTTPS) und **443** offen. Auch Grafana ist nur über den Reverse-Proxy erreichbar.

Das `internal-net` ist als `internal: true` konfiguriert – Dienste darin haben **keinen** direkten Internet-Zugang.

---

## Persistente Daten

| Volume | Inhalt |
|---|---|
| `db-data` | PostgreSQL-Datenbankdateien |
| `prometheus-data` | Prometheus-Metriken (Zeitreihen) |
| `grafana-data` | Grafana-Dashboards und -Einstellungen |

Volumes überleben `docker compose down` und bleiben beim Neustart erhalten.

---

## Automatisches Datenbank-Backup

Der `db-backup`-Service läuft als Sidecar-Container neben der Datenbank und erstellt stündlich einen vollständigen `pg_dump`-Snapshot:

- Backups werden unter dem Volume `db-backups` gespeichert (Dateiname: `backup_YYYYMMDD_HHMMSS.sql`).
- Backups, die älter als 7 Tage sind, werden automatisch gelöscht (`BACKUP_RETENTION_DAYS`).
- Der Dump wird erst nach erfolgreichem Abschluss unter seinem endgültigen Namen abgelegt; ein fehlgeschlagener Lauf hinterlässt keine leere Datei.
- Der Dump enthält `DROP ... IF EXISTS` (`pg_dump --clean --if-exists`) und lässt sich deshalb in die bestehende Datenbank einspielen.
- Der Container ist nur `healthy`, wenn es ein erfolgreiches Backup aus den letzten ~2 Stunden gibt.
- Das Passwort wird via Docker Secret (`/run/secrets/postgres_password`) übergeben — nie als Umgebungsvariable.
- Der Service hängt per `depends_on: condition: service_healthy` von einer gesunden Datenbank ab.

**Restore** (überschreibt den aktuellen Datenbankinhalt mit dem Stand des Backups):

```bash
docker compose exec db-backup ls -lh /backups      # verfügbare Backups
docker compose exec -T database psql -v ON_ERROR_STOP=1 -U verein -d verein \
  < <(docker compose exec -T db-backup cat /backups/backup_20261004_120000.sql)
```

Details und ein gefahrloser Restore-Test: [DOKUMENTATION.md § 9](docs/DOKUMENTATION.md#9-backup--recovery).

> **Achtung:** Das Volume `db-backups` wird durch `docker compose down -v` gelöscht. Für produktive Umgebungen sollte das Volume auf einen externen Speicher gemountet werden.

---

## Sicherheitsmaßnahmen

### Docker Secrets (Task 4)

Alle Passwörter (`POSTGRES_PASSWORD`, Grafana-Admin-Passwort) werden **nicht** als Umgebungsvariablen übergeben, da diese über `docker inspect <container>` im Klartext auslesbar wären. Stattdessen werden dateibasierte **Docker Compose Secrets** verwendet:

- Die Secrets werden als Dateien unter `./secrets/` abgelegt und via `docker-compose.yml` als `secrets:` deklariert.
- Innerhalb der Container ist das Secret als Datei unter `/run/secrets/<name>` eingebunden.
- PostgreSQL liest `POSTGRES_PASSWORD_FILE` nativ (offizielle Image-Funktion).
- Das Node.js-Backend liest die Passwortdatei beim Start mit `fs.readFileSync`.
- Grafana liest `GF_SECURITY_ADMIN_PASSWORD__FILE` (offizielle `__FILE`-Konvention).
- `docker inspect` zeigt nur den Dateipfad (`/run/secrets/...`), nie das Passwort selbst.

### Read-Only-Dateisysteme & Capabilities (Task 5)

Alle selbst-erstellten und Drittanbieter-Container (außer `cadvisor`, das `privileged: true` benötigt) laufen mit eingeschränkten Rechten:

| Service | `read_only` | `tmpfs`-Pfade | `cap_drop` | `cap_add` |
|---|---|---|---|---|
| `database` | – | `/tmp`, `/var/run/postgresql` | ALL | CHOWN, DAC_OVERRIDE, FOWNER, SETUID, SETGID |
| `backend-1/2` | ✓ | `/tmp` | ALL | – |
| `load-balancer` | ✓ | `/tmp`, `/var/cache/nginx`, `/var/run` | ALL | NET_BIND_SERVICE, CHOWN, SETUID, SETGID |
| `frontend` | ✓ | `/tmp`, `/var/cache/nginx`, `/var/run` | ALL | NET_BIND_SERVICE, CHOWN, SETUID, SETGID |
| `reverse-proxy` | – | – (per Image schreibbar) | ALL | NET_BIND_SERVICE, CHOWN, SETUID, SETGID |
| `prometheus` | ✓ | `/tmp` | ALL | – |
| `grafana` | ✓ | `/tmp`, `/var/log/grafana` | ALL | – |
| `nginx-exporter` | ✓ | `/tmp` | ALL | – |

**Begründung der Nginx-Capabilities:**
- `NET_BIND_SERVICE`: Nginx Master-Prozess muss Port 80/443 binden (auch in Container-Netzwerken notwendig nach `cap_drop: ALL`).
- `CHOWN` / `SETUID` / `SETGID`: Der Master-Prozess (root) übergibt Worker-Prozesse an den unprivilegierten `nginx`-User.

**Backend ohne root:** Das Backend-Image läuft als unprivilegierter User `node` (`USER node`). Mit `init: true` reicht ein Mini-Init Signale weiter, und Node fährt bei `docker stop` sauber herunter.

**Warum `database` kein `read_only`:** PostgreSQL schreibt während der Initialisierung (`initdb`) in systemseitige Verzeichnisse außerhalb des Daten-Volumes. Das Risiko eines Startfehlers übersteigt den Sicherheitsgewinn; die Capabilities sind dennoch auf das Minimum reduziert.

**Warum `reverse-proxy` kein `read_only`:** Das `owasp/modsecurity-crs`-Image erzeugt seine Konfiguration beim Start: Die Entrypoint-Skripte schreiben per `envsubst`/`sed` nach `/etc/nginx/` (u. a. `nginx.conf`, `conf.d/`) und kopieren die ModSecurity-Konfiguration nach `/etc/modsecurity.d/`. Diese Verzeichnisse als `tmpfs` zu mounten, würde mitgelieferte Dateien des Images überdecken (z. B. `mime.types`, `unicode.mapping`). Der Container läuft deshalb ohne `read_only`, aber mit `cap_drop: ALL` und nur den nötigen Nginx-Capabilities.

### Web-Application-Firewall (WAF) - Security Nachweis
Als WAF wurde owasp/modsecurity-crs (OWASP Core Rule Set) in den Nginx Reverse Proxy integriert. Die WAF analysiert alle eingehenden Anfragen und blockiert bekannte Angriffsmuster (wie SQLi, XSS oder Path Traversal) zuverlässig mit einem 403 Forbidden Status, bevor sie das interne Netzwerk erreichen.

Da das ModSecurity-Image seine Nginx-Konfiguration beim Start aus Templates generiert, wird die eigene Konfiguration als Template (`/etc/nginx/templates/nginx.conf.template`) eingebunden; der PID-Pfad liegt unter `/tmp` (`pid /tmp/nginx.pid;`). Ein vollständig schreibgeschütztes Dateisystem ist mit diesem Image nicht möglich (siehe oben).

Erfolgreiche Funktionstests (Auszug aus den Logs):

1. Abwehr von SQL-Injection (SQLi)

Request: curl -k -I "https://localhost/api/mitglieder?id=1'%20OR%20'1'='1"

WAF-Erkennung (Regel 942100): "message":"SQL Injection Attack Detected via libinjection", "data":"Matched Data: s&sos found within ARGS:id: 1' OR '1'='1"

2. Abwehr von Cross-Site Scripting (XSS)

Request: curl -k -I "https://localhost/?search=<script>alert('XSS')</script>"

WAF-Erkennung (Regeln 941100 / 941110): "message":"XSS Attack Detected via libinjection", "data":"Matched Data: XSS data found within ARGS:search: <script>alert('XSS')</script>"

3. Abwehr von Path Traversal / Local File Inclusion (LFI)

Request: curl -k -I "https://localhost/api/spenden?file=../../../../etc/passwd"

WAF-Erkennung (Regel 930100 / 930120): "message":"Path Traversal Attack (/../) or (/.../)", "data":"Matched Data: /../ found within ARGS:file: ../../../../etc/passwd"

### Multi-Stage-Builds & Vulnerability-Fixes in den Dockerfiles

Backend und Datenbank nutzen Multi-Stage-Builds, um die Angriffsfläche zu minimieren; Backend und Frontend spielen zusätzlich beim Build gepatchte Alpine-Systempakete ein:

**Backend (`backend/Dockerfile`):** `npm install` läuft in einem Builder-Stage; im Runtime-Stage wird die gesamte `npm`-CLI (`npm`, `npx`, `node_modules/npm/`) entfernt. Diese enthält zur Laufzeit nicht benötigte Pakete (u. a. `brace-expansion`, `pacote`, `sigstore`, `picomatch`) mit regelmäßigen CVEs (aktuell 11 HIGH im Base-Image `node:22-alpine`). Zusätzlich spielt `apk upgrade --no-cache` gepatchte Alpine-Systempakete ein (z. B. OpenSSL).

**Frontend (`frontend/Dockerfile`):** `apk upgrade --no-cache` behebt die HIGH-Befunde des Base-Images `nginx:alpine` in `libexpat` und `pcre2`.

**Database (`db/Dockerfile`):** Das offizielle `postgres`-Image enthält ein `gosu`-Binary, das mit einer verwundbaren Go-Stdlib-Version gebaut wurde (CVE-2025-68121, CRITICAL — `crypto/tls`). Da das postgres-Team das Binary nicht zeitnah neu baut, wird `gosu` in Stage 1 frisch aus dem Quellcode mit `golang:1.25-alpine` kompiliert und in Stage 2 das verwundbare Binary im `postgres:17-alpine`-Image überschrieben.

### Sicherheitsscan (Trivy)

Alle eigenen Images wurden mit [Trivy](https://github.com/aquasecurity/trivy) auf HIGH- und CRITICAL-Schwachstellen gescannt. Rohe Reports liegen unter [`security-scan/`](security-scan/) (vor und nach den Fixes).

| Image | Vor den Fixes (Base-Image) | Nach den Fixes |
|---|---|---|
| `it-infra-verein-backend` | 11 HIGH, 0 CRITICAL | **0 HIGH, 0 CRITICAL** |
| `it-infra-verein-frontend` | 2 HIGH, 0 CRITICAL | **0 HIGH, 0 CRITICAL** |
| `it-infra-verein-database` | 21 HIGH, 1 CRITICAL | **0 HIGH, 0 CRITICAL** |

Stand: 2026-10-04.

Reproduktion (aus dem Projektverzeichnis):

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

---

## Lasttests

Die 12 Lasttest-Szenarien (k6) aus den Bewertungskriterien sind unter [`loadtests/`](loadtests/) abgelegt und werden mit `./loadtests/run.sh <szenario>.js` ausgeführt. Alle Szenarien laufen mit 0 Server-Fehlern durch (Stand: 2026-05-25). Details: [`loadtests/README.md`](loadtests/README.md).