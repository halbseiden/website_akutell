const fs = require('fs');
const express = require('express');
const { Pool } = require('pg');
const promClient = require('prom-client');

const pool = new Pool({
  host: process.env.POSTGRES_HOST || 'database',
  port: Number(process.env.POSTGRES_PORT) || 5432,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD_FILE
    ? fs.readFileSync(process.env.POSTGRES_PASSWORD_FILE, 'utf8').trim()
    : process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB,
});

// Bricht die DB eine ruhende Pool-Verbindung ab (z. B. bei Neustart/Ausfall),
// meldet der Pool ein 'error'-Event. Ohne Handler würde Node daran abstürzen;
// so wird nur geloggt, und /health bzw. die API antworten mit 503/500.
pool.on('error', (err) => {
  console.error('DB-Verbindung im Pool verloren:', err.message);
});

// Postgres-Fehler, die auf ungültige Eingaben zurückgehen, sind Client-Fehler
// (400) und kein Datenbankausfall (500): Klasse 22 = data exception, z. B.
// 22001 Text zu lang, 22007/22008 ungültiges Datum, 22P02 ungültiges Format,
// 22003 Zahl außerhalb des Wertebereichs; 23514 = CHECK-Constraint verletzt.
function isInputError(err) {
  return typeof err.code === 'string'
    && (err.code.startsWith('22') || err.code === '23514');
}
const INPUT_ERROR_MESSAGE =
  'Ungültige Eingabe: Bitte prüfen Sie die Felder (z. B. Datumsformat oder Länge).';

const app = express();
// 6 MB Limit: deckt die Kriterien-Lasttests mit 5 MB Request-Body ab.
app.use(express.json({ limit: '6mb' }));

// --- Prometheus-Metriken ---
promClient.collectDefaultMetrics();
const httpRequestDuration = new promClient.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Dauer von HTTP-Requests in Sekunden',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5],
});

app.use((req, res, next) => {
  const end = httpRequestDuration.startTimer();
  res.on('finish', () => {
    end({
      method: req.method,
      // Nur definierte Routen als Label verwenden: req.path würde für jeden
      // unbekannten Pfad (z. B. /api/xyz123) eine neue Zeitreihe anlegen und
      // Prometheus sowie den Backend-Speicher unbegrenzt wachsen lassen.
      route: req.route?.path || 'unmatched',
      status_code: res.statusCode,
    });
  });
  next();
});

// --- Health-Check ---
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.status(200).json({
      status: 'healthy',
      db: 'connected',
      uptime: process.uptime(),
    });
  } catch (err) {
    res.status(503).json({ status: 'unhealthy', db: 'disconnected' });
  }
});

// --- Prometheus-Scrape-Endpunkt ---
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', promClient.register.contentType);
  res.end(await promClient.register.metrics());
});

// --- Mitgliedsantrag ---
app.post('/api/mitglieder', async (req, res) => {
  const {
    vorname, nachname, email,
    telefon, geburtsdatum,
    adresse_str, adresse_plz, adresse_ort,
    mitgliedstyp,
  } = req.body;

  if (!vorname || !nachname || !email) {
    return res.status(400).json({
      error: 'vorname, nachname und email sind Pflichtfelder',
    });
  }

  try {
    const result = await pool.query(
      `INSERT INTO mitglieder
         (vorname, nachname, email, telefon, geburtsdatum,
          adresse_str, adresse_plz, adresse_ort, mitgliedstyp)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, 'regulaer'))
       RETURNING id`,
      [vorname, nachname, email, telefon, geburtsdatum,
       adresse_str, adresse_plz, adresse_ort, mitgliedstyp],
    );
    res.status(201).json({ id: result.rows[0].id });
  } catch (err) {
    // 23505 = unique_violation (E-Mail bereits vergeben)
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Diese E-Mail ist bereits registriert' });
    }
    if (isInputError(err)) {
      return res.status(400).json({ error: INPUT_ERROR_MESSAGE });
    }
    console.error('Fehler bei Mitgliedsantrag:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// --- Spende ---
app.post('/api/spenden', async (req, res) => {
  const {
    spender_name, spender_email,
    betrag_cent, waehrung,
    zweck, zahlungsart,
  } = req.body;

  if (!Number.isInteger(betrag_cent) || betrag_cent <= 0) {
    return res.status(400).json({
      error: 'betrag_cent ist erforderlich und muss eine positive Ganzzahl sein',
    });
  }

  try {
    const result = await pool.query(
      `INSERT INTO spenden
         (spender_name, spender_email, betrag_cent, waehrung, zweck, zahlungsart)
       VALUES ($1, $2, $3, COALESCE($4, 'EUR'), $5, $6)
       RETURNING id`,
      [spender_name, spender_email, betrag_cent, waehrung, zweck, zahlungsart],
    );
    res.status(201).json({ id: result.rows[0].id });
  } catch (err) {
    if (isInputError(err)) {
      return res.status(400).json({ error: INPUT_ERROR_MESSAGE });
    }
    console.error('Fehler bei Spende:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

const port = Number(process.env.PORT) || 3000;
const server = app.listen(port, () => {
  console.log(`Backend lauscht auf Port ${port}`);
});

// `docker stop` sendet SIGTERM: keine neuen Verbindungen mehr annehmen,
// laufende Requests beenden, DB-Pool schließen. Spätestens nach 8 s hart
// beenden, bevor Docker nach 10 s mit SIGKILL nachhilft.
process.on('SIGTERM', () => {
  console.log('SIGTERM empfangen, fahre herunter …');
  setTimeout(() => process.exit(1), 8000).unref();
  server.close(() => {
    pool.end().then(() => process.exit(0));
  });
});
