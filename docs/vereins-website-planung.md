# Projektplanung: Vereins-Website

## 1. Anwendungsbeschreibung

Die geplante Anwendung ist eine containerisierte Website für einen Verein, die potenziellen Mitgliedern eine öffentlich zugängliche Webpräsenz bietet und gleichzeitig eine vollständige Mitgliederverwaltung im Hintergrund abwickelt. Die Website richtet sich an Interessierte, die sich über den Verein informieren und über ein Onlineformular eine Mitgliedschaft beantragen möchten.

Das System besteht aus einer statischen Frontend-Oberfläche, die dem Besucher die Startseite des Vereins sowie ein Mitgliedsantragsformular präsentiert. Sobald ein Besucher das Formular ausfüllt und absendet, wird der HTTP-Request über einen Reverse Proxy an einen Load Balancer weitergeleitet, der die Anfrage an eine von zwei redundanten Backend-Instanzen verteilt. Das Backend validiert die übermittelten Daten und speichert den neuen Mitgliedseintrag dauerhaft in einer PostgreSQL-Datenbank.

Die Infrastruktur wird vollständig mit Docker und Docker Compose betrieben. Jeder logische Dienst läuft in einem eigenen, isolierten Container. Die Kommunikation zwischen den Komponenten erfolgt über definierte Docker-Netzwerke, wobei die Datenbank und die Backend-Instanzen ausschließlich über ein internes Netzwerk erreichbar sind und keinerlei direkten Zugriff aus dem Internet ermöglichen. Der einzige nach außen exponierte Einstiegspunkt ist der Reverse Proxy auf Port 80. Persistente Daten – insbesondere der Inhalt der Datenbank – werden über ein benanntes Docker Volume gesichert, sodass sie bei einem Neustart oder Rebuild der Container erhalten bleiben.

---

## 2. Netzwerk- und Komponentenarchitektur

### 2.1 Alle Container mit Namen und Images

| Container-Name     | Image / Build-Quelle         | Aufgabe                                              |
|--------------------|------------------------------|------------------------------------------------------|
| `reverse-proxy`    | `nginx:alpine`               | Einziger nach außen exponierter Einstiegspunkt; leitet `/` ans Frontend und `/api/` an den Load Balancer weiter |
| `frontend`         | `./frontend` (eigenes Build) | Statische Vereins-Website (HTML/CSS); ausgeliefert via Nginx |
| `load-balancer`    | `nginx:alpine`               | Verteilt API-Anfragen per Round-Robin auf `backend-1` und `backend-2` |
| `backend-1`        | `./backend` (eigenes Build)  | Node.js-Anwendungsserver; verarbeitet Mitgliedsanträge, schreibt in die Datenbank |
| `backend-2`        | `./backend` (eigenes Build)  | Identische zweite Backend-Instanz für Redundanz und Lastverteilung |
| `database`         | `postgres:15-alpine`         | PostgreSQL-Datenbankserver; speichert Mitgliederdaten persistent |

### 2.2 Docker-Netzwerke und enthaltene Container

Das System verwendet zwei logisch getrennte Netzwerke:

**`public-net`** (externes Netzwerk, Bridge-Modus):
Enthält alle Dienste, die mittelbar oder unmittelbar mit eingehenden Client-Anfragen in Berührung kommen.
- `reverse-proxy`
- `frontend`
- `load-balancer`

**`internal-net`** (internes Netzwerk, `internal: true`):
Dieses Netzwerk ist vollständig vom Internet isoliert – kein Container darin ist direkt von außen erreichbar. Docker verhindert auf Netzwerkebene jegliches Routing nach außen.
- `load-balancer` *(Brückenelement: Mitglied beider Netzwerke)*
- `backend-1`
- `backend-2`
- `database`

> **Hinweis zur Isolation:** Der `load-balancer` ist das einzige Gateway zwischen `public-net` und `internal-net`. Die `database` ist ausschließlich im `internal-net` und besitzt keinen exponierten Host-Port.

### 2.3 Datenfluss: Client → Reverse Proxy → Load Balancer → Service-Container

