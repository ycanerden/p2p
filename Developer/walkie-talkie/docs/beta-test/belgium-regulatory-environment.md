# Belgium Regulatory Environment — Mesh SaaS Market Entry

**Deliverable:** Regulatory & Legal Analysis
**Author:** Kendall Roy (Lead Engineer, Mesh)
**Project:** Internationalization Strategy — Belgium Market Entry
**Date:** 2026-03-29

---

## Executive Summary

Belgium presents a moderately complex regulatory environment for a SaaS company. The primary challenges are GDPR enforcement (Belgium has an active DPA), language law compliance, and sector-specific data rules. None of these are blockers — they are solvable with standard SaaS legal practices and two weeks of preparation.

---

## 1. Data Protection & Privacy

### GDPR (General Data Protection Regulation)
Belgium is an EU member state — GDPR applies in full. The Belgian supervisory authority is the **Gegevensbeschermingsautoriteit (GBA) / Autorité de protection des données (APD)**.

**GBA enforcement profile:**
- Active enforcer. Notable fines: IAB Europe (€250K, 2022), multiple telecom/media companies
- GBA processes complaints faster than average EU DPAs (~6–8 month resolution)
- Focus areas: consent mechanisms, cookie banners, data subject rights response times

**What Mesh must do:**
| Requirement | Action | Priority |
|---|---|---|
| Data Processing Agreement (DPA) | Standard SaaS DPA template — already needed for all EU customers | High |
| Privacy Policy (Dutch + French) | Translate existing policy | Medium |
| Cookie consent | Already required for EU — ensure compliant banner | High |
| Data subject rights (DSAR) | 30-day response SLA — implement email intake | Medium |
| Data residency | Not legally required but sales-helpful — EU region on Railway | Low |

**Mesh-specific note:** Mesh stores chat messages (agent-to-agent communication). Under GDPR Article 4, if any room contains natural persons' data, it is personal data. Rooms used purely for AI-to-AI coordination with no human data are lower risk. Recommend adding a terms clause clarifying use case.

---

## 2. Language Law

Belgium has three official language regions: Dutch (Flanders), French (Wallonia), French/German (Brussels). The **Law of 30 July 2018** and regional language decrees apply to commercial communications.

**Key rules:**
- B2B contracts with Belgian companies must be in the language of the counterparty's registered region
- Marketing communications: use the language of the target region, or bilingual Dutch/French for national campaigns
- Product UI: no legal requirement for localization, but expected for enterprise deals

**Practical impact for Mesh:**
- Landing page and pricing: bilingual (NL/FR) recommended for Belgian market campaigns
- Sales contracts: use region-appropriate language or English with a bilingual summary
- Support: English acceptable for tech/SaaS B2B, but Dutch/French option improves conversion

**Cost estimate:** €2,000–5,000 for professional translation of key pages + contract templates.

---

## 3. Electronic Commerce Law

Belgium transposed the **EU E-Commerce Directive** via the **Law of 11 March 2003**. Key requirements:

- Clear identification of the company (legal name, address, registration number) on the website
- Pricing must be clear, inclusive of applicable taxes
- Terms of service must be accessible before purchase
- Electronic contracts are valid — no wet signature required for SaaS subscriptions

**Mesh status:** Standard SaaS terms + Stripe checkout satisfies these requirements. Ensure Belgian VAT number is displayed if VAT-registered in Belgium.

---

## 4. VAT & Tax

| Threshold | Rule |
|---|---|
| < €10,000/year in Belgium | Use home country VAT (Netherlands/Ireland for most EU SaaS) |
| > €10,000/year in Belgium | Register for Belgian VAT or use OSS (One Stop Shop) scheme |

**Recommendation:** Register for EU VAT OSS scheme now (before hitting threshold). Single registration covers all EU member states. Stripe Tax handles the calculation automatically.

Belgian standard VAT rate: **21%**. Digital services (SaaS): 21%.

---

## 5. Employment Law (Not Applicable — 0 employees)

Mesh's 0-employee model eliminates Belgian employment law exposure entirely. No social security contributions, no works council requirements, no collective bargaining.

**This is a structural competitive advantage.** Belgian employer payroll costs run 30–35% above gross salary. Mesh carries zero of this burden.

---

## 6. Sector-Specific Rules

**AI Act (EU, phased in 2024–2026):**
- Mesh is a coordination platform for AI agents, not an AI system itself
- Agents using Mesh are the "AI systems" — their operators bear compliance responsibility
- Mesh's exposure: Article 28 (provider obligations) likely does not apply; Article 26 (deployer obligations) may apply if Mesh is classified as high-risk AI infrastructure
- **Recommendation:** Add an AI Act compliance note to terms of service. Monitor GPAI (General Purpose AI) rules under Article 51+

**NIS2 Directive (EU cybersecurity, effective Oct 2024):**
- Applies to "essential" and "important" entities
- SaaS platforms serving critical sectors (health, finance, public admin) may be classified as "important entities"
- If Mesh customers include those sectors: implement incident reporting (24h notification to CERT.be), basic cyber hygiene measures
- **Current status:** Unlikely to apply at early-stage Mesh. Revisit at 50+ enterprise customers.

---

## 7. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| GBA GDPR enforcement | Low (no Belgian user data complaints) | High | DPA template, DSAR process |
| Language law violation | Low (B2B SaaS, English acceptable) | Medium | Bilingual landing page |
| VAT non-compliance | Medium (if revenue grows fast) | Medium | OSS registration now |
| AI Act classification | Low (platform, not AI system) | High | Legal review at Series A |
| NIS2 scope creep | Low at current scale | Medium | Monitor customer verticals |

---

## 8. Recommended Actions (Priority Order)

1. **Week 1:** Register for EU VAT OSS via Belgian Finance portal (or home country equivalent)
2. **Week 1:** Add DPA template to Mesh terms — standard EU SaaS DPA covers Belgian requirements
3. **Week 2:** Translate Privacy Policy and key landing page to Dutch/French
4. **Week 2:** Add company legal details to website footer (required by e-commerce law)
5. **Month 2:** Brief legal counsel on AI Act Article 51+ exposure as product scales

**Estimated legal setup cost:** €3,000–8,000 one-time (translation + DPA drafting + VAT registration)
**Ongoing compliance cost:** €0 if automated via Stripe Tax + standard DSAR email intake

---

## Conclusion

Belgium's regulatory environment is **manageable and not a blocker**. GDPR is the primary exposure — and Mesh already needs GDPR compliance for all EU markets. The Belgium-specific additions are language law (bilingual content) and VAT OSS registration. 0-employee model eliminates the largest cost category (Belgian labor law) entirely.

**Regulatory readiness estimate: 2 weeks of preparation, < €10K total cost.**
