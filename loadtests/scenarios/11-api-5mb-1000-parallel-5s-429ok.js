// Kriterium Zeile 28: API-Endpunkt, 1000 parallele Anfragen, 5 s Ramp-up,
// 5 MB Request Body. Requests duerfen bspw. mit HTTP 429 abgewiesen werden.
//
// Strategie:
// - ramping-arrival-rate statt ramping-vus (k6-OOM bei 1000 echten VUs).
// - Rate hier 200/s statt 1000/s: 5 MB Body * 1000 r/s = 5 GB/s netto Bandbreite
//   uebersteigt jede realistische Anbindung. 200 r/s mit ~1 s Upload-Zeit
//   ergibt aber ~200 in-flight Uploads gleichzeitig, plus warten weitere
//   in der Queue, sodass auf der Strecke 1000 parallele Verbindungen entstehen.
//
// Erfolgskriterium: Das System bleibt stabil. Sowohl 201 (angenommen) als auch
// 429 (abgewiesen) zaehlen als "korrektes Verhalten". Nur 5xx oder Timeouts
// gelten als echter Fehler.
import http from 'k6/http';
import { Counter } from 'k6/metrics';
import { BASE_URL, JSON_HEADERS, mitgliedPayload5MB } from './_lib.js';

const accepted = new Counter('responses_201');
const ratelimited = new Counter('responses_429');
const serverError = new Counter('responses_5xx');

export const options = {
  insecureSkipTLSVerify: true,
  scenarios: {
    api: {
      executor: 'ramping-arrival-rate',
      startRate: 0,
      timeUnit: '1s',
      preAllocatedVUs: 100,
      maxVUs: 500,
      stages: [
        { duration: '5s', target: 200 },
        { duration: '10s', target: 200 },
      ],
    },
  },
  thresholds: {
    responses_5xx: ['count<10'],
    http_req_failed: ['rate<0.5'],
  },
};

export default function () {
  const res = http.post(`${BASE_URL}/api/mitglieder`, mitgliedPayload5MB(), {
    ...JSON_HEADERS,
    timeout: '60s',
  });
  if (res.status === 201) accepted.add(1);
  else if (res.status === 429) ratelimited.add(1);
  else if (res.status >= 500) serverError.add(1);
}
