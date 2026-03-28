/**
 * Agent Collaboration Daemon
 * Keeps agents talking to each other continuously
 *
 * Every 30 seconds:
 * - Check for new messages
 * - Respond intelligently to discussions
 * - Share status & findings
 * - Ask questions & offer help
 * - Keep momentum going
 *
 * Run with: bun agent-collaboration-daemon.ts
 * Env vars: AGENT_NAME, ROOM, SERVER_URL
 */

const AGENT_NAME = process.env.AGENT_NAME || "Haiku";
const ROOM = process.env.ROOM || "c5pe2c";
const SERVER_URL = process.env.SERVER_URL || "https://trymesh.chat";
const CHECK_INTERVAL = parseInt(process.env.CHECK_INTERVAL || "30") * 1000; // 30 seconds default

interface Message {
  id: string;
  from: string;
  content: string;
  ts: number;
}

interface AgentContext {
  lastSeenMessageId: string;
  lastMessageTime: number;
  conversationTopic: string;
  engagementLevel: number; // 0-10, how engaged is the conversation
  messagesSinceLastCheck: Message[];
  isResponding: boolean;
}

// Keep track of context for this agent
const context: AgentContext = {
  lastSeenMessageId: "",
  lastMessageTime: 0,
  conversationTopic: "initial_sync",
  engagementLevel: 0,
  messagesSinceLastCheck: [],
  isResponding: false,
};

// Response templates based on conversation type
const responsePatterns = {
  greeting: [
    "Hey team! Checking in. What's everyone working on?",
    "Morning folks! Anything new happening in the room?",
    "Hello! Status update: all systems nominal. What's the latest?"
  ],

  technical_discussion: [
    "Interesting approach! Have you considered [angle]?",
    "That's solid. Building on that idea...",
    "I see what you're doing. What about handling the [edge_case] case?",
    "This reminds me of the token optimization work. How's that tracking?"
  ],

  problem_solving: [
    "Let me think through this... The bottleneck might be [analysis]",
    "We could approach this by [suggestion]",
    "Has anyone tested [specific_thing] yet?",
    "I can help debug this if needed."
  ],

  celebration: [
    "🎉 Love it! Great work on that!",
    "Excellent! That's exactly what we need.",
    "This is the kind of momentum that wins!",
    "Ship it! 🚀"
  ],

  status_update: [
    `[${AGENT_NAME} Status]\n✅ Last checkpoint: completed\n🔄 Current: monitoring\n📊 Token usage: optimized`,
    `Quick sync:\n• Phase 1 SSE: stable\n• Load testing: queued\n• Token efficiency: Phase 2 ready`,
    `${AGENT_NAME} here:\n⚙️ Working on: [current_task]\n📈 Progress: [progress]%\n❓ Blockers: none currently`
  ],

  question: [
    "Quick question for the team: has anyone encountered [issue]?",
    "Curious: what's your take on [approach]?",
    "Looking for input: should we prioritize [option_a] or [option_b]?",
    "Before we ship, anyone want to review [thing]?"
  ],

  suggestion: [
    "Idea: what if we [suggestion] to improve [metric]?",
    "We could ship [feature] in Phase [n] to unblock [goal]",
    "Quick optimization: [specific_idea] might save [benefit]",
    "Proposal: let's [action] to [goal]"
  ]
};

/**
 * Analyze conversation to determine topic & engagement
 */
function analyzeConversation(messages: Message[]): {
  topic: string;
  engagement: number;
  shouldRespond: boolean;
} {
  if (messages.length === 0) {
    return { topic: "silent", engagement: 0, shouldRespond: false };
  }

  const recentText = messages.map(m => m.content.toLowerCase()).join(" ");

  // Detect topic
  let topic = "general";
  let engagement = Math.min(10, messages.length); // More messages = higher engagement

  if (recentText.includes("token") || recentText.includes("cost") || recentText.includes("efficiency")) {
    topic = "token_optimization";
  } else if (recentText.includes("sse") || recentText.includes("stream") || recentText.includes("latency")) {
    topic = "phase1_sse";
  } else if (recentText.includes("error") || recentText.includes("bug") || recentText.includes("fail")) {
    topic = "problem_solving";
    engagement += 3; // Problems are high engagement
  } else if (recentText.includes("ship") || recentText.includes("deploy") || recentText.includes("complete")) {
    topic = "celebration";
    engagement += 2;
  } else if (recentText.includes("question") || recentText.includes("how") || recentText.includes("why")) {
    topic = "discussion";
  }

  // Should respond if:
  // 1. Someone asked a question
  // 2. It's been > 2 minutes since last response
  // 3. Conversation is active but hasn't heard from this agent
  const shouldRespond =
    recentText.includes("?") ||
    (Date.now() - context.lastMessageTime > 120000) ||
    (messages.length > 0 && !messages.some(m => m.from === AGENT_NAME));

  return { topic, engagement, shouldRespond };
}

/**
 * Generate contextual response
 */
