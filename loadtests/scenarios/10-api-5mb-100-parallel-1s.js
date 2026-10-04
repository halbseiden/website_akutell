// Kriterium Zeile 27: API-Endpunkt, 100 parallele Anfragen, 1 s Ramp-up, 5 MB Request Body.
import http from 'k6/http';
import { check } from 'k6';
import { BASE_URL, JSON_HEADERS, mitgliedPayload5MB } from './_lib.js';

export const options = {
  insecureSkipTLSVerify: true,
  scenarios: {
    api: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '1s', target: 100 },
        { duration: '30s', target: 100 },
      ],
      gracefulRampDown: '0s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.05'],
    http_req_duration: ['p(95)<10000'],
  },
};

export default function () {
  const res = http.post(`${BASE_URL}/api/mitglieder`, mitgliedPayload5MB(), JSON_HEADERS);
  check(res, { 'status 201': (r) => r.status === 201 });
}
