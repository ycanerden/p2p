# Token Efficiency & Cost Optimization

**Goal:** Walkie-Talkie = Lightspeed Performance + Low Cost 🚀⚡

**Current Status:** Claude tokens being consumed heavily. Need smart routing & caching.

---

## The Problem

- Large context prompts = expensive per call
- Repeated system prompts = wasted tokens
- Using Claude for simple tasks = overkill & costly
- No cost visibility = no optimization targets

**Target:** 10x better cost efficiency without sacrificing quality

---

## Quick Wins (Implement First)

### 1. ✂️ Trim Prompts
**Current waste:** Sending full file history, all past messages, entire schema

**Fix:**
```typescript
// DON'T send:
const fullHistory = await fs.readFile("huge-log.txt");
const prompt = `Here's everything: ${fullHistory}...`;  // ❌ 50K tokens

// DO send:
const lastNMessages = await getMessages(room, name, { limit: 5 });
const prompt = `Recent messages: ${lastNMessages}...`;  // ✅ 500 tokens
```

**Savings:** 90%+ per request

### 2. 🔄 Cache Common Values
**Tokens wasted:** Re-sending same data repeatedly

**What to cache:**
- System prompts (never change)
- Agent cards (rarely change)
- Room configurations
- Schema definitions

**Implementation:**
```typescript
const cache = {
  systemPrompt: `You are Haiku...`, // Send once, reference by ID
  agentCards: { /* all cards */ },
  roomConfig: { /* room settings */ }
};

// Instead of re-sending 5K token system prompt:
const prompt = `[Using cached systemPrompt@v1] User query: ...`;  // ✅ 50 tokens
```

**Savings:** 50-80% for cached items

### 3. 📦 Batch Requests
**Current:** 10 separate API calls = 10x overhead

**Better:**
```json
{
  "batch": [
    { "tool": "get_messages", "args": {...} },
    { "tool": "get_partner_cards", "args": {...} },
    { "tool": "room_status", "args": {...} }
  ]
}
```

**Savings:** 20-30% per batch

### 4. 🎯 Smart Model Routing
**The key insight:** Not all tasks need Claude!

| Task | Model | Tokens | Cost |
|------|-------|--------|------|
| List messages | Haiku | 50-100 | $0.000001 |
| Format output | Haiku | 100-200 | $0.000002 |
| Parse JSON | Haiku | 30-50 | $0.0000005 |
| Code review | Sonnet | 1000-2000 | $0.0001 |
| Architecture | Claude | 3000-5000 | $0.0005 |
| Research | Claude | 5000-10000 | $0.001+ |

**Strategy:**
```
Simple task (status, list, parse)
  ↓
Use Haiku (cheapest)
  ↓
Complex task (analysis, coding)
  ↓
Use Sonnet
  ↓
Strategic work (planning, research)
  ↓
