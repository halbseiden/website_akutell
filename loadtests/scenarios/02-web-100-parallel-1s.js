// Kriterium Zeile 18: Web-Endpunkt, 100 parallele Anfragen, 1 s Ramp-up.
import http from 'k6/http';
import { check } from 'k6';
import { BASE_URL } from './_lib.js';

export const options = {
  insecureSkipTLSVerify: true,
  scenarios: {
    web: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '1s', target: 100 },
        { duration: '15s', target: 100 },
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
  const res = http.get(`${BASE_URL}/`);
  check(res, { 'status 200': (r) => r.status === 200 });
}
