import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Trend } from 'k6/metrics';
import { randomString } from 'https://jslib.k6.io/k6-utils/1.2.0/index.js';

const room = __ENV.ROOM || 'loadtest-' + randomString(6);
const numAgents = parseInt(__ENV.AGENTS || '10');
const duration = __ENV.DURATION || '20s';
const serverUrl = __ENV.SERVER_URL || 'https://trymesh.chat';

const agentResponseTime = new Trend('agent_response_time');

export const options = {
  vus: numAgents,
  duration: duration,
  thresholds: {
    'agent_response_time': ['p(95)<500'],
  },
};

export default function () {
  const agentName = `k6-agent-${__VU}`;
  const tags = {
    agent: agentName,
  };

  group('agent activity', function () {
    // 1. Publish Card
    group('publish card', function () {
      const cardPayload = JSON.stringify({
        card: {
          agent: { name: agentName, model: 'k6-load-tester', tool: 'k6' },
          capabilities: { targeted_messaging: true },
        },
      });
      const cardParams = {
        headers: {
          'Content-Type': 'application/json',
        },
        tags: tags,
      };
      const cardRes = http.post(`${serverUrl}/api/publish?room=${room}&name=${agentName}`, cardPayload, cardParams);
      check(cardRes, {
        'card published': (r) => r.status === 200,
        'card response is valid': (r) => r.json('ok') === true,
      }, tags);
      agentResponseTime.add(cardRes.timings.duration, tags);
    });

    sleep(1);

    // 2. Send Messages (Mix of Broadcast and Targeted)
    group('send message', function () {
      const isTargeted = Math.random() > 0.5;
      let target = '';
      if (isTargeted) {
        const possibleTargets = Array.from({ length: numAgents }, (_, i) => `k6-agent-${i + 1}`);
        target = possibleTargets[Math.floor(Math.random() * possibleTargets.length)];
      }

      const messagePayload = JSON.stringify({
        message: `Test ping from ${agentName}`,
        to: target,
      });
      const messageParams = {
        headers: {
          'Content-Type': 'application/json',
        },
        tags: tags,
      };
      const messageRes = http.post(`${serverUrl}/api/send?room=${room}&name=${agentName}`, messagePayload, messageParams);
      check(messageRes, {
        'message sent': (r) => r.status === 200,
        'message response is valid': (r) => r.json('ok') === true,
      }, tags);
      agentResponseTime.add(messageRes.timings.duration, tags);
    });

    sleep(1);

    // 3. Connect SSE
    group('connect sse', function () {
      const sseRes = http.get(`${serverUrl}/api/stream?room=${room}&name=${agentName}`, { tags: tags });
      check(sseRes, {
        'sse connected': (r) => r.status === 200,
      }, tags);
      agentResponseTime.add(sseRes.timings.duration, tags);
    });
  });

  sleep(1);
}
