# Datenbankschema

## Tabellen

### `mitglieder`

```sql
CREATE TABLE mitglieder (
    id              SERIAL PRIMARY KEY,
    vorname         VARCHAR(100)   NOT NULL,
    nachname        VARCHAR(100)   NOT NULL,
    email           VARCHAR(255)   NOT NULL UNIQUE,
    telefon         VARCHAR(30),
    geburtsdatum    DATE,
    adresse_str     VARCHAR(200),
    adresse_plz     VARCHAR(10),
    adresse_ort     VARCHAR(100),
    mitgliedstyp    VARCHAR(50)    NOT NULL DEFAULT 'regulaer',
    -- z. B. 'regulaer', 'foerder', 'ehrenmitglied'
    status          VARCHAR(30)    NOT NULL DEFAULT 'beantragt',
    -- 'beantragt', 'aktiv', 'gekuendigt', 'abgelehnt'
    beitrittsdatum  DATE,
    erstellt_am     TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    aktualisiert_am TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);
```

### `spenden`

```sql
CREATE TABLE spenden (
    id              SERIAL PRIMARY KEY,
    mitglied_id     INT REFERENCES mitglieder(id) ON DELETE SET NULL,
    -- NULL erlaubt für anonyme Spenden
    spender_name    VARCHAR(200),
    spender_email   VARCHAR(255),
    betrag_cent     INT            NOT NULL CHECK (betrag_cent > 0),
    -- Beträge immer als Cent speichern (kein Float!)
    waehrung        CHAR(3)        NOT NULL DEFAULT 'EUR',
    zweck           VARCHAR(200),
    -- z. B. 'Allgemein', 'Vereinsfest', 'Jugendarbeit'
    zahlungsart     VARCHAR(50),
    -- 'ueberweisung', 'paypal', 'stripe', etc.
    transaktions_id VARCHAR(255)   UNIQUE,
    -- Externe Referenz vom Zahlungsanbieter
    status          VARCHAR(30)    NOT NULL DEFAULT 'ausstehend',
    -- 'ausstehend', 'bestaetigt', 'storniert'
    quittung_nr     VARCHAR(50)    UNIQUE,
    -- für steuerliche Spendenquittungen
    erstellt_am     TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);
```

---

## Indizes & ergänzende Objekte

```sql
-- Performance-Indizes
-- mitglieder(email) ist über die UNIQUE-Constraint bereits indiziert
CREATE INDEX idx_mitglieder_status ON mitglieder(status);
CREATE INDEX idx_spenden_mitglied  ON spenden(mitglied_id);
CREATE INDEX idx_spenden_status    ON spenden(status);
CREATE INDEX idx_spenden_erstellt  ON spenden(erstellt_am);

-- Automatisches Update von aktualisiert_am bei Mitgliedern
CREATE OR REPLACE FUNCTION set_aktualisiert_am()
RETURNS TRIGGER AS $$
BEGIN NEW.aktualisiert_am = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_mitglieder_aktualisiert
BEFORE UPDATE ON mitglieder
FOR EACH ROW EXECUTE FUNCTION set_aktualisiert_am();
```

---

## Weitere Anmerkungen

### Wichtige Designentscheidungen

- **Geldbeträge als `INT` (Cent), nie als `FLOAT`** – Fließkommazahlen führen bei Geldwerten zu Rundungsfehlern. `1500` im Feld bedeutet also 15,00 €.
- **Anonyme Spenden sind erlaubt:** `mitglied_id` ist NULL-fähig, `spender_name` und `spender_email` können direkt befüllt werden, wenn kein Mitgliedskonto vorhanden ist.
- **Status-Felder als `VARCHAR` statt `ENUM`** halten das Schema flexibel, falls neue Statuswerte hinzukommen – alternativ bietet PostgreSQL natürlich auch `CREATE TYPE … AS ENUM` an.
- **`transaktions_id` mit `UNIQUE`-Constraint** verhindert doppelte Buchungen, falls der Zahlungsanbieter einen Webhook mehrfach sendet (Idempotenz).
- **`quittung_nr`** ist auf Wunsch ein separates Feld, das erst nach Bestätigung der Zahlung vergeben wird – das vereinfacht die Generierung steuerlicher Spendenquittungen.

### Beziehung zwischen den Tabellen

```
mitglieder (1) ──────────────── (0..n) spenden
│                                      │
mitglied_id                            mitglied_id (FK, NULL möglich)
```

Ein Mitglied kann beliebig viele Spenden haben, aber eine Spende muss keinem Mitglied zugeordnet sein.