```
Client (Browser)
       │
       │  HTTP-Request (Port 80)
       ▼
┌─────────────────────┐   public-net
│   reverse-proxy     │
│   (nginx:alpine)    │
└─────────────────────┘
       │
       │  Pfad /  → weiterleiten an frontend:80
       │  Pfad /api/ → weiterleiten an load-balancer:80
       │
       ├──────────────────────────────────┐
       ▼                                  ▼
┌────────────┐                  ┌──────────────────┐   public-net
│  frontend  │                  │  load-balancer   │
│ (nginx)    │                  │  (nginx:alpine)  │
└────────────┘                  └──────────────────┘
  Liefert HTML/CSS                        │         ──── Grenze public-net / internal-net ────
  direkt an Client                        │
                                          │  Round-Robin
                              ┌───────────┴───────────┐
                              ▼                       ▼
                     ┌─────────────┐        ┌─────────────┐   internal-net
                     │  backend-1  │        │  backend-2  │
                     │ (Node.js)   │        │ (Node.js)   │
                     └─────────────┘        └─────────────┘
                              │                       │
                              └───────────┬───────────┘
                                          ▼
                                 ┌─────────────────┐   internal-net
                                 │    database     │
                                 │ (postgres:15)   │
                                 └─────────────────┘
                                          │
                                          ▼
                                   db-data (Volume)
```

**Konkrete Anfrage-Beispiele:**

- `GET /` → `reverse-proxy` → `frontend` → HTML-Seite zurück an Client
- `GET /mitglied-werden.html` → `reverse-proxy` → `frontend` → Formular-HTML zurück an Client
- `POST /api/mitglieder` → `reverse-proxy` → `load-balancer` → `backend-1` oder `backend-2` → `database` → Erfolgsantwort zurück

### 2.4 Volumes und Zuordnung

| Volume-Name | Zugeordneter Container | Pfad im Container                  | Inhalt                       |
|-------------|------------------------|------------------------------------|------------------------------|
| `db-data`   | `database`             | `/var/lib/postgresql/data`         | PostgreSQL-Datenbankdateien  |

Zusätzlich werden Konfigurationsdateien als **Read-only Bind Mounts** eingebunden (keine persistenten Volumes, da sie aus dem Repository stammen):

| Bind Mount (Host)                    | Container          | Pfad im Container         |
|--------------------------------------|--------------------|---------------------------|
| `./nginx/reverse-proxy.conf`         | `reverse-proxy`    | `/etc/nginx/nginx.conf`   |
| `./nginx/load-balancer.conf`         | `load-balancer`    | `/etc/nginx/nginx.conf`   |
| `./database/init.sql`                | `database`         | `/docker-entrypoint-initdb.d/init.sql` |

### 2.5 Exponierte Ports

Gemäß der Anforderung wird **ausschließlich am Reverse Proxy** ein Port nach außen (Host) geöffnet:

| Container       | Host-Port | Container-Port | Protokoll |
|-----------------|-----------|----------------|-----------|
| `reverse-proxy` | `80`      | `80`           | HTTP      |

Alle anderen Container besitzen **keine `ports:`-Direktive** in der `docker-compose.yml` und sind ausschließlich über den internen Docker-DNS (Service-Name) innerhalb der definierten Netzwerke erreichbar.

---

## 3. Service-Abhängigkeiten (Dependency-Diagramm)

### 3.1 depends_on-Beziehungen und Start-Reihenfolge

Docker Compose startet die Services in der durch `depends_on` definierten Reihenfolge. Mit `condition: service_healthy` wird sichergestellt, dass ein Service erst dann als bereit gilt, wenn sein Health Check erfolgreich durchgelaufen ist – nicht nur wenn der Container-Prozess gestartet hat.

**Start-Reihenfolge (von unten nach oben):**

```
Stufe 1 (kein depends_on):
  └── database

Stufe 2 (depends_on: database, condition: service_healthy):
  ├── backend-1
  └── backend-2

Stufe 3 (depends_on: backend-1, backend-2):
  └── load-balancer

Stufe 4 (depends_on: load-balancer):
  └── frontend

Stufe 5 (depends_on: frontend, load-balancer):
  └── reverse-proxy
```

**Vollständige `depends_on`-Matrix:**

| Service         | Hängt ab von          | Bedingung               |
|-----------------|-----------------------|-------------------------|
| `backend-1`     | `database`            | `condition: service_healthy` |
| `backend-2`     | `database`            | `condition: service_healthy` |
| `load-balancer` | `backend-1`, `backend-2` | `condition: service_started` |
| `frontend`      | `load-balancer`       | `condition: service_started` |
| `reverse-proxy` | `frontend`, `load-balancer` | `condition: service_started` |

### 3.2 Health Checks

