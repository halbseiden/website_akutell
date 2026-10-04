// Kriterium Zeile 29: API-Endpunkt, 1000 parallele Anfragen, 5 s Ramp-up,
// 5 MB Request Body. Requests werden ordnungsgemaess beantwortet.
//
// Strategie siehe 11. Im Unterschied zu 11 sind 429er hier NICHT zulaessig.
import http from 'k6/http';
import { check } from 'k6';
import { BASE_URL, JSON_HEADERS, mitgliedPayload5MB } from './_lib.js';

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
    http_req_failed: ['rate<0.05'],
    http_req_duration: ['p(95)<30000'],
  },
};

export default function () {
  const res = http.post(`${BASE_URL}/api/mitglieder`, mitgliedPayload5MB(), {
    ...JSON_HEADERS,
    timeout: '60s',
  });
  check(res, { 'status 201': (r) => r.status === 201 });
}
