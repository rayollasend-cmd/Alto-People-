#!/usr/bin/env node
/**
 * Brief 2-5 step 7 — dependency scanning (CC7.1).
 *
 *   node scripts/dependency-scan.mjs
 *
 * Runs `npm audit --omit=dev` (production dependencies only) and fails when a
 * high or critical advisory is not on security/accepted-risks.json, or when
 * an accepted entry is past its expiry. With EVIDENCE_INGEST_URL and
 * EVIDENCE_INGEST_TOKEN set (CI secrets the owner adds), the result is posted
 * as SOC 2 evidence (control dependency-scanning): package names, severities
 * and counts only.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const raw = (() => {
  try {
    return execFileSync('npm', ['audit', '--omit=dev', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: process.platform === 'win32' });
  } catch (err) {
    // npm audit exits non-zero when it finds anything; its JSON is still on stdout.
    return err.stdout;
  }
})();
const audit = JSON.parse(raw);
const accepted = JSON.parse(readFileSync(new URL('../security/accepted-risks.json', import.meta.url), 'utf8')).accepted;
const today = new Date().toISOString().slice(0, 10);

const serious = Object.entries(audit.vulnerabilities ?? {}).filter(([, v]) => v.severity === 'high' || v.severity === 'critical');
const unaccepted = serious.filter(([name]) => !accepted.some((a) => a.package === name));
const expired = accepted.filter((a) => a.expires < today);
const stale = accepted.filter((a) => !serious.some(([name]) => name === a.package));

const counts = audit.metadata?.vulnerabilities ?? {};
console.log(`Production dependencies: ${counts.critical ?? 0} critical, ${counts.high ?? 0} high, ${counts.moderate ?? 0} moderate, ${counts.low ?? 0} low.`);
for (const [name, v] of serious) console.log(`  ${v.severity.padEnd(8)} ${name}${accepted.some((a) => a.package === name) ? '  (accepted)' : ''}`);
for (const a of stale) console.log(`  note: ${a.package} is on the accepted list but no longer reported; remove it.`);
for (const a of expired) console.log(`  EXPIRED acceptance: ${a.package} (expired ${a.expires}).`);

const ok = unaccepted.length === 0 && expired.length === 0;
const evidence = {
  control: 'dependency-scanning',
  status: ok ? (serious.length ? 'WARN' : 'PASS') : 'FAIL',
  summary: ok
    ? serious.length
      ? `No unaccepted high or critical advisory; ${serious.length} accepted with reasons and expiry.`
      : 'No high or critical advisory in production dependencies.'
    : `${unaccepted.length} unaccepted and ${expired.length} expired high or critical advisories.`,
  details: {
    counts,
    serious: serious.map(([name, v]) => ({ package: name, severity: v.severity, accepted: accepted.some((a) => a.package === name) })),
    expired: expired.map((a) => a.package),
    commit: process.env.GITHUB_SHA ?? null,
  },
};

if (process.env.EVIDENCE_INGEST_URL && process.env.EVIDENCE_INGEST_TOKEN) {
  const res = await fetch(process.env.EVIDENCE_INGEST_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.EVIDENCE_INGEST_TOKEN}` }, body: JSON.stringify(evidence) });
  console.log(`Evidence ${res.ok ? 'recorded' : `not recorded (HTTP ${res.status})`}.`);
}

if (!ok) {
  for (const [name, v] of unaccepted) console.error(`Unaccepted ${v.severity}: ${name}. Fix it, or accept it in security/accepted-risks.json with a reason and an expiry.`);
  process.exit(1);
}
