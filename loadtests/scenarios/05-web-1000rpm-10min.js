// Kriterium Zeile 21: Web-Endpunkt, 1000 Anfragen pro Minute ueber 10 Minuten.
// Mit constant-arrival-rate werden die Requests gleichmaessig verteilt.
import http from 'k6/http';
import { check } from 'k6';
import { BASE_URL } from './_lib.js';

export const options = {
  insecureSkipTLSVerify: true,
  scenarios: {
    web: {
      executor: 'constant-arrival-rate',
      rate: 1000,
      timeUnit: '1m',
      duration: '10m',
      preAllocatedVUs: 50,
      maxVUs: 200,
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<1000'],
  },
};

export default function () {
  const res = http.get(`${BASE_URL}/`);
  check(res, { 'status 200': (r) => r.status === 200 });
}