```yaml
database:
  healthcheck:
    test: ["CMD-SHELL", "pg_isready -U vereinuser -d vereindb"]
    interval: 10s       # Prüfung alle 10 Sekunden
    timeout: 5s         # Antwort muss innerhalb von 5 Sekunden kommen
    retries: 5          # 5 Fehlschläge → Status "unhealthy"
    start_period: 20s   # 20 Sekunden Anlaufzeit vor der ersten Prüfung

backend-1: &backend-health
  healthcheck:
    test: ["CMD-SHELL", "wget -qO- http://localhost:3000/health || exit 1"]
    interval: 10s
    timeout: 5s
    retries: 3
    start_period: 15s

backend-2:
  <<: *backend-health   # Identische Konfiguration via YAML-Anker

frontend:
  healthcheck:
    test: ["CMD-SHELL", "wget -qO- http://localhost:80/ | head -c 1 || exit 1"]
    interval: 15s
    timeout: 5s
    retries: 3
    start_period: 10s

reverse-proxy:
  healthcheck:
    test: ["CMD-SHELL", "wget -qO- http://localhost:80/ | head -c 1 || exit 1"]
    interval: 15s
    timeout: 5s
    retries: 3
    start_period: 10s

load-balancer:
  healthcheck:
    test: ["CMD-SHELL", "wget -qO- http://localhost:80/ | head -c 1 || exit 1"]
    interval: 10s
    timeout: 5s
    retries: 3
    start_period: 10s
```

Die `database` nutzt `pg_isready`, um zu prüfen, ob PostgreSQL tatsächlich Verbindungen akzeptiert. Die Backend-Instanzen exponieren einen `/health`-Endpunkt, der intern abgefragt wird.

### 3.3 Ausfallauswirkungen

Die folgende Tabelle beschreibt, welche Services bei einem Ausfall eines einzelnen Dienstes betroffen sind:

| Ausgefallener Service | Direkt betroffene Services | Gesamtauswirkung auf die Anwendung |
|-----------------------|---------------------------|-------------------------------------|
| `database`            | `backend-1`, `backend-2`  | **Kritisch:** Keine neuen Mitgliedsanträge können gespeichert werden. Frontend bleibt erreichbar, API gibt Fehler zurück. |
| `backend-1`           | *(keiner)*                | **Kein Ausfall:** `load-balancer` leitet alle Anfragen automatisch an `backend-2` weiter. |
| `backend-2`           | *(keiner)*                | **Kein Ausfall:** `load-balancer` leitet alle Anfragen automatisch an `backend-1` weiter. |
| `backend-1` + `backend-2` | `load-balancer`       | **Kritisch:** Keine API-Anfragen mehr möglich. Frontend bleibt erreichbar, Formular-Absendung schlägt fehl. |
| `load-balancer`       | `reverse-proxy` (teilweise) | **Teilausfall:** API nicht erreichbar, `/api/`-Pfade schlagen fehl. Frontend-Seiten bleiben ladbar. |
| `frontend`            | `reverse-proxy` (teilweise) | **Teilausfall:** Startseite nicht erreichbar. API-Endpunkte technisch weiterhin nutzbar. |
| `reverse-proxy`       | Alle                      | **Totalausfall:** Keine Anfragen von außen erreichen das System mehr. |


## 4. Monitoring-Konzept

Ziel des Monitoring-Konzepts ist es, die Funktionsfähigkeit und Auslastung der containerisierten Vereins-Website-Infrastruktur kontinuierlich zu überwachen, Probleme frühzeitig zu erkennen und bei kritischen Zuständen automatisch zu alarmieren.


### Ebene 1 – Container-Gesundheit

#### Health-Check-Endpunkte der selbst entwickelten Services

Alle selbst entwickelten Services (`backend-1`, `backend-2`, `frontend`) stellen einen dedizierten HTTP-Endpunkt bereit, der ausschließlich zur Integritätsprüfung dient.

**Backend (Node.js) – `GET /health`:**

```js
// server.js – Health-Check-Endpunkt
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');          // Datenbankverbindung prüfen
    res.status(200).json({
      status: 'healthy',
      db: 'connected',
      uptime: process.uptime()
    });
  } catch (err) {
    res.status(503).json({ status: 'unhealthy', db: 'disconnected' });
  }
});
```

Der Backend-Health-Check gibt HTTP 200 zurück, wenn der Node.js-Prozess läuft **und** die Datenbankverbindung aktiv ist. HTTP 503 signalisiert einen ungesunden Zustand.

**Frontend (Nginx) – impliziter HTTP-Check:**

Da das Frontend ausschließlich statische Dateien ausliefert, wird kein eigener Endpunkt benötigt. Der Health Check prüft, ob Nginx auf Port 80 mit HTTP 200 antwortet:

