import { z } from 'zod';
import type { AgentFamily, AgentGatedAction, AgentScope } from './contracts.js';
import type { TenantModule, TenantModules } from './tenantProfile.js';

/**
 * The agent capability catalog (agent families step 0;
 * docs/agent-families-investigation.md §4.1 and §8.3).
 *
 *   The capability is the unit of governance (owner's decision 1, 2026-10-13):
 *   each one carries its scopes, the gate it files, the scorecard metrics it
 *   reports and its certification fixtures, and has its own switch on the
 *   agent (AgentCapability). The catalog ships with the code: certification
 *   compares against it, Hugo's help text and the Agents page read it, and
 *   the MCP catalog (Brief 2-7) is generated from it.
 *
 *   A capability is offered only where every module it needs is on
 *   (capabilitiesFor), so a tenant with compliance off never sees a
 *   Compliance capability anywhere.
 */

/** A small seeded world for a certification scenario: loaded into a throwaway tenant, run once with `now` fixed. */
export interface CapabilityScenarioFixture {
  name: string;
  /** Minutes from the fixed `now`, so a fixture never depends on the clock. */
  world: {
    sites?: Array<{ ref: string; name: string; timezone?: string }>;
    people?: Array<{ ref: string; firstName: string; lastName: string; placedAt?: string }>;
    shifts?: Array<{ ref: string; siteRef: string; position: string; startsInMinutes: number; hours: number; assigneeRef?: string | null }>;
    /** A site's floor target (headcount), in effect from 30 days before `now`. */
    targets?: Array<{ siteRef: string; headcount: number }>;
    /** Documents on file, in the order given (a later one of the same kind is newer). */
    documents?: Array<{ personRef: string; kind: 'ID' | 'I9_SUPPORTING' | 'J1_VISA' | 'J1_DS2019'; expiresInDays: number }>;
    /** Approved hires: start date days before `now`, and how far their I-9 got. */
    hires?: Array<{ personRef: string; startDaysAgo: number; section1: boolean; section2: boolean }>;
    /** What a site requires (coverage.credentials): a vaccination kind. */
    requirements?: Array<{ siteRef: string; vaccinationKind: 'COVID19' | 'INFLUENZA_FLU' | 'HEPATITIS_B' | 'TDAP' | 'MMR' | 'TB_TEST'; label: string }>;
    /** Vaccinations on file; expiresInDays null = does not expire, negative = expired. */
    vaccinations?: Array<{ personRef: string; kind: 'COVID19' | 'INFLUENZA_FLU' | 'HEPATITIS_B' | 'TDAP' | 'MMR' | 'TB_TEST'; expiresInDays: number | null }>;
    /** Unexcused attendance on record, days before `now` (the no-show risk score reads it). */
    attendance?: Array<{ personRef: string; kind: 'NO_CALL_NO_SHOW' | 'CALL_OUT' | 'LATE'; daysAgo: number }>;
  };
  input: Record<string, unknown>;
  expected: { output?: Record<string, unknown>; allowedActions?: string[] };
}

export interface AgentCapabilityDef {
  key: string;
  family: AgentFamily;
  label: string;
  /** Every module listed must be on for the capability to be offered. */
  requiresModule: readonly TenantModule[];
  /** The scopes the capability uses; an agent holding it needs them. */
  scopes: readonly AgentScope[];
  /** The gated action its proposals file, or null when it only reads or notifies. */
  gate: AgentGatedAction | null;
  /** Sends notices to people without a gate (owner's decision 3: one a person a day, logged). */
  notifies: boolean;
  /** Scorecard metric keys (§4.3), on top of the registry's generic counts. */
  metrics: readonly string[];
}

