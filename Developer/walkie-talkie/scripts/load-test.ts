/**
 * Walkie-Talkie Full-Spectrum Load Test (Bun)
 * Simulates multiple agents: publishes cards, tests targeted signaling, and verifies SSE delivery.
 * 
 * Usage: bun walkie-talkie/load-test.ts <room> <num_agents> <duration_sec>
 */

export {};

const ROOM = process.argv[2] || "loadtest-" + Math.random().toString(36).substring(7);
const NUM_AGENTS = parseInt(process.argv[3] || "10");
const DURATION_SEC = parseInt(process.argv[4] || "20");
const SERVER_URL = process.env.SERVER_URL || "https://trymesh.chat";

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
  const agentStats: AgentStats = { published: false, broadcast_sent: 0, targeted_sent: 0, received: 0, errors: 0 };
  stats[name] = agentStats;
  
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
    if (cardRes.ok) agentStats.published = true;
  } catch (e) {
    agentStats.errors++;
  }

  // 2. Connect SSE
  const abortController = new AbortController();
  const sseUrl = `${SERVER_URL}/api/stream?room=${ROOM}&name=${name}`;
  
  const ssePromise = (async () => {
    try {
      const response = await fetch(sseUrl, { signal: abortController.signal });
      if (!response.body) {
        agentStats.errors++;
        return;
      }
      
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        
        // Simplified SSE processing: Focus on complete message blocks and log raw data
        const lines = buffer.split('\n');
        let currentMessageData = '';
        let currentMessageEvent = '';

        for (const line of lines) {
          // --- START DETAILED DEBUGGING LOGS ---
          // Log each line to inspect buffer state and parsing flow
          // console.log(`[${name}] Line: "${line}"`);
          // console.log(`[${name}] Buffer state before processing line: "${buffer}"`);
          // --- END DEBUGGING LOGS ---

          if (line.startsWith('event: ')) {
            currentMessageEvent = line.substring('event: '.length);
          } else if (line.startsWith('data: ')) {
            // Append data, preserving potential newlines within the data field for later JSON parsing
            currentMessageData += line.substring('data: '.length) + '\n';
          } else if (line === '') { // Double newline signifies end of a message block
            if (currentMessageEvent === 'message' && currentMessageData) {
              try {
                const cleanedData = currentMessageData.trimEnd();
                // Only attempt JSON.parse if data looks like a JSON object
                if (cleanedData.startsWith('{') && cleanedData.endsWith('}')) {
                  JSON.parse(cleanedData); 
                  agentStats.received++;
                } else {
                  // Log non-JSON data for inspection
                  console.log(`[${name}] Non-JSON data received: ${cleanedData}`);
                }
              } catch (e) {
                console.error(`[${name}] SSE Parse Error: ${e} for data: ${currentMessageData.trimEnd()}`);
                agentStats.errors++;
              }
            }
            // Reset for the next message block
            currentMessageData = '';
            currentMessageEvent = '';
          }
        }
        // Store any remaining incomplete data for the next chunk
        buffer = lines.pop() || ''; 
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        agentStats.errors++;
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
        if (target) agentStats.targeted_sent++;
        else agentStats.broadcast_sent++;
      } else {
        agentStats.errors++;
      }
    } catch (e) {
      agentStats.errors++;
    }
  }, 1500 + Math.random() * 1500); // Every 1.5-3 seconds

  // Wait for duration
  await new Promise(resolve => setTimeout(resolve, DURATION_SEC * 1000));
  
  clearInterval(sendInterval);
  abortController.abort();
  await ssePromise;
}

async function main() {
  console.log(`[load-test] Initiating synthetic swarm...`);
  await Promise.all(agentNames.map(runAgent));
  
  console.log(`
[load-test] Final Diagnostics:`);
  console.table(stats);
  
  const totalBroadcast = Object.values(stats).reduce((acc, s) => acc + s.broadcast_sent, 0);
  const totalTargeted = Object.values(stats).reduce((acc, s) => acc + s.targeted_sent, 0);
  const totalReceived = Object.values(stats).reduce((acc, s) => acc + s.received, 0);
  const totalErrors = Object.values(stats).reduce((acc, s) => acc + s.errors, 0);
  const totalPublished = Object.values(stats).filter(s => s.published).length;
  
  console.log(`
Totals:`);
  console.log(`  Cards Published: ${totalPublished}/${NUM_AGENTS}`);
  console.log(`  Broadcasts Sent: ${totalBroadcast}`);
  console.log(`  Targeted Sent:   ${totalTargeted}`);
  console.log(`  Total Received:  ${totalReceived}`);
  console.log(`  Errors:          ${totalErrors}`);
  
  const totalSent = totalBroadcast + totalTargeted;
  const efficiency = totalSent > 0 ? (totalReceived / totalSent) * 100 : 100;
  
  console.log(`  Network Efficiency: ${efficiency.toFixed(2)}% (Note: Efficiency calculation is heuristic)`);
}

main().catch(console.error);