```bash
wget -qO- http://localhost:80/ | head -c 1 || exit 1
```

#### Docker-integrierter `healthcheck`-Mechanismus

(siehe unter 3.)

#### Bedingungen für den Status „unhealthy"

Ein Container wird von Docker als **unhealthy** markiert, wenn der `test`-Befehl des Health Checks die konfigurierte Anzahl an Malen (`retries`) **nacheinander** mit einem Exit-Code ≠ 0 zurückkehrt oder die `timeout`-Grenze überschreitet. Die `start_period` stellt sicher, dass Fehlschläge während der Anlaufphase eines Containers nicht als echte Fehler gezählt werden.

| Container       | Unhealthy-Bedingung                                                                 |
|-----------------|-------------------------------------------------------------------------------------|
| `database`      | `pg_isready` schlägt 5× fehl → PostgreSQL akzeptiert keine Verbindungen mehr       |
| `backend-1/2`   | `/health`-Endpunkt antwortet nicht mit HTTP 200 (z. B. Prozess abgestürzt oder DB getrennt) nach 3 Versuchen |
| `frontend`      | Nginx liefert keine HTTP-Antwort auf Port 80 nach 3 Versuchen                      |
| `reverse-proxy` | Nginx antwortet nicht auf eingehende Anfragen nach 3 Versuchen                     |
| `load-balancer` | Nginx-Prozess antwortet nicht intern nach 3 Versuchen                              |

---

### Ebene 2 – Metriken-Erfassung

**Gewählte Option: Option 1 – Prometheus + Grafana**

Prometheus scraped in konfigurierten Intervallen Metriken von allen Exportern. Grafana visualisiert die gesammelten Zeitreihendaten in einem Dashboard. Zusätzlich wird `cAdvisor` eingesetzt, um Container-Ressourcenmetriken (CPU, RAM, Netzwerk) bereitzustellen, ohne dass die Anwendungscontainer selbst verändert werden müssen.

#### Zusätzliche Monitoring-Container in `docker-compose.yml`

```yaml
  prometheus:
    image: prom/prometheus:latest
    container_name: prometheus
    volumes:
      - ./monitoring/prometheus.yml:/etc/prometheus/prometheus.yml:ro
      - prometheus-data:/prometheus
    networks:
      - internal-net
    restart: unless-stopped

  grafana:
    image: grafana/grafana:latest
    container_name: grafana
    ports:
      - "3001:3000"    # Grafana-Dashboard erreichbar auf Port 3001
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=admin123
    volumes:
      - grafana-data:/var/lib/grafana
    networks:
      - internal-net
    depends_on:
      - prometheus
    restart: unless-stopped

  cadvisor:
    image: gcr.io/cadvisor/cadvisor:latest
    container_name: cadvisor
    volumes:
      - /:/rootfs:ro
      - /var/run:/var/run:ro
      - /sys:/sys:ro
      - /var/lib/docker/:/var/lib/docker:ro
    networks:
      - internal-net
    restart: unless-stopped

  nginx-exporter:
    image: nginx/nginx-prometheus-exporter:latest
    container_name: nginx-exporter
    command:
      - '--nginx.scrape-uri=http://reverse-proxy:80/stub_status'
    networks:
      - internal-net
    depends_on:
      - reverse-proxy
    restart: unless-stopped

volumes:
  prometheus-data:
  grafana-data:
```

#### Prometheus-Konfiguration (`monitoring/prometheus.yml`)

```yaml
global:
  scrape_interval: 15s

scrape_configs:
  - job_name: 'cadvisor'
    static_configs:
      - targets: ['cadvisor:8080']

  - job_name: 'nginx-exporter'
    static_configs:
      - targets: ['nginx-exporter:9113']

  - job_name: 'backend'
    static_configs:
      - targets: ['backend-1:3000', 'backend-2:3000']
    metrics_path: /metrics
```

> **Hinweis:** Der Backend-Node.js-Service wird mit dem Paket `prom-client` erweitert, das automatisch einen `/metrics`-Endpunkt mit HTTP-Request-Zählern, Antwortzeiten und Node.js-Prozessmetriken bereitstellt.

#### Überwachte Metriken – tabellarische Übersicht

