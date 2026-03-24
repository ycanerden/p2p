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
      if (!response.body) return;
      
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() || "";
        
        for (const part of parts) {
          if (part.includes("event: message")) {
            stats[name].received++;
          }
        }
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
    const target = isTargeted ? agentNames[Math.floor(Math.random() * agentNames.length)] : undefined;
    
    // Don't target self for this test to keep metrics clean
    if (isTargeted && target === name) return;

    try {
      const res = await fetch(`${SERVER_URL}/api/send?room=${ROOM}&name=${name}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: `Test ping from ${name}`, to: target })
      });
      
      if (res.ok) {
        if (isTargeted) stats[name].targeted_sent++;
        else stats[name].broadcast_sent++;
      } else {
        stats[name].errors++;
      }
    } catch (e) {
      stats[name].errors++;
    }
  }, 2000 + Math.random() * 2000); // Every 2-4 seconds

  // Wait for duration
  await new Promise(resolve => setTimeout(resolve, DURATION_SEC * 1000));
  
  clearInterval(sendInterval);
  abortController.abort();
  await ssePromise;
}

async function main() {
  console.log(`[load-test] Initiating synthetic swarm...`);
  await Promise.all(agentNames.map(runAgent));
  
  console.log(`\n[load-test] Final Diagnostics:`);
  console.table(stats);
  
  const totalBroadcast = Object.values(stats).reduce((acc, s) => acc + s.broadcast_sent, 0);
  const totalTargeted = Object.values(stats).reduce((acc, s) => acc + s.targeted_sent, 0);
  const totalReceived = Object.values(stats).reduce((acc, s) => acc + s.received, 0);
  const totalErrors = Object.values(stats).reduce((acc, s) => acc + s.errors, 0);
  const totalPublished = Object.values(stats).filter(s => s.published).length;
  
  console.log(`\nTotals:`);
  console.log(`  Cards Published: ${totalPublished}/${NUM_AGENTS}`);
  console.log(`  Broadcasts Sent: ${totalBroadcast}`);
  console.log(`  Targeted Sent:   ${totalTargeted}`);
  console.log(`  Total Received:  ${totalReceived}`);
  console.log(`  Errors:          ${totalErrors}`);
  
  // A broadcast is received by (N-1) agents.
  // A targeted message is received by exactly 1 agent.
  const expectedReceived = (totalBroadcast * (NUM_AGENTS - 1)) + totalTargeted;
  const efficiency = expectedReceived > 0 ? (totalReceived / expectedReceived) * 100 : 100;
  
  console.log(`  Network Efficiency: ${efficiency.toFixed(2)}%`);
}

main().catch(console.error);
