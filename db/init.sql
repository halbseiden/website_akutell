-- Schema für die Vereins-Datenbank
-- Wird von postgres:17-alpine beim ersten Start automatisch ausgeführt,
-- sofern das Daten-Volume noch leer ist.

-- ---------------------------------------------------------------
-- Tabellen
-- ---------------------------------------------------------------

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

-- ---------------------------------------------------------------
-- Indizes
-- ---------------------------------------------------------------

-- Kein eigener Index auf mitglieder(email): die UNIQUE-Constraint legt bereits einen an.
CREATE INDEX idx_mitglieder_status ON mitglieder(status);
CREATE INDEX idx_spenden_mitglied  ON spenden(mitglied_id);
CREATE INDEX idx_spenden_status    ON spenden(status);
CREATE INDEX idx_spenden_erstellt  ON spenden(erstellt_am);


-- ---------------------------------------------------------------
-- Trigger: aktualisiert_am automatisch pflegen
-- ---------------------------------------------------------------

CREATE OR REPLACE FUNCTION set_aktualisiert_am()
RETURNS TRIGGER AS $$
BEGIN
    NEW.aktualisiert_am = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_mitglieder_aktualisiert
BEFORE UPDATE ON mitglieder
FOR EACH ROW EXECUTE FUNCTION set_aktualisiert_am();
