# Alto People — product taxonomy

Effective 2026-10-13. This is the structure the code, the navigation, the docs and the Agents page follow. When a screen, a route, a module or a document is touched, it is brought in line with this page.

## North star

Alto People is an enterprise workforce platform built to stand beside Workday and to surpass it in the domains Workday does not serve: the frontline, seasonal, international and hybrid workforce of people, agents and robots, with a human accountable for every agent and robot. We are not matching Workday feature for feature. We are winning the workforce they don't serve, with governance they don't have, at a speed they can't move.

## Positioning

**The trusted platform for the hybrid workforce — people, AI agents, and Humanoids/Robots managed on one platform. The future of workforce management.** (The owner, 2026-10-13.) "Trusted" is a description, never a product name: Workday announced a "Trusted Agent Platform" on 2026-10-13.

## Names

- **Alto People** is the product.
- **Hugo** is the orchestrator and the assistant persona: "Hugo, by Alto People". Hugo is stored as a platform setting (`ASSISTANT_PLATFORM_NAME` in the shared contracts). Each tenant chooses the display name its team uses at tenant setup, with the prompt **"What would you like your team to call me?"** (`OrgSetting.assistantName`, default "Hugo"). Hugo's first message in every tenant, and his answer whenever anyone asks who or what he is, states the product name and that he is an AI assistant.
- **Compass** is the name of the logo mark only. It is not the name of anything in the taxonomy, the navigation or the code.

## The three layers

### Agents, orchestrated by Hugo

Each agent is a **family** with named **capabilities**. Every capability has its own scopes, its own approval gates and its own scorecard, and runs under the Agent Registry (Brief 1D-2) and its controls (Brief 1D-3).

| Group | Families |
|---|---|
| Agents for the Workforce | Talent · Workforce · Programs · Payroll · Decision Intelligence |
| Agents for Operations | Operations · Robotics · Safety |
| Agents for Compliance | Compliance · Audit · Contracts |
| Agents for Finance and Clients | Billing · Client · Decision Intelligence |
| Agents for IT and Developers | Deployment · Reliability · Developer |
| Agents for Everyone | Associate Self-Service · Manager Self-Service |

What exists today, placed in the taxonomy:

| Registry record | Family | Capability |
|---|---|---|
| Hugo on WhatsApp (the 1C-4 assistant) | Everyone / Associate Self-Service | payday, ride and schedule answers; supervisor handoff |
| Claude Code deployment workflow | IT and Developers / Deployment | build, test, push, watch the deploy |
| Boardroom agents | Workforce / Decision Intelligence | read reports, draft recommendations |

The first families to build after the registry are **Workforce** and **Compliance**.

### Platform

| Area | Contents |
|---|---|
| Hybrid Workforce Platform | one Worker registry for people, AI agents and humanoids/robots (1D-1), each with an accountable owner; Hugo; the Agent Registry, approval gates, kill switches, certification |
| Extend | Agent and App Builder · Agent-Ready Tools and an Alto People MCP server · Developer Platform |
| Governance and Trust | Responsible AI · Security and Compliance · Robot Safety |
| Workforce Data Cloud | the one definition of active, the reconciliation report, the data model, tenancy |
| Ecosystem | integrations (Fieldglass, ADP, Workday, UKG, Beeline), partners, manufacturers |

### Products

Workforce Management · Operations · Compliance · Payroll and Finance (including Planning and Analysis) · Client Services · Platform.

How today's modules map (the navigation's doors follow this — see docs/design-system.md §3.1):

| Product | Modules today |
|---|---|
| Workforce Management | Dashboard, People, Onboarding, Recruiting, Scheduling, Time and attendance, Team, Programs, Season Planner, Transport, Emergency mode, Workers |
| Operations | Store ops, Relay, Kiosk, Live board, Floor team, Coverage |
| Compliance | Compliance, Audit packets, Documents, Policies, E-Verify, OSHA, Hotline |
| Payroll and Finance | Payroll, Pay schedules, Finance overview, Labor costs, Reimbursements, Benefits, Analytics, Headcount |
| Client Services | Clients, Client portal, Region command center, Messages, Communications, Service reports |
| Platform | AI agents, Integrations, Reliability, Product analytics, Users and access, Branding, Release notes |

## Build order (unchanged)

1. Phase 1A — data integrity: the reconciliation report (1A-1), one definition of active (1A-2), the ride deduction removal (1A-3), users and access (1A-4).
2. Phase 1B — reliability.
3. Phase 1C — the modules: emergency mode, program lifecycle, season planner, WhatsApp.
4. Phase 1D — the registry and its controls, then the first families: Workforce and Compliance.
5. Phase 2 — product and multi-tenancy, plus **Brief 2-7: an Alto People MCP server** exposing governed tools (read schedules, propose a shift fill, open a case, request an approval) so external agents act under the registry's gates.
6. Phase 3 — enterprise, robots and orchestration.

## Rules for code

- Module keys, navigation groups and page titles use the Product names above.
- An agent record carries its family and capability; the Agents page groups by family.
- "Hugo" never appears as a hard-coded display name in a message: messages read the tenant's `assistantName`; the product name is `PRODUCT_NAME`.
- "Compass" appears only on the mark.