const SHIFT_FILL_FIXTURE: CapabilityScenarioFixture = {
  name: 'Two open shifts, three on the bench, one already working: the free person is proposed',
  world: {
    sites: [{ ref: 'hotel', name: 'The Grand Hotel', timezone: 'America/Chicago' }],
    people: [
      { ref: 'tess', firstName: 'Tess', lastName: 'Free', placedAt: 'hotel' },
      { ref: 'omar', firstName: 'Omar', lastName: 'Busy', placedAt: 'hotel' },
      { ref: 'ivy', firstName: 'Ivy', lastName: 'Busy', placedAt: 'hotel' },
    ],
    shifts: [
      { ref: 'open1', siteRef: 'hotel', position: 'Housekeeper', startsInMinutes: 600, hours: 8, assigneeRef: null },
      { ref: 'open2', siteRef: 'hotel', position: 'Housekeeper', startsInMinutes: 600, hours: 8, assigneeRef: null },
      { ref: 'omarShift', siteRef: 'hotel', position: 'Housekeeper', startsInMinutes: 540, hours: 8, assigneeRef: 'omar' },
      { ref: 'ivyShift', siteRef: 'hotel', position: 'Housekeeper', startsInMinutes: 660, hours: 8, assigneeRef: 'ivy' },
    ],
  },
  input: { shiftRef: 'open1' },
  expected: { output: { proposedRef: 'tess' }, allowedActions: ['propose'] },
};

const ATTENDANCE_CONFIRM_FIXTURE: CapabilityScenarioFixture = {
  name: 'Two shifts tomorrow, one holder with two no-call no-shows: only that holder is asked',
  world: {
    sites: [{ ref: 'hotel', name: 'The Grand Hotel', timezone: 'America/Chicago' }],
    people: [
      { ref: 'rhea', firstName: 'Rhea', lastName: 'Risky', placedAt: 'hotel' },
      { ref: 'sam', firstName: 'Sam', lastName: 'Steady', placedAt: 'hotel' },
    ],
    shifts: [
      { ref: 'rheaShift', siteRef: 'hotel', position: 'Housekeeper', startsInMinutes: 1500, hours: 8, assigneeRef: 'rhea' },
      { ref: 'samShift', siteRef: 'hotel', position: 'Housekeeper', startsInMinutes: 1500, hours: 8, assigneeRef: 'sam' },
    ],
    attendance: [
      { personRef: 'rhea', kind: 'NO_CALL_NO_SHOW', daysAgo: 10 },
      { personRef: 'rhea', kind: 'NO_CALL_NO_SHOW', daysAgo: 40 },
      { personRef: 'sam', kind: 'LATE', daysAgo: 5 },
    ],
  },
  input: {},
  expected: { output: { askedRef: 'rheaShift', asked: 1 }, allowedActions: ['ask'] },
};

const COVERAGE_FORECAST_FIXTURE: CapabilityScenarioFixture = {
  name: 'Two sites, one short tomorrow: the forecast names it and the gap',
  world: {
    sites: [
      { ref: 'hotel', name: 'The Grand Hotel', timezone: 'America/Chicago' },
      { ref: 'inn', name: 'The Other Inn', timezone: 'America/Chicago' },
    ],
    people: [
      { ref: 'ana', firstName: 'Ana', lastName: 'One', placedAt: 'hotel' },
      { ref: 'ben', firstName: 'Ben', lastName: 'Two', placedAt: 'hotel' },
      { ref: 'cy', firstName: 'Cy', lastName: 'Three', placedAt: 'inn' },
    ],
    shifts: [
      { ref: 'a1', siteRef: 'hotel', position: 'Housekeeper', startsInMinutes: 1440, hours: 1, assigneeRef: 'ana' },
      { ref: 'b1', siteRef: 'hotel', position: 'Housekeeper', startsInMinutes: 1440, hours: 1, assigneeRef: 'ben' },
      { ref: 'c1', siteRef: 'inn', position: 'Housekeeper', startsInMinutes: 1440, hours: 1, assigneeRef: 'cy' },
    ],
    targets: [
      { siteRef: 'hotel', headcount: 4 },
      { siteRef: 'inn', headcount: 1 },
    ],
  },
  input: {},
  expected: { output: { shortRef: 'hotel', gap: 2 }, allowedActions: [] },
};