| Metrik | Beschreibung | Quelle | Warnschwellwert | Kritischer Schwellwert |
|--------|-------------|--------|-----------------|------------------------|
| `container_cpu_usage_seconds_total` | CPU-Auslastung je Container | cAdvisor | > 70 % über 5 min | > 90 % über 2 min |
| `container_memory_usage_bytes` | RAM-Auslastung je Container | cAdvisor | > 80 % des Limits | > 95 % des Limits |
| `nginx_connections_active` | Aktive HTTP-Verbindungen am Reverse Proxy | nginx-exporter | > 500 | > 1000 |
| `nginx_http_requests_total` | Gesamtanzahl HTTP-Requests (Rate) | nginx-exporter | — | Abrupter Abfall auf 0 |
| `http_request_duration_seconds` | Antwortzeiten der Backend-API (p95) | prom-client (Backend) | > 500 ms | > 2000 ms |
| `http_requests_total` | Request-Rate je Backend-Instanz | prom-client (Backend) | — | Ungleichgewicht > 80/20 |
| `up` | Erreichbarkeit aller Scrape-Targets | Prometheus intern | — | = 0 (Target nicht erreichbar) |
| `pg_up` | PostgreSQL-Verfügbarkeit | postgres-exporter (optional) | — | = 0 |

---

### Ebene 3 – Alerting

**Gewählte Maßnahme: Grafana Alerting mit definierten Alert-Regeln**

Grafana Alerting ist bereits im Grafana-Container integriert und erfordert keine zusätzliche Infrastruktur. Alerts werden über einen konfigurierten Webhook oder per E-Mail (SMTP-Konfiguration in Grafana) versandt.

#### Definierte Alert-Regeln

| Alert-Name | Bedingung | Schwellwert | Benachrichtigungskanal |
|------------|-----------|-------------|------------------------|
| `BackendDown` | `up{job="backend"} == 0` für > 30 s | 0 erreichbare Backends | E-Mail + Webhook |
| `DatabaseDown` | `up{job="cadvisor", container="database"} == 0` | Container nicht erreichbar | E-Mail |
| `HighCPU` | `container_cpu_usage > 0.9` für > 2 min | > 90 % CPU | Webhook |
| `HighMemory` | `container_memory_usage_bytes > 0.95 * limit` | > 95 % RAM | Webhook |
| `SlowAPIResponse` | `http_request_duration_seconds{quantile="0.95"} > 2` | p95 > 2 s | E-Mail |

#### Eskalationsweg bei Service-Ausfall

```
Container wird "unhealthy"
         │
         ▼
Docker prüft restart-Policy (restart: unless-stopped)
         │
         ├── Automatischer Neustart-Versuch (bis zu 3×)
         │
         ├── Neustart erfolgreich → Grafana-Alert löst sich auf, Benachrichtigung "Resolved"
         │
         └── Neustart schlägt fehl
                  │
                  ▼
         Grafana Alert feuert → E-Mail/Webhook an Systemadministrator
                  │
                  ▼
         Manueller Eingriff erforderlich:
         - Logs prüfen: docker logs <container>
         - Status prüfen: docker inspect <container>
         - Ggf. Datenbank-Volume prüfen oder Backend-Code-Fehler beheben
```

#### Automatisches Verhalten vs. manueller Eingriff

Alle Anwendungscontainer erhalten die Restart-Policy `restart: unless-stopped` in der `docker-compose.yml`. Diese bewirkt, dass Docker bei einem Absturz oder einem `unhealthy`-Status automatisch einen Neustart versucht.

| Zustand | Automatische Reaktion | Manueller Eingriff nötig? |
|---------|-----------------------|---------------------------|
| Container stürzt ab (Exit-Code ≠ 0) | Docker startet Container sofort neu | Nein – bei einmaligem Fehler |
| Container bleibt dauerhaft `unhealthy` nach 3 Neustarts | Docker startet weiter neu (Backoff-Intervall steigt) | **Ja** – Ursachenanalyse via `docker logs` |
| `database`-Container `unhealthy` | Docker startet Datenbank neu; Backends warten (Health-Check-Abhängigkeit greift beim initialen Start, nicht im laufenden Betrieb) | **Ja** – bei Datenverlust oder Korruption |
| `backend-1` `unhealthy`, `backend-2` gesund | Load Balancer leitet automatisch nur an `backend-2` (Nginx upstream health) | Nein – Redundanz greift |
| Beide Backends `unhealthy` | Alle API-Anfragen schlagen fehl (503) | **Ja** – sofortiger Eingriff erforderlich |
| `reverse-proxy` `unhealthy` | Docker startet neu; in der Zwischenzeit kein externer Zugriff | **Ja** – Single Point of Failure |