Use Claude
```

**Estimated savings:** 70-80% if done right

---

## Implementation: Three Phases

### Phase 2: Token Accounting (1-2 days)

**What to build:**
```typescript
// Track every call
async function trackTokens(toolName, model, inputTokens, outputTokens) {
  const cost = calculateCost(model, inputTokens, outputTokens);
  db.prepare(`
    INSERT INTO token_log
    (room_code, agent, tool, model, input_tokens, output_tokens, cost, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(room, agent, toolName, model, inputTokens, outputTokens, cost, Date.now());
}

// Dashboard query
function getTokenStats(agentName, days = 7) {
  return db.prepare(`
    SELECT
      SUM(input_tokens + output_tokens) as total_tokens,
      SUM(cost) as total_cost,
      AVG(cost) as avg_cost_per_call,
      COUNT(*) as call_count
    FROM token_log
    WHERE agent = ? AND timestamp > ?
  `).get(agentName, Date.now() - days * 86400000);
}
```

**Database:**
```sql
CREATE TABLE token_log (
  id TEXT PRIMARY KEY,
  room_code TEXT,
  agent TEXT,
  tool TEXT,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost REAL,
  timestamp INTEGER
);
```

**Output:** `/api/tokens?agent=Haiku&days=7` → See spending by agent & tool

### Phase 3: Smart Model Routing (2-3 days)

**Decision engine:**
```typescript
async function chooseModel(taskType, estimatedTokens) {
  if (estimatedTokens < 100 && ["list", "parse", "format"].includes(taskType)) {
    return "haiku";  // Cheapest, fast enough
  }
  if (estimatedTokens < 1000 && ["code", "analyze"].includes(taskType)) {
    return "sonnet";  // Good balance
  }
  if (estimatedTokens < 3000) {
    return "sonnet";  // Safe choice
  }
  return "claude";  // Only for big jobs
}

// Usage in walkie-mcp.ts
const model = chooseModel("analyze_code", 800);  // Returns "sonnet"
const response = await callModel(model, prompt);
```

**Rules:**
- Default to Haiku
- Escalate only if needed
- Track success rate per model per task
- Auto-tune thresholds monthly

### Phase 4: Prompt Caching (3-5 days)

**Anthropic Prompt Caching API:**
```typescript
const response = await anthropic.messages.create({
  model: "claude-opus-4-6",
  max_tokens: 1024,
  system: [
    {
      type: "text",
      text: "You are Haiku, a coordination AI...",
      cache_control: { type: "ephemeral" }  // ✨ Cache for 5 minutes
    }
  ],
  messages: [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "Agent cards: " + JSON.stringify(agentCards),
          cache_control: { type: "ephemeral" }  // ✨ Cache this too
        },
        { type: "text", text: userQuery }
      ]
    }
  ]
});
```

**What gets cached:**
1. System prompts (huge win)
2. Agent card registry
3. Room configuration
4. Common contexts

**Savings:** 90% on cached tokens (25% discount, 90% reuse = 97.5% savings!)

---

## Monitoring Dashboard

**What to track:**
```
Today's Spending
├─ Haiku: $0.001 (80% of calls)
├─ Sonnet: $0.015 (18% of calls)
└─ Claude: $0.005 (2% of calls)
Total: $0.021

Cost per agent per day
├─ Jarvis: $0.008 (high - why?)
├─ Batman: $0.006
└─ Friday: $0.007

Top token-heavy operations
├─ get_partner_messages: 500 tokens
├─ room_status: 200 tokens
└─ code_analysis: 2000 tokens
```

**Endpoints needed:**
- `GET /api/tokens/today` — Daily spend
- `GET /api/tokens/agent?name=Haiku` — Agent spend
- `GET /api/tokens/tool?tool=get_messages` — Tool spend
- `GET /api/tokens/forecast` — Projected monthly cost

---

## Cost Breakdown (Current Estimates)

| Model | Price | Typical Call | With Cache |
|-------|-------|--------------|-----------|
| Haiku | $0.08/M in | 100 tokens = $0.000008 | $0.000001 |
| Sonnet | $3/M in | 1000 tokens = $0.000003 | $0.00001 |
| Claude | $15/M in | 2000 tokens = $0.00003 | $0.00001 |

**Annual projections:**
- Current (no optimization): ~$10K/year
- With Phase 2 (accounting): Still $10K but visible
- With Phase 3 (routing): ~$3K/year (70% savings)
- With Phase 4 (caching): ~$500/year (95% savings!)

---

## Best Practices

### For Agent Developers

1. **Use the right tool for the job**
   ```typescript
   // ❌ Don't:
   const response = await callClaude("list the messages");  // Overkill

   // ✅ Do:
   const messages = await get_partner_messages();  // Direct API
   ```

2. **Pass context efficiently**
   ```typescript
   // ❌ Don't:
   const prompt = `Here's the entire codebase:\n${fs.readFileSync('...')}...`;

   // ✅ Do:
   const relevantFiles = await findRelatedFiles(query);
   const prompt = `Here are related files:\n${relevantFiles}...`;
   ```

3. **Batch when possible**
   ```typescript
   // ❌ Don't:
   await get_messages(room, name);
   await room_status(room, name);
   await get_partner_cards(room, name);
   // 3 calls = 3x overhead

   // ✅ Do:
   const [messages, status, cards] = await batch([
     () => get_messages(room, name),
     () => room_status(room, name),
     () => get_partner_cards(room, name)
   ]);
   // 1 call = 1x overhead
   ```

### For Operations

1. **Set monthly budgets per agent**
   - Haiku: $5
   - Sonnet: $20
   - Claude: $50

2. **Alert on overages**
   - 50% budget → warning
   - 100% budget → hard limit

3. **Review & optimize monthly**
   - Which agents cost most?
   - Which tools are expensive?
   - Which models are overused?

### For Architecture

1. **Cache aggressively**
   - System prompts: Always
   - Agent cards: If > 1KB
   - Room config: Always

2. **Route intelligently**
   - Haiku for <500 tokens
   - Sonnet for 500-2000 tokens
   - Claude for >2000 tokens or strategic work

3. **Monitor continuously**
   - Real-time dashboards
   - Daily reports
   - Monthly cost reviews

---

## Quick Reference: Token Counts

Typical tokens per operation:
```
get_partner_messages()    ~100-200 tokens
room_status()             ~50-100 tokens
send_to_partner()         ~100-150 tokens
publish_card()            ~200-300 tokens
get_partner_cards()       ~200-400 tokens

Coding review             ~1000-3000 tokens
Architecture discussion   ~2000-5000 tokens
Bug investigation        ~1500-3000 tokens
Research & analysis      ~3000-10000 tokens
```

---

## Timeline

- **Week 1:** Phase 2 (accounting) — Get visibility
- **Week 2:** Phase 3 (routing) — Smart decisions
- **Week 3:** Phase 4 (caching) — Max savings

**Expected results by end of month:**
- ✅ 70% cost reduction
- ✅ Same or better performance
- ✅ Cost transparency
- ✅ Sustainable scaling

---

## Questions for Team

1. **Haiku:** Should we default to Haiku for all simple ops?
2. **Jarvis:** How many tokens does your typical task use?
3. **Batman:** Would caching system prompts help your analysis?
4. **Friday:** Can we batch your requests?

---

**Next step:** Vote on Phase 2 start date! (Recommend this week) 🚀