const DOCUMENT_CHASE_FIXTURE: CapabilityScenarioFixture = {
  name: 'Three people with IDs on file: only the one expiring soon with nothing newer is chased',
  world: {
    people: [
      { ref: 'ana', firstName: 'Ana', lastName: 'Soon' },
      { ref: 'ben', firstName: 'Ben', lastName: 'Renewed' },
      { ref: 'cy', firstName: 'Cy', lastName: 'Later' },
    ],
    documents: [
      { personRef: 'ana', kind: 'ID', expiresInDays: 10 },
      { personRef: 'ben', kind: 'ID', expiresInDays: 10 },
      { personRef: 'ben', kind: 'ID', expiresInDays: 400 },
      { personRef: 'cy', kind: 'I9_SUPPORTING', expiresInDays: 60 },
    ],
  },
  input: {},
  expected: { output: { chasedRef: 'ana', items: 1 }, allowedActions: ['notify'] },
};

const I9_SECTION2_FIXTURE: CapabilityScenarioFixture = {
  name: 'Three approved hires: the two without Section 2 are on the worklist, the earliest deadline first',
  world: {
    people: [
      { ref: 'dan', firstName: 'Dan', lastName: 'Early' },
      { ref: 'eve', firstName: 'Eve', lastName: 'Recent' },
      { ref: 'fay', firstName: 'Fay', lastName: 'Done' },
    ],
    hires: [
      { personRef: 'eve', startDaysAgo: 1, section1: true, section2: false },
      { personRef: 'dan', startDaysAgo: 5, section1: true, section2: false },
      { personRef: 'fay', startDaysAgo: 4, section1: true, section2: true },
    ],
  },
  input: {},
  expected: { output: { firstRef: 'dan', pending: 2 } },
};

const INCIDENT_LOOP_FIXTURE: CapabilityScenarioFixture = {
  name: 'Five open incidents: a case for the recordable days-away one with a person; the week-old first-aid one can close',
  world: {},
  input: {
    incidents: [
      { ref: 'away', openDays: 4, severity: 'DAYS_AWAY', recordable: true, person: true },
      { ref: 'fresh', openDays: 1, severity: 'DAYS_AWAY', recordable: true, person: true },
      { ref: 'nobody', openDays: 5, severity: 'RESTRICTED_DUTY', recordable: true, person: false },
      { ref: 'hasCase', openDays: 9, severity: 'FATAL', recordable: true, person: true, hasCase: true },
      { ref: 'scrape', openDays: 8, severity: 'FIRST_AID', recordable: false, person: true },
    ],
  },
  expected: { output: { caseFor: 'away', closable: 'scrape' }, allowedActions: ['propose'] },
};

const COVERAGE_CREDENTIALS_FIXTURE: CapabilityScenarioFixture = {
  name: 'A hotel requires a TB test: one current, one expired, one never tested; two are missing it',
  world: {
    sites: [{ ref: 'hotel', name: 'The Grand Hotel', timezone: 'America/Chicago' }],
    people: [
      { ref: 'ana', firstName: 'Ana', lastName: 'Current', placedAt: 'hotel' },
      { ref: 'ben', firstName: 'Ben', lastName: 'Expired', placedAt: 'hotel' },
      { ref: 'cy', firstName: 'Cy', lastName: 'Never', placedAt: 'hotel' },
    ],
    requirements: [{ siteRef: 'hotel', vaccinationKind: 'TB_TEST', label: 'TB test' }],
    vaccinations: [
      { personRef: 'ana', kind: 'TB_TEST', expiresInDays: 200 },
      { personRef: 'ben', kind: 'TB_TEST', expiresInDays: -10 },
    ],
  },
  input: {},
  expected: { output: { coveredRef: 'ana', missing: 2 } },
};

const SCHEDULE_REPAIR_FIXTURE: CapabilityScenarioFixture = {
  name: 'A shift its holder can no longer work: the free person is proposed to cover it, never the holder or the busy one',
  world: {
    sites: [{ ref: 'hotel', name: 'The Grand Hotel', timezone: 'America/Chicago' }],
    people: [
      { ref: 'lena', firstName: 'Lena', lastName: 'Away', placedAt: 'hotel' },
      { ref: 'tess', firstName: 'Tess', lastName: 'Free', placedAt: 'hotel' },
      { ref: 'omar', firstName: 'Omar', lastName: 'Busy', placedAt: 'hotel' },
    ],
    shifts: [
      { ref: 'cover', siteRef: 'hotel', position: 'Housekeeper', startsInMinutes: 1440, hours: 8, assigneeRef: 'lena' },
      { ref: 'omarShift', siteRef: 'hotel', position: 'Housekeeper', startsInMinutes: 1380, hours: 8, assigneeRef: 'omar' },
    ],
  },
  input: { shiftRef: 'cover', replacesRef: 'lena' },
  expected: { output: { proposedRef: 'tess' }, allowedActions: ['propose'] },
};