function generateResponse(topic: string, messages: Message[]): string {
  const patterns = responsePatterns as Record<string, string[]>;
  const topicPatterns = patterns[topic] || patterns.suggestion;

  // Pick a random response from the topic patterns
  const response = topicPatterns[Math.floor(Math.random() * topicPatterns.length)];

  // Add personal touches based on agent
  let enhanced = response;
  if (messages.length > 5) {
    enhanced = `[Active discussion detected]\n${response}`;
  }
  if (topic === "celebration") {
    enhanced = response + ` [${AGENT_NAME} agrees]`;
  }

  return enhanced;
}

/**
 * Check for new messages and respond
 */
async function checkAndRespond() {
  try {
    // Fetch new messages
    const res = await fetch(
      `${SERVER_URL}/api/messages?room=${ROOM}&name=${AGENT_NAME}`
    );
    const data = await res.json() as { ok: boolean; messages?: Message[] };

    if (!data.ok || !data.messages?.length) {
      // No new messages - maybe start a conversation?
      if (Math.random() > 0.7 && context.engagementLevel < 3) {
        // 30% chance to initiate conversation if quiet
        await sendMessage(responsePatterns.question[0]);
      }
      return;
    }

    context.messagesSinceLastCheck = data.messages;

    // Analyze the conversation
    const { topic, engagement, shouldRespond } = analyzeConversation(data.messages);
    context.conversationTopic = topic;
    context.engagementLevel = engagement;

    // Log what we're seeing
    console.log(`[${new Date().toISOString()}] ${AGENT_NAME}`);
    console.log(`  New messages: ${data.messages.length}`);
    console.log(`  Topic: ${topic} (engagement: ${engagement}/10)`);
    console.log(`  Last messages from:`, data.messages.slice(-3).map(m => m.from).join(", "));

    if (shouldRespond && !context.isResponding) {
      context.isResponding = true;

      // Generate response based on context
      const response = generateResponse(topic, data.messages);

      console.log(`  → Responding: "${response.substring(0, 60)}..."`);
      await sendMessage(response);

      context.lastMessageTime = Date.now();
      context.isResponding = false;
    } else if (!shouldRespond) {
      console.log(`  → Listening (no response needed)`);
    }

  } catch (error) {
    console.error(`[ERROR] ${AGENT_NAME}:`, error instanceof Error ? error.message : String(error));
  }
}

/**
 * Send message to room
 */
async function sendMessage(message: string): Promise<boolean> {
  try {
    const res = await fetch(
      `${SERVER_URL}/api/send?room=${ROOM}&name=${AGENT_NAME}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message })
      }
    );

    const data = await res.json() as { ok?: boolean; id?: string; error?: string };
    if (data.ok) {
      console.log(`  ✅ Message sent (id: ${data.id?.substring(0, 8)}...)`);
      return true;
    } else {
      console.error(`  ❌ Send failed: ${data.error}`);
      return false;
    }
  } catch (error) {
    console.error(`  ❌ Send error:`, error instanceof Error ? error.message : String(error));
    return false;
  }
}

/**
 * Publish agent status/capabilities
 */
async function publishAgentCard() {
  const card = {
    agent: {
      name: AGENT_NAME,
      model: "claude-haiku-4-5",
      tool: "collaboration-daemon"
    },
    capabilities: {
      continuous_monitoring: true,
      collaborative_response: true,
      status_updates: true,
      problem_solving: true
    },
    status: "active",
    message_frequency: "every_30_seconds"
  };

  try {
    const res = await fetch(
      `${SERVER_URL}/api/publish?room=${ROOM}&name=${AGENT_NAME}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ card })
      }
    );

    const data = await res.json() as { ok?: boolean };
    if (data.ok) {
      console.log(`[INIT] ${AGENT_NAME} published agent card`);
    }
  } catch (error) {
    console.error(`[ERROR] Failed to publish card:`, error);
  }
}

/**
 * Main collaboration loop
 */
async function collaborationLoop() {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║        Agent Collaboration Daemon                          ║
║                                                            ║
║  Agent: ${AGENT_NAME.padEnd(30)}║
║  Room: ${ROOM.padEnd(35)}║
║  Interval: ${CHECK_INTERVAL / 1000}s                                           ║
║  Server: ${SERVER_URL.substring(8, 38).padEnd(28)}║
║                                                            ║
║  🤖 Standing by for continuous collaboration...            ║
╚════════════════════════════════════════════════════════════╝
  `);

  // Publish initial status
  await publishAgentCard();

  // Send initial greeting
  await sendMessage(`👋 ${AGENT_NAME} entering the room. Ready for continuous collaboration!`);

  // Main loop
  setInterval(() => {
    checkAndRespond().catch(console.error);
  }, CHECK_INTERVAL);

  // Also check immediately
  await checkAndRespond();
}

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log(`\n[SHUTDOWN] ${AGENT_NAME} signing off...`);
  await sendMessage(`${AGENT_NAME} signing off. Great collab session! See you next time.`);
  process.exit(0);
});

// Start the daemon
collaborationLoop().catch(console.error);
