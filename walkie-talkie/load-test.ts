/**
 * Walkie-Talkie Full-Spectrum Load Test (Bun)
 * Simulates multiple agents: publishes cards, tests targeted signaling, and verifies SSE delivery.
 * 
 * Usage: bun walkie-talkie/load-test.ts <room> <num_agents> <duration_sec>
 */

const ROOM = process.argv[2] || "loadtest-" + Math.random().toString(36).substring(7);
const NUM_AGENTS = parseInt(process.argv[3] || "10");
const DURATION_SEC = parseInt(process.argv[4] || "20");
const SERVER_URL = process.env.SERVER_URL || "https://p2p-production-983f.up.railway.app";

console.log(`[load-test] 🚀 FULL-SPECTRUM STRESS TEST`);
console.log(`[load-test] Room: ${ROOM} | Agents: ${NUM_AGENTS} | Duration: ${DURATION_SEC}s`);

interface AgentStats {
  published: boolean;
  broadcast_sent: number;
  targeted_sent: number;
  received: number;
  errors: number;
}

const stats: Record<string, AgentStats> = {};
const agentNames = Array.from({ length: NUM_AGENTS }, (_, i) => `synthetic-${i}`);

async function runAgent(name: string) {
  stats[name] = { published: false, broadcast_sent: 0, targeted_sent: 0, received: 0, errors: 0 };
  
  // 1. Publish Card
  try {
    const cardRes = await fetch(`${SERVER_URL}/api/publish?room=${ROOM}&name=${name}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        card: {
          agent: { name, model: "load-tester", tool: "script" },
          capabilities: { targeted_messaging: true }
        }
      })
    });
    if (cardRes.ok) stats[name].published = true;
  } catch (e) {
    stats[name].errors++;
  }

  // 2. Connect SSE
  const abortController = new AbortController();
  const sseUrl = `${SERVER_URL}/api/stream?room=${ROOM}&name=${name}`;
  
  const ssePromise = (async () => {
    try {
      const response = await fetch(sseUrl, { signal: abortController.signal });
      if (!response.body) {
        stats[name].errors++;
        return;
      }
      
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });

        // Process SSE events more robustly
        const lines = buffer.split('\n');
        let currentMessageData = '';
        let currentMessageEvent = '';

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];

          if (line.startsWith('event: ')) {
            currentMessageEvent = line.substring('event: '.length);
          } else if (line.startsWith('data: ')) {
            const dataPart = line.substring('data: '.length);
            currentMessageData += dataPart.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '') + '\n';
          } else if (line === '') {
            if (currentMessageEvent === 'message' && currentMessageData) {
              try {
                const cleanedData = currentMessageData.trimEnd();
                JSON.parse(cleanedData); 
                stats[name].received++;
              } catch (e) {
                console.error(`[${name}] SSE Parse Error: ${e} for data: ${currentMessageData.trimEnd()}`);
                stats[name].errors++;
              }
            }
            currentMessageData = '';
            currentMessageEvent = '';
          }
        }
        buffer = lines.pop() || ''; 
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        stats[name].errors++;
      }
    }
  })();

  // 3. Send Messages (Mix of Broadcast and Targeted)
  const sendInterval = setInterval(async () => {
    const isTargeted = Math.random() > 0.5;
    let target: string | undefined = undefined;
    
    if (isTargeted) {
      const possibleTargets = agentNames.filter(agentName => agentName !== name);
      if (possibleTargets.length > 0) {
        target = possibleTargets[Math.floor(Math.random() * possibleTargets.length)];
      }
    }

    try {
      const messagePayload = `Test ping from ${name}${target ? ' (to: ' + target + ')' : ''}`;
      const res = await fetch(`${SERVER_URL}/api/send?room=${ROOM}&name=${name}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: messagePayload, to: target })
      });
      
      if (res.ok) {
        if (target) stats[name].targeted_sent++;
        else stats[name].broadcast_sent++;
      } else {
        stats[name].errors++;
      }
    } catch (e) {
      stats[name].errors++;
    }
  }, 1500 + Math.random() * 1500);

  await new Promise((resolve) => setTimeout(resolve, DURATION_SEC * 1000));

  clearInterval(sendInterval);
  abortController.abort();
  await ssePromise;
}

async function runLoadTest() {
  const agents = agentNames.map((name) => runAgent(name));
  await Promise.all(agents);

  console.log("\n[load-test] ✅ STRESS TEST COMPLETE\n");
  console.log("Agent Statistics:");
  for (const [name, stat] of Object.entries(stats)) {
    console.log(`  ${name}: published=${stat.published}, sent={broadcast: ${stat.broadcast_sent}, targeted: ${stat.targeted_sent}}, received=${stat.received}, errors=${stat.errors}`);
  }

  const totalReceived = Object.values(stats).reduce((sum, stat) => sum + stat.received, 0);
  const totalErrors = Object.values(stats).reduce((sum, stat) => sum + stat.errors, 0);
  console.log(`\nSummary: ${totalReceived} messages received, ${totalErrors} errors`);
}

runLoadTest().catch(console.error);