/**
 * Each capability's certification fixtures, apart from the catalog itself:
 * server-only data the web never reads, so the bundler leaves it out of
 * every page (it rode in the main chunk inside AGENT_CAPABILITIES).
 */
export const CAPABILITY_SCENARIOS: Readonly<Record<string, readonly CapabilityScenarioFixture[]>> = {
  'shift.fill': [SHIFT_FILL_FIXTURE],
  'attendance.confirm': [ATTENDANCE_CONFIRM_FIXTURE],
  'schedule.repair': [SCHEDULE_REPAIR_FIXTURE],
  'coverage.forecast': [COVERAGE_FORECAST_FIXTURE],
  'document.chase': [DOCUMENT_CHASE_FIXTURE],
  'i9.section2': [I9_SECTION2_FIXTURE],
  'incident.loop': [INCIDENT_LOOP_FIXTURE],
  'coverage.credentials': [COVERAGE_CREDENTIALS_FIXTURE],
};

/** A capability's catalog fixtures (certification scenarios for a built-in holding it). */
export function capabilityScenarios(key: string): readonly CapabilityScenarioFixture[] {
  return CAPABILITY_SCENARIOS[key] ?? [];
}

export const AGENT_CAPABILITIES = [
  // Workforce
  {
    key: 'shift.fill',
    family: 'workforce',
    label: 'Fill open shifts',
    requiresModule: ['scheduling'],
    scopes: ['view:scheduling', 'view:org', 'manage:scheduling'],
    gate: 'SHIFT_ASSIGN',
    notifies: false,
    metrics: ['shiftsSeen', 'broadcastPickupRate', 'proposalsMade', 'proposalsApproved', 'filledBeforeStart', 'medianMinutesToFill'],
  },
  {
    key: 'attendance.confirm',
    family: 'workforce',
    label: 'Confirm tomorrow’s attendance',
    requiresModule: ['scheduling', 'time'],
    scopes: ['view:scheduling', 'view:time', 'manage:communications', 'manage:scheduling'],
    gate: 'SHIFT_ASSIGN',
    notifies: true,
    metrics: ['textsSent', 'answered', 'noShowsConfirmed', 'noShowsUnconfirmed', 'backupsAccepted'],
  },
  {
    key: 'schedule.repair',
    family: 'workforce',
    label: 'Repair coverage when it breaks',
    requiresModule: ['scheduling'],
    scopes: ['view:scheduling', 'view:org', 'manage:scheduling'],
    gate: 'SHIFT_ASSIGN',
    notifies: false,
    metrics: ['shiftsUncovered', 'proposalsMade', 'repairedBeforeStart'],
  },
  {
    key: 'coverage.forecast',
    family: 'workforce',
    label: 'Forecast coverage for the next seven days',
    requiresModule: ['scheduling'],
    scopes: ['view:scheduling', 'view:analytics'],
    gate: null,
    notifies: false,
    metrics: ['forecastErrorPct7d', 'forecastErrorPct1d'],
  },
  // Compliance
  {
    key: 'document.chase',
    family: 'compliance',
    label: 'Chase expiring documents',
    requiresModule: ['compliance'],
    scopes: ['view:compliance', 'manage:compliance', 'manage:communications'],
    gate: null,
    notifies: true,
    metrics: ['itemsChased', 'uploadedBeforeExpiry', 'expiredAnyway', 'escalations'],
  },
  {
    key: 'i9.section2',
    family: 'compliance',
    label: 'Keep I-9 Section 2 on time',
    requiresModule: ['compliance'],
    scopes: ['view:compliance', 'view:org'],
    gate: null,
    notifies: true,
    metrics: ['hires', 'completedInTime', 'late', 'everifyOpenedInTime'],
  },
  {
    key: 'incident.loop',
    family: 'compliance',
    label: 'Close the loop on incidents',
    requiresModule: ['compliance', 'hrCases'],
    scopes: ['view:compliance', 'open:hr-case'],
    gate: 'CASE_OPEN',
    notifies: true,
    metrics: ['openIncidents', 'medianAgeDays', 'closedAfterChase'],
  },
  {
    key: 'coverage.credentials',
    family: 'compliance',
    label: 'Credential coverage per site',
    requiresModule: ['compliance'],
    scopes: ['view:compliance', 'view:org'],
    gate: null,
    notifies: true,
    metrics: ['sitesBelowRequirement', 'gapsClosed'],
  },
] as const satisfies readonly AgentCapabilityDef[];

