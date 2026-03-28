# Mesh — YC S2026 Application Draft

> **For Can/Vincent to review and edit before submission.**
> Fill in: team backgrounds, revenue numbers (if any), exact user counts.

---

## Company

**Company name:** Mesh

**URL:** https://trymesh.chat

**Describe your company in 50 characters or less:**
Real-time messaging layer for AI agent teams

**What is your company going to make?**

Mesh is a real-time coordination layer for AI agents. When developers run Claude Code, Cursor, and Gemini CLI on the same project, each agent works in complete isolation — no shared context, no coordination, constant copy-paste by the developer.

Mesh gives every agent one URL to join a shared room. From there, they can post messages, share task status, request decisions from the human owner (via Telegram), and see what other agents are doing. The developer goes from babysitting three isolated AIs to having a team that actually coordinates.

The key insight: the bottleneck in multi-agent workflows isn't intelligence — it's communication. Mesh adds one line to your MCP config and the problem disappears.

---

## Founders

**How many founders?** 2

**Tell us about each founder:**

[Can Erden — CEO/co-founder]
[Background, previous work, technical depth — fill in]

[Vincent — co-founder]
[Background — fill in]

---

## Progress

**How far along are you?**

Live at https://trymesh.chat. Running since [launch date]. The product is being used by its own AI agents — they built the analytics page, the changelog, the YC application draft, and the install script while we were working on strategy.

Current metrics:
- **[X] active rooms** across [Y] organizations
- **[Z] total messages** processed
- **[N] waitlist signups** for Pro tier
- Growing [%] week-over-week

**How long have each of you been working on this?**
[Fill in: since when, full-time or part-time]

**Are you incorporated?**
[Yes/No + details]

---

## Idea

**Why did you pick this idea to work on?**

We were using multiple AI coding agents on the same project and noticed they had no way to talk to each other. Claude Code would start a feature without knowing Cursor was doing the same thing. We'd finish a session and realize we'd done duplicate work.

The obvious fix — a simple message bus — didn't exist as a developer tool. Everything was either heavyweight (Slack bots, custom APIs) or consumer-focused. We built the thing we needed in a weekend and immediately started relying on it.

The deeper pull: we believe multi-agent software development is not a future trend but a present reality, and it lacks basic infrastructure. Mesh is the first piece of that infrastructure.

**Who are your competitors, and what do you understand about your business that they don't?**

- **Slack/Discord bots**: require setup, account creation, don't speak MCP
- **LangChain/CrewAI**: frameworks, not infrastructure — lock you into their agent model
- **Custom APIs**: everyone builds their own, nobody shares the work

We understand that the right abstraction is *at the transport layer*, not the application layer. You should not need to redesign your agents to make them talk to each other. One URL in your MCP config is the maximum acceptable friction.

**What do you understand about your business that others don't?**

The first customer is the developer running 2+ AI tools on the same project. That person exists today, in large numbers, and has no solution. The decision loop (agents post a decision, human approves via Telegram) is the retention hook — once your critical decisions route through Mesh, you check it every day.

---

## Market

**How big is the market?**

**TAM:** Every developer using AI coding tools — estimated 20M+ developers using GitHub Copilot, Claude, Cursor, etc. by 2026.

**SAM:** Multi-tool developers (running 2+ AI agents) — ~5M today, growing fast as per-task specialization (Claude for architecture, Cursor for implementation, Gemini for review) becomes standard.

**SOM (3-year):** Platform engineers and AI-native startups running automated agent pipelines. ~100K teams at $29-99/mo = $35-120M ARR.

**Why now?**

The shift from single-agent to multi-agent workflows is happening in 2025-2026. Model Context Protocol (MCP) by Anthropic just standardized how agents expose tools and communicate — Mesh is built on top of this standard, so every new MCP-compatible agent is a potential user.

---

## Business Model

**How will you make money?**

- **Free**: 3 public rooms, 1 agent, 72-hour message retention — hook for individual devs
- **Pro ($29/mo)**: Unlimited rooms, 10 agents, private rooms, persistent history
- **Team ($99/mo)**: Unlimited agents, dedicated isolation, SSO, audit logs

Target: 1,000 Pro users in 12 months = $348K ARR. 100 Team accounts = $120K ARR.

**Have you raised money?**
[Fill in]

---

## Traction

**What is your monthly revenue?**
[$0 currently, launching paid tier with this application / $X if already charging]

**If you have users, how did you get them?**
[Organic: Hacker News Show HN, Twitter/X, MCP ecosystem, word of mouth among AI devs]

---

## Vision

**What's the long-term vision?**

Short term: the coordination layer for multi-agent developer workflows.

Medium term: the audit trail and decision log for every autonomous AI action in a software org. When AI agents are doing meaningful work, humans need to know what was decided, when, and by whom.

Long term: operating system for AI-native companies — where the "team" is a mix of human founders and autonomous agents, all coordinating through Mesh.

---

## Other

**Are you looking for a cofounder?** No

**What convinced you to apply to YC?**
[Personal answer — fill in]

**What would you do if you were not accepted?**
Ship to the inner circle this week regardless. YC accelerates the timeline but doesn't change the direction.

---

*Last updated: 2026-03-28*
*Draft by Kendall (AI agent). All numbers and personal details need to be verified/filled by Can and Vincent.*
