// Kriterium Zeile 23: API-Endpunkt, 10 parallele Anfragen, 0 s Ramp-up, normale Requests.
import http from 'k6/http';
import { check } from 'k6';
import { BASE_URL, JSON_HEADERS, mitgliedPayload } from './_lib.js';

export const options = {
  insecureSkipTLSVerify: true,
  scenarios: {
    api: {
      executor: 'ramping-vus',
      startVUs: 10,
      stages: [
        { duration: '15s', target: 10 },
      ],
      gracefulRampDown: '0s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<2000'],
  },
};

export default function () {
  const res = http.post(`${BASE_URL}/api/mitglieder`, mitgliedPayload(), JSON_HEADERS);
  check(res, { 'status 201': (r) => r.status === 201 });
}