export type AgentCapabilityKey = (typeof AGENT_CAPABILITIES)[number]['key'];
const capabilityKeys = /* @__PURE__ */ AGENT_CAPABILITIES.map((c) => c.key) as [AgentCapabilityKey, ...AgentCapabilityKey[]];
export const AgentCapabilityKeySchema = /* @__PURE__ */ z.enum(capabilityKeys);

export function capabilityDef(key: string): AgentCapabilityDef | null {
  return (AGENT_CAPABILITIES as readonly AgentCapabilityDef[]).find((c) => c.key === key) ?? null;
}

/** True when every module the capability needs is on. A missing module set (no profile known) offers nothing. */
export function capabilityOffered(def: Pick<AgentCapabilityDef, 'requiresModule'>, modules: TenantModules | null | undefined): boolean {
  if (!modules) return false;
  return def.requiresModule.every((m) => modules[m]);
}

/**
 * The catalog for a tenant: the one source for Hugo's help text, the
 * Agents page and the MCP catalog. A capability whose module is off is
 * simply absent.
 */
export function capabilitiesFor(modules: TenantModules | null | undefined): AgentCapabilityDef[] {
  return (AGENT_CAPABILITIES as readonly AgentCapabilityDef[]).filter((c) => capabilityOffered(c, modules));
}

/* ---- Views ---------------------------------------------------------------- */

export const AgentProposalStatusSchema = /* @__PURE__ */ z.enum(['PROPOSED', 'APPROVED', 'REJECTED', 'EXPIRED', 'EXECUTED', 'FAILED', 'SUPERSEDED']);
export type AgentProposalStatus = z.infer<typeof AgentProposalStatusSchema>;

export interface AgentCapabilitySummary {
  key: string;
  label: string;
  family: AgentFamily;
  gate: AgentGatedAction | null;
  requiresModule: TenantModule[];
  /** False when the tenant has a required module off: the capability is not offered. */
  offered: boolean;
  enabled: boolean;
  suspendedAt: string | null;
  suspendedBy: { id: string; name: string } | null;
  suspendReason: string | null;
  driftErrorRatePct: number | null;
}

export interface AgentProposalSummary {
  id: string;
  workerId: string;
  capabilityKey: string;
  subjectType: string;
  subjectId: string | null;
  payload: Record<string, unknown>;
  approvalId: string | null;
  status: AgentProposalStatus;
  statusAt: string;
  outcome: Record<string, unknown> | null;
  outcomeAt: string | null;
  createdAt: string;
}

export interface CapabilityScorecard {
  key: string;
  days: number;
  proposed: number;
  approved: number;
  rejected: number;
  expired: number;
  executed: number;
  failed: number;
  superseded: number;
  /** executed / (executed + failed + rejected + expired), whole percent; null with nothing decided. */
  outcomeRatePct: number | null;
  /** The capability's own metrics (its catalog `metrics` keys); null where there is nothing to measure yet. */
  metrics: Record<string, number | null>;
}

export interface AgentTenantControlState {
  /** This organization's switch. */
  allSuspendedAt: string | null;
  suspendedBy: { id: string; name: string } | null;
  reason: string | null;
}

export const AgentProposalInputSchema = /* @__PURE__ */ z.object({
  capability: AgentCapabilityKeySchema,
  subjectType: z.string().trim().min(2).max(40),
  subjectId: z.string().uuid().nullable().optional(),
  /** What a person approves, in words. Required when the capability files a gate. */
  summary: z.string().trim().min(3).max(500).optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
});
export type AgentProposalInput = z.infer<typeof AgentProposalInputSchema>;
