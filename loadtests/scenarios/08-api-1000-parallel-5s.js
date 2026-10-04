// Kriterium Zeile 25: API-Endpunkt, 1000 parallele Anfragen, 5 s Ramp-up, normale Requests.
// Siehe 03 fuer Begruendung der ramping-arrival-rate-Strategie.
import http from 'k6/http';
import { check } from 'k6';
import { BASE_URL, JSON_HEADERS, mitgliedPayload } from './_lib.js';

export const options = {
  insecureSkipTLSVerify: true,
  scenarios: {
    api: {
      executor: 'ramping-arrival-rate',
      startRate: 0,
      timeUnit: '1s',
      preAllocatedVUs: 100,
      maxVUs: 300,
      stages: [
        { duration: '5s', target: 1000 },
        { duration: '5s', target: 1000 },
      ],
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.05'],
    http_req_duration: ['p(95)<5000'],
  },
};

export default function () {
  const res = http.post(`${BASE_URL}/api/mitglieder`, mitgliedPayload(), JSON_HEADERS);
  check(res, { 'status 201': (r) => r.status === 201 });
}
