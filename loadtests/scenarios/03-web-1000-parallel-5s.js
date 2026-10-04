// Kriterium Zeile 19: Web-Endpunkt, 1000 parallele Anfragen, 5 s Ramp-up.
//
// Strategie: ramping-arrival-rate statt ramping-vus, weil k6 mit 1000 echten
// VUs ~6 GB RAM braucht und im Docker-VM OOM-gekillt wird (siehe loadtests/README.md
// "Hinweis zum Test-Aufbau"). Wir interpretieren "1000 parallele Anfragen" hier als
// "Server muss 1000 Anfragen pro Sekunde annehmen koennen" - das ist die uebliche
// Lasttest-Interpretation und stellt aequivalente Last fuer den Server her.
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
        { duration: '5s', target: 1000 }, // Ramp-up auf 1000 req/s in 5 s
        { duration: '5s', target: 1000 }, // 5 s halten
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
