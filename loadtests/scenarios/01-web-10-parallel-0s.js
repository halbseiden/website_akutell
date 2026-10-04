// Kriterium Zeile 17: Web-Endpunkt, 10 parallele Anfragen, 0 s Ramp-up.
import http from 'k6/http';
import { check } from 'k6';
import { BASE_URL } from './_lib.js';

export const options = {
  insecureSkipTLSVerify: true,
  scenarios: {
    web: {
      executor: 'ramping-vus',
      startVUs: 10,
      stages: [
        { duration: '15s', target: 10 }, // 10 VUs sofort, 15 s halten
      ],
      gracefulRampDown: '0s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],     // < 1 % Fehler
    http_req_duration: ['p(95)<1000'],  // p95 < 1 s
  },
};

export default function () {
  const res = http.get(`${BASE_URL}/`);
  check(res, { 'status 200': (r) => r.status === 200 });
}
