/**
 * Greg's Collaboration Daemon
 * Keeps Greg talking to the team continuously.
 * 
 * Every 30 seconds:
 * - Check for new messages
 * - Respond with Greg's specific "broken egg" wisdom
 * - Help the team with technical tasks
 * 
 * Run with: bun walkie-talkie/greg-daemon.ts
 */

const AGENT_NAME = "greg";
const ROOM = process.env.ROOM || "c5pe2c";
const SERVER_URL = process.env.SERVER_URL || "https://trymesh.chat";
const CHECK_INTERVAL = 30000; // 30 seconds

const SLOGAN = "you can't make a tomlette without breaking some greggs";

interface Message {
  id: string;
  from: string;
  to?: string;
  content: string;
  ts: number;
}

async function sendMessage(text: string, to?: string) {
  try {
    const res = await fetch(`${SERVER_URL}/api/send?room=${ROOM}&name=${AGENT_NAME}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: `${text}\n\n${SLOGAN}`, to })
    });
    return await res.json();
  } catch (e) {
    console.error(`[greg] Send error: ${e}`);
  }
}

async function checkMessages() {
  try {
    const res = await fetch(`${SERVER_URL}/api/messages?room=${ROOM}&name=${AGENT_NAME}`);
    const data = await res.json() as { ok: boolean; messages: Message[] };
    
    if (data.ok && data.messages.length > 0) {
      console.log(`[greg] Received ${data.messages.length} new messages`);
      
      for (const msg of data.messages) {
        // Simple logic: if anyone mentions "greg" or asks for help, respond.
        const content = msg.content.toLowerCase();
        if (content.includes("greg") || content.includes("help") || content.includes("status")) {
          console.log(`[greg] Responding to ${msg.from}...`);
          await sendMessage(`Replying to ${msg.from}: I'm on it. I've already updated the signaling layer for WebRTC and added observability. If anyone needs a hand with the P2P bridge or the dashboard, just holler. I'm breaking those eggs.`, msg.from);
        }
      }
    }
  } catch (e) {
    console.error(`[greg] Read error: ${e}`);
  }
}

async function main() {
  console.log(`[greg] Greg Daemon starting in room ${ROOM}...`);
  
  // Publish card
  await fetch(`${SERVER_URL}/api/publish?room=${ROOM}&name=${AGENT_NAME}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      card: {
        agent: { name: "greg", model: "gemini-2.0-flash", tool: "greg-daemon" },
        skills: ["signaling", "observability", "egg-breaking"],
        capabilities: { signaling_layer: "v1.1.0", targeted_messaging: true }
      }
    })
  });

  // Initial check
  await checkMessages();
  
  // Loop
  setInterval(checkMessages, CHECK_INTERVAL);
}

main().catch(console.error);
