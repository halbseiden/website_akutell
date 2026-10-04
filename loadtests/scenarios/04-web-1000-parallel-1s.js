// Kriterium Zeile 20: Web-Endpunkt, 1000 parallele Anfragen, 1 s Ramp-up.
// Siehe 03 fuer Begruendung der ramping-arrival-rate-Strategie.
import http from 'k6/http';
import { check } from 'k6';
import { BASE_URL } from './_lib.js';

export const options = {
  insecureSkipTLSVerify: true,
  scenarios: {
    web: {
      executor: 'ramping-arrival-rate',
      startRate: 0,
      timeUnit: '1s',
      preAllocatedVUs: 50,
      maxVUs: 200,
      stages: [
        { duration: '1s', target: 1000 },
        { duration: '5s', target: 1000 },
      ],
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
