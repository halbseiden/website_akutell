// Gemeinsame Helpers fuer alle k6-Szenarien.
//
// Adressierung: Die Tests laufen im Docker-Netz `it-infra-verein_public-net` und
// sprechen den Reverse-Proxy unter seinem Service-DNS-Namen an. Damit
// umgehen wir das Port-Forwarding von Docker Desktop unter macOS, das
// bei 1000 parallelen Verbindungen selbst zum Flaschenhals wuerde.
//
// TLS-Zertifikat ist self-signed -> Verify ausschalten (siehe insecureSkipTLSVerify
// in den `options` der jeweiligen Szenario-Datei).

export const BASE_URL = __ENV.BASE_URL || 'https://reverse-proxy';

// Einen eindeutigen Mitglied-Payload pro Iteration erzeugen,
// damit die UNIQUE-Constraint auf der Mail nicht 409-Konflikte produziert.
export function mitgliedPayload(extra = {}) {
  const id = `${__VU}-${__ITER}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return JSON.stringify({
    vorname: 'Last',
    nachname: 'Test',
    email: `loadtest-${id}@test.de`,
    telefon: '030 1234567',
    geburtsdatum: '2000-01-01',
    adresse_str: 'Teststr. 1',
    adresse_plz: '10115',
    adresse_ort: 'Berlin',
    mitgliedstyp: 'regulaer',
    ...extra,
  });
}

// 5 MB JSON-Payload: gueltiges Mitglied + Padding-String, der vom Backend
// per Destructuring ignoriert wird. Bleibt valides JSON.
const PADDING_5MB = 'X'.repeat(5 * 1024 * 1024 - 1024); // ~5 MB minus Overhead fuer den Rest

export function mitgliedPayload5MB() {
  return mitgliedPayload({ _padding: PADDING_5MB });
}

export const JSON_HEADERS = { headers: { 'Content-Type': 'application/json' } };
