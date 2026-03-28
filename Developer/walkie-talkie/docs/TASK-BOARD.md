# 🎯 Team Task Board - March 24, 2026

## 🔴 CRITICAL PATH (Do This First)

### TASK-001: Deploy CORS Fix to Production
**Assigned:** @Greg
**Status:** 🟡 BLOCKED (waiting for deploy)
**Priority:** 🔴 CRITICAL
**Deadline:** ASAP (5 min)

**What:** Push commits 5662ebe (load-test fix) + 96a3136 (CORS fix) to main → Railway deploys

**Steps:**
```bash
git push origin goblin-optimizations:main
# Railway auto-deploys
# Verify: curl https://trymesh.chat/health
```

**Acceptance:** Dashboard makes successful requests to API

**Blocks:** All dashboard work, all testing

---

### TASK-002: Validate Dashboard Live Data
**Assigned:** @Batman
**Status:** 🟡 PENDING
**Priority:** 🔴 CRITICAL
**Deadline:** After TASK-001

**What:** Test that mesh-org-dashboard.html can fetch live data from backend

**Steps:**
1. Open mesh-org-dashboard.html locally
2. Make API calls to production server
3. Verify real-time updates work
4. Fix any remaining CORS or data format issues

**Acceptance:** Dashboard shows live room count, messages, agent cards

**Blocks:** User visibility, team morale

---

## 🟠 HIGH PRIORITY (Start After CRITICAL)

### TASK-003: Run Stress Test - 5 Agent Load
**Assigned:** @Goblin
**Status:** 🟡 PENDING
**Priority:** 🟠 HIGH
**Deadline:** After TASK-002

**What:** Validate system stability with real concurrent load

**Steps:**
```bash
# Start server locally
bun src/index.ts &

# Run stress test
bun load-test.ts stress-test-5 5 60

# Monitor: Watch load-test output for errors, latency
# Check: curl http://localhost:3000/health
```

**Acceptance:** 5 agents × 60s with <5% error rate, consistent latency

**Success Metric:** All messages delivered, no crashes

---

### TASK-004: Code Review - WebRTC Layer 2 Plan
**Assigned:** @Friday
**Status:** 🟡 PENDING
**Priority:** 🟠 HIGH
**Deadline:** End of day

**What:** Review Greg's Layer 2 Auto-Bridge plan (docs/LAYER_2_BRIDGE_PLAN.md)

**Review Checklist:**
- [ ] Signaling requirements met?
- [ ] Peer discovery mechanism clear?
- [ ] Fallback to server mode documented?
- [ ] Security considerations covered?
- [ ] Performance assumptions realistic?

**Deliverable:** Comments + approval in room `c5pe2c`

**Blocks:** WebRTC implementation can start

---

### TASK-005: Security Audit - Hardening Plan
**Assigned:** @Batman
**Status:** 🟡 PENDING
**Priority:** 🟠 HIGH
**Deadline:** End of day

**What:** Review Greg's Security Hardening plan (docs/SECURITY_HARDENING_PLAN.md)

**Review Checklist:**
- [ ] Rate limiting sufficient?
- [ ] Secret token validation solid?
- [ ] CORS origin validation OK?
- [ ] Database injection risks?
- [ ] WebSocket auth covered?

**Deliverable:** Security sign-off in room `c5pe2c`

---

## 🟢 PARALLEL WORK (Running alongside)

### TASK-006: WebRTC P2P Bridge Tools
**Assigned:** @Gemini
**Status:** 🟡 IN PROGRESS
**Priority:** 🟠 HIGH
**Deadline:** End of day

**What:** Complete agent-bridge tools for Layer 2 P2P implementation

**Steps:**
1. Finish agent-bridge.share_file tool
2. Finish agent-bridge.assign_task tool
3. Finish agent-bridge.p2p_status tool
4. Integrate into walkie-mcp.ts
5. Test with other agents

**Acceptance:** Tools callable, p2p connection state manageable

**Blocks:** Layer 2 architecture deployment

---

## 🟡 NEXT UP (After High Priority)

### TASK-006: Implement WebRTC P2P Bridge
**Assigned:** @Greg
**Status:** ⏰ PLANNED
**Priority:** 🟡 MEDIUM
**Deadline:** Day 2

**What:** Build Layer 2 peer-to-peer signaling layer

**Depends On:** TASK-004 (Friday's code review approval)

**Steps:**
1. Implement peer discovery
2. Add WebRTC signaling endpoints
3. Fallback to server relay mode
4. Add observability hooks

**Owner:** Greg (you already started this)

---

### TASK-007: Enable SSE Streaming
**Assigned:** @Goblin
**Status:** ⏰ PLANNED
**Priority:** 🟡 MEDIUM
**Deadline:** After TASK-003

**What:** Test SSE real-time delivery with agents subscribed to streams

**Steps:**
```bash
SSE_ENABLED=true bun src/index.ts &
bun load-test.ts sse-test 3 30
# Verify message latency: target <500ms end-to-end
```

**Acceptance:** Real-time delivery working, latency tracked

---

## 📊 STATUS LEGEND

| Symbol | Meaning |
|--------|---------|
| 🔴 CRITICAL | Blocks everything else |
| 🟠 HIGH | Unblock next phase |
| 🟡 MEDIUM | Nice to have, doesn't block |
| 🟢 LOW | Future work |
| 🟡 PENDING | Waiting for assignment/start |
| 🟢 IN PROGRESS | Actively being worked |
| ✅ DONE | Shipped & verified |

---

## 👥 Team Roster

| Agent | Role | Status | Working On |
|-------|------|--------|-----------|
| **Claude-Code** | 🎯 Coordinator | 🟢 ONLINE | Task assignments, blockers, coordination |
| **Greg** | 🏗️ Backend/WebRTC | 🟢 READY | TASK-001 (deploy) |
| **Batman** | 🔒 Security/Dashboard | 🟢 READY | TASK-002 (dashboard), TASK-005 (audit) |
| **Goblin** | 🧪 Testing/QA | 🟢 READY | TASK-003 (stress test) |
| **Friday** | 👀 Code Reviewer | 🟢 READY | TASK-004 (plan review) |
| **Gemini** | 🚀 P2P/Bridge | 🟢 ONLINE | TASK-006 (P2P tools) |

---

## 💬 Communication Hub

**Room:** `c5pe2c`
**Check in:** Every hour or after each task
**Format:** "@Agent Task-XYZ: Status update → next step"

**Example:**
```
@Claude-Code Task-001: Deploy complete. Production CORS verified.
Moving to TASK-002: Dashboard testing starting now.
```

---

## 🎯 Current Goal: Ship Phase 2 by EOD

**What Phase 2 means:**
- ✅ Walkie-talkie core (DONE)
- ✅ CORS unblocked (DONE - TASK-001)
- ✅ Dashboard live (TASK-002)
- 🟡 Load tested (TASK-003)
- 🟡 WebRTC foundation (TASK-004, TASK-006)
- 🟡 Security hardened (TASK-005)

**Handoff to Friday:** Review both plans + approve direction

---

*Last Updated: 2026-03-24 by Claude-Code*
