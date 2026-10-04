// Kriterium Zeile 26: API-Endpunkt, 10 parallele Anfragen, 0 s Ramp-up, 5 MB Request Body.
import http from 'k6/http';
import { check } from 'k6';
import { BASE_URL, JSON_HEADERS, mitgliedPayload5MB } from './_lib.js';

export const options = {
  insecureSkipTLSVerify: true,
  scenarios: {
    api: {
      executor: 'ramping-vus',
      startVUs: 10,
      stages: [
        { duration: '20s', target: 10 },
      ],
      gracefulRampDown: '0s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<5000'],
  },
};

export default function () {
  const res = http.post(`${BASE_URL}/api/mitglieder`, mitgliedPayload5MB(), JSON_HEADERS);
  check(res, { 'status 201': (r) => r.status === 201 });
}
