import { test, type Page } from '@playwright/test';

/**
 * Screenshots for the new associate's welcome guide: the real phone UI,
 * driven against a mocked API (no backend needed). Skipped in CI; run by
 * hand whenever the guide needs refreshing after a release:
 *   cd apps/web && WELCOME_SHOTS=1 npx playwright test e2e/welcome-shots.spec.ts
 * Output: apps/web/e2e-results/welcome/*.png (iPhone 13 frame, 2x, light).
 */

test.skip(!process.env.WELCOME_SHOTS, 'welcome-guide screenshot harness; set WELCOME_SHOTS=1 to run it');

const A = '11111111-1111-4111-8111-111111111111';
const U = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const L = '44444444-4444-4444-8444-444444444444';
const APP = '55555555-5555-4555-8555-555555555555';

const user = {
  id: U, email: 'maria.lopez@example.com', role: 'ASSOCIATE', primaryRole: 'ASSOCIATE', availableRoles: ['ASSOCIATE'],
  status: 'ACTIVE', clientId: null, clientName: null, locationId: null, locationName: null, regionId: null, regionName: null,
  associateId: A, firstName: 'Maria', lastName: 'Lopez', photoUrl: null, timezone: 'America/New_York', language: 'en', mfaEnabled: false,
};

const iso = (daysFromNow: number, hour: number, minute = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
};
const ymd = (daysFromNow: number) => {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
};

const shift = (id: string, day: number, from: number, to: number, status = 'ASSIGNED') => ({
  id, clientId: C, clientName: 'Front Beach Market', position: 'Cashier', startsAt: iso(day, from), endsAt: iso(day, to),
  location: 'Front Beach 218', locationId: L, locationName: 'Front Beach 218', timezone: 'America/New_York',
  hourlyRate: 15, payRate: 15, effectivePayRate: 15, status, notes: null, assignedAssociateId: A, assignedAssociateName: 'Maria Lopez',
  assignedAt: iso(-2, 9), cancellationReason: null, scheduledMinutes: (to - from) * 60, publishedAt: iso(-2, 9), lateNoticeReason: null,
  acknowledgedAt: status === 'ASSIGNED' && day > 1 ? null : iso(-1, 9), confirmationAsk: null,
});

const task = (id: string, kind: string, title: string, order: number, status: 'DONE' | 'PENDING') => ({
  id: `66666666-6666-4666-8666-66666666666${id}`, kind, status, title, description: null, order, documentId: null,
  completedAt: status === 'DONE' ? iso(-1, 10) : null, dueOffsetDays: null,
});

const application = {
  id: APP, associateId: A, clientId: C, associateName: 'Maria Lopez', clientName: 'Front Beach Market', onboardingTrack: 'STANDARD',
  status: 'DRAFT', position: 'Cashier', startDate: ymd(5), invitedAt: iso(-1, 9), submittedAt: null, percentComplete: 33,
  employmentType: 'W2_EMPLOYEE', approvedAt: null, rejectedAt: null, rejectionReason: null, cancelledAt: null, cancellationReason: null,
  tasks: [
    task('1', 'PROFILE_INFO', 'Profile information', 1, 'DONE'),
    task('2', 'PROFILE_PHOTO', 'Take your profile photo', 2, 'DONE'),
    task('3', 'DOCUMENT_UPLOAD', 'Identity documents', 3, 'DONE'),
    task('4', 'I9_VERIFICATION', 'I-9 verification', 4, 'PENDING'),
    task('5', 'W4', 'W-4 tax withholding', 5, 'PENDING'),
    task('6', 'DIRECT_DEPOSIT', 'Direct deposit', 6, 'PENDING'),
    task('7', 'POLICY_ACK', 'Policy acknowledgments', 7, 'PENDING'),
    task('8', 'E_SIGN', 'Document e-signatures', 8, 'PENDING'),
    task('9', 'AVAILABILITY', 'Tell us when you can work', 9, 'PENDING'),
  ],
};

const doc = (id: string, kind: string, filename: string, status: string, expiresAt: string | null) => ({
  id: `77777777-7777-4777-8777-77777777777${id}`, associateId: A, associateName: 'Maria Lopez', clientId: C, kind, side: null,
  filename, mimeType: 'image/jpeg', size: 240000, status, expiresAt, rejectionReason: status === 'REJECTED' ? 'Blurry / unreadable' : null,
  verifiedById: null, verifierEmail: null, verifiedAt: status === 'VERIFIED' ? iso(-1, 11) : null, createdAt: iso(-1, 10), fileAvailable: true,
});

const earnings = () => {
  const days = Array.from({ length: 7 }, (_, i) => ({ date: ymd(i - 3), workedMinutes: i < 3 ? 480 : 0, workedAmount: i < 3 ? 120 : 0, scheduledMinutes: i >= 3 && i < 6 ? 480 : 0, scheduledAmount: i >= 3 && i < 6 ? 120 : 0, weekStart: ymd(-3), weekEnd: ymd(3) }));
  return { hourlyRate: 15, earnedSoFar: 360, workedHours: 24, projectedWeek: 720, remainingHours: 24, onClock: false, currentRatePerHour: 15, currentShiftEarned: null, overtime: { thresholdHours: 40, multiplier: 1.5, unlocked: false, otHoursSoFar: 0, projectedOtHours: 0 }, lastWeekEarned: 577.5, days, openShifts: { count: 1, estAmount: 120 }, takeHome: { gross: 720, taxes: 106, deductions: 0, advances: 0, net: 614, basis: 'W4' }, todayShift: null };
};
const RIDE_AGREEMENT = {
  title: 'Ride charge authorization', version: 1, lang: 'en', fareCents: 500, noShowFeeCents: 100,
  body: 'I authorize Alto People to deduct the fare for each Alto van ride I book ($5.00 each way) and the missed-van fee ($1.00) from my paycheck for the pay period in which the ride happened.\n\nI understand that no deduction will take my pay below the minimum wage for the hours I worked, and that I can withdraw this authorization at any time from the Ride page.',
};
const transport = (signed = false) => ({
  settings: { fareCents: 500, noShowFeeCents: 100, cutoffHours: 10, shortNoticeMinutes: 90, dispatchPhone: '(850) 555-0140' },
  consent: signed ? { acceptedAt: iso(-1, 10) } : null,
  authorization: signed
    ? { current: true, signedAt: iso(-1, 10), signedName: 'Maria Lopez', version: 1, fareCents: 500, noShowFeeCents: 100, withdrawnAt: null, documentId: null, reason: null, agreement: RIDE_AGREEMENT }
    : { current: false, signedAt: null, signedName: null, version: null, fareCents: 500, noShowFeeCents: 100, withdrawnAt: null, documentId: null, reason: null, agreement: RIDE_AGREEMENT },
  charges: { pendingCents: 0, rides: 0, noShows: 0, nextPayday: { payDate: ymd(6), periodStart: ymd(-8), periodEnd: ymd(5) } },
  profileAddress: { address: '12 Gulf Blvd, Panama City Beach, FL' }, defaultStoreId: L,
  places: [], stops: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Seaside housing', address: '12 Gulf Blvd, Panama City Beach, FL' }],
  stores: [{ id: L, name: 'Front Beach 218', address: '218 Front Beach Rd' }],
  shifts: [{ id: 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1', startsAt: iso(1, 9), endsAt: iso(1, 17), position: 'Cashier', locationId: L }],
  rides: [], defaultPickup: null,
});

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mN8+vTpfwAI3gOY8VGnvQAAAABJRU5ErkJggg==';

const supervisor = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Jordan Reyes', role: 'SUPERVISOR', roleLabel: 'Supervisor', photoUrl: null };
const me = { id: U, name: 'Maria Lopez', role: 'ASSOCIATE', roleLabel: 'Associate', photoUrl: null };
const conversations = [
  { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', kind: 'STORE_CHANNEL', title: 'Front Beach 218', participants: [supervisor, me], lastMessageAt: iso(0, 8, 5), lastPreview: 'Welcome aboard, Maria! Your first shift is Monday at 9. Park in the back lot and come to the service desk.', unread: 1 },
  { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', kind: 'DIRECT', title: 'Jordan Reyes', participants: [supervisor, me], lastMessageAt: iso(-1, 16, 40), lastPreview: 'Thanks for sending the photo of your ID — HR has it now.', unread: 0 },
];

const wallet = {
  person: { name: 'Maria Lopez', since: ymd(-1) },
  items: [
    { kind: 'training', id: 'f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1', title: 'Food handler certificate', issuer: 'ServSafe', earnedAt: ymd(-200), expiresAt: ymd(21), state: 'expiring' },
    { kind: 'qualification', id: 'f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2f2', title: 'Cashier — point of sale', issuer: 'Alto People', earnedAt: ymd(-1), expiresAt: null, state: 'valid' },
    { kind: 'document', id: '77777777-7777-4777-8777-777777777771', title: 'Government ID', issuer: null, earnedAt: ymd(-1), expiresAt: ymd(400), state: 'valid' },
  ],
};
const badge = {
  workerName: 'Maria Lopez', workerNumber: '4821', title: 'Cashier', siteName: 'Front Beach 218', employerName: 'Alto People',
  badgeToken: 'altobadge_demo', badgeVersion: 1, photoUrl: null, apple: { available: true, missing: [] }, google: { available: true, missing: [] },
};
const payPreview = () => ({
  available: true, reason: null, payDate: ymd(6), opensOn: ymd(-1), periodStart: ymd(-8), periodEnd: ymd(5), source: 'ESTIMATE',
  days: [0, 1, 2].map((i) => ({ date: ymd(i - 3), hours: 8, entries: [{ id: `e${i}e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1`, clockInAt: iso(i - 3, 9), clockOutAt: iso(i - 3, 17), siteName: 'Front Beach 218', approved: true }] })),
  earnings: [{ line: 'Regular hours', kind: 'REGULAR', hours: 24, rate: 15, amount: 360 }],
  gross: 360, taxes: [{ line: 'Federal income tax', kind: 'FEDERAL', amount: 21.6 }, { line: 'Social Security', kind: 'SOCIAL_SECURITY', amount: 22.32 }, { line: 'Medicare', kind: 'MEDICARE', amount: 5.22 }],
  deductions: [], paidAhead: 0, net: 310.86, check: null,
});

async function mockApi(page: Page, signedIn = true, signedRides = false) {
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message, String(e.stack).split('\n').slice(0, 8).join(' | ')));
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname.replace(/^\/api/, '');
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (p === '/auth/me') return json({ user: signedIn ? user : null });
    if (p === '/auth/me/nav-pins') return json({ pinned: [] });
    if (p === '/me/inbox')
      return json({
        total: 2,
        sources: [
          { key: 'shifts-to-confirm', label: 'Shifts to confirm', description: 'Tell us you will be there.', count: 1, path: '/scheduling' },
          { key: 'documents', label: 'Documents needing attention', description: 'One upload was sent back.', count: 1, path: '/documents' },
        ],
      });
    if (p === '/scheduling/me/shifts') return json({ shifts: [shift('a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1', 1, 9, 17), shift('b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2', 3, 12, 20), shift('c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3', 5, 9, 17)] });
    if (p === '/shifts/open') return json({ shifts: [{ ...shift('d4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4d4', 2, 14, 22, 'OPEN'), assignedAssociateId: null, assignedAssociateName: null }] });
    if (p === '/self/me/employee-number') return json({ employeeNumber: '4821', issuedAt: iso(-1, 12) });
    if (p === '/payroll/me/next-payday') return json({ nextPayday: { payDate: ymd(6), periodStart: ymd(-8), periodEnd: ymd(5), schedule: 'Biweekly (Sat–Fri)' } });
    if (p === '/payroll/me/items')
      return json({
        items: [{ id: '88888888-8888-4888-8888-888888888888', payrollRunId: '99999999-9999-4999-8999-999999999999', associateId: A, associateName: 'Maria Lopez', hoursWorked: 38.5, hourlyRate: 15, grossPay: 577.5, federalWithholding: 41.2, fica: 35.81, medicare: 8.37, stateWithholding: 0, postTaxDeductions: 0, preTaxDeductions: 0, deductions: [], taxState: 'FL', ytdWages: 577.5, ytdMedicareWages: 577.5, employerFica: 35.81, employerMedicare: 8.37, employerFuta: 3.47, employerSuta: 15.6, netPay: 492.12, periodStart: ymd(-22), periodEnd: ymd(-9), payDate: ymd(-8), status: 'DISBURSED' }],
        year: new Date().getFullYear(), paystubCount: 1, gross: 577.5, federalWithholding: 41.2, fica: 35.81, medicare: 8.37, stateWithholding: 0, netPay: 492.12,
      });
    if (p === '/time-off/me/balance') return json({ balances: [{ category: 'SICK', balanceMinutes: 480 }, { category: 'PTO', balanceMinutes: 0 }], recentLedger: [] });
    if (p === '/time-off/me/requests' || p === '/time-off/me') return json({ requests: [] });
    if (p === `/onboarding/applications/${APP}`) return json(application);
    if (p === '/onboarding/me/applications' || p === '/onboarding/applications/me') return json({ applications: [application] });
    if (p === '/documents/me')
      return json({ documents: [doc('1', 'ID', 'drivers-license.jpg', 'VERIFIED', ymd(400)), doc('2', 'SSN_CARD', 'ssn-card.jpg', 'REJECTED', null), doc('3', 'OTHER', 'food-handler-card.jpg', 'VERIFIED', ymd(21))] });
    if (p === '/scheduling/me/availability') return json({ windows: [] });
    if (p === '/scheduling/me/availability/exceptions') return json({ exceptions: [] });
    if (p === '/my/agreements') return json({ agreements: [] });
    if (p === '/time-corrections/mine') return json({ attestation: 'I certify that the times in this request are true and correct, and that I am asking to change my own time record.', requests: [], entries: [{ id: 'e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1', clockInAt: iso(-1, 9), clockOutAt: null, status: 'OPEN', siteName: 'Front Beach 218', timezone: 'America/New_York' }], sites: [{ id: L, name: 'Front Beach 218' }] });
    if (p === '/time/me/earnings') return json(earnings());
    if (p === '/time/me/active') return json({ active: null });
    if (p === '/time/me/entries') return json({ entries: [] });
    if (p === '/onboarding/applications') return json({ applications: [application], total: 1, page: 1, pageSize: 50 });
    if (p === '/me/first-paycheck') return json({ lane: null });
    if (p === '/emergency/me') return json({ emergency: null, answer: null });
    if (p === '/communications/me/inbox') return json({ notifications: [], total: 0 });
    if (p === '/learning/me') return json({ enrollments: [] });
    if (p === '/self/me/ready-to-work') return json({ kit: null });
    if (p === '/transport/me/live') return json({ live: null });
    if (p === '/transport/me') return json(transport(signedRides));
    if (p === '/communications/me' || p === '/communications/me/unread') return json({ items: [], unread: 0, notifications: [] });
    if (p === '/messages/conversations') return json({ conversations });
    if (p === '/messages/unread') return json({ unread: 1 });
    if (p === '/me/wallet') return json(wallet);
    if (p === '/me/wallet/badge') return json(badge);
    if (p === '/me/wallet/credentials') return json({ credentials: [] });
    if (p === '/me/pay-preview') return json(payPreview());
    if (p === '/me/earned-wage') return json({ enabled: false, blocker: 'OFF', periodStart: ymd(-8), periodEnd: ymd(5), payDate: ymd(6), hoursWorked: 24, earnedGross: 360, earnedNet: 306, capPct: 50, cap: 153, maxPerPeriod: 300, drawn: 0, available: 0, fee: 0 });
    if (p === '/me/daily-pay') return json({ active: false, timing: 'NEXT_DAY', feeCents: 0, enrolled: false, onDailySchedule: false, canOptIn: false });
    if (p === '/me/pay-by-check') return json({ openPaycheck: null, override: null, request: null });
    if (p === '/my/verification-letters') return json({ letters: [] });
    if (p === '/self/me/w4') return json({ filingStatus: 'SINGLE', multipleJobs: false, dependentsAmount: 0, otherIncome: 0, deductions: 0, extraWithholding: 0, signedAt: iso(-1, 10), updatedAt: iso(-1, 10) });
    if (p === '/self/me/payout-method') return json({ method: { type: 'ACH', accountType: 'CHECKING', accountLast4: '4417', branchCard: false, verifiedAt: iso(-1, 10), updatedAt: iso(-1, 10) } });
    if (p === '/kiosk/config') return json({ geofenceRequired: false, tokenExpiresAt: null });
    if (p === '/health/version') return json({ version: 'welcome' });
    if (/^\/documents\/[^/]+\/download$/.test(p)) return route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from(PNG_1PX, 'base64') });
    if (p === '/events/stream' || p === '/hugo' || p === '/telemetry/web-vitals') return json({}, 204);
    console.log('UNMOCKED', req.method(), p);
    return json({ error: { code: 'not_found', message: 'not mocked' } }, 404);
  });
}

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e-results/welcome/${name}.png` });
const settle = async (page: Page) => {
  await page.waitForTimeout(1200);
};

test.describe.configure({ mode: 'serial' });
test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: 'light' });

test('login', async ({ page }) => {
  await mockApi(page, false);
  await page.goto('/login');
  await settle(page);
  await shot(page, '01-login');
});

test('home', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  await settle(page);
  await shot(page, '02-home');
  await page.getByRole('button', { name: /More — open full navigation/i }).click();
  await settle(page);
  await shot(page, '03-more-sheet');
});

test('checklist and availability', async ({ page }) => {
  await mockApi(page);
  await page.goto(`/onboarding/me/${APP}`);
  await settle(page);
  await shot(page, '04-checklist');
  await page.goto(`/onboarding/me/${APP}/tasks/availability`);
  await settle(page);
  await shot(page, '05-availability-task');
});

test('schedule, time off, my time', async ({ page }) => {
  await mockApi(page);
  await page.goto('/scheduling');
  await settle(page);
  await shot(page, '06-schedule');
  await page.goto('/time-off');
  await settle(page);
  await shot(page, '07-time-off');
  await page.goto('/time-attendance');
  await settle(page);
  await shot(page, '08-my-time');
});

test('pay, documents, credentials', async ({ page }) => {
  await mockApi(page);
  await page.goto('/payroll');
  await settle(page);
  await shot(page, '09-pay');
  await page.goto('/documents');
  await settle(page);
  await shot(page, '10-documents');
  await page.goto('/me/wallet');
  await settle(page);
  await shot(page, '11-credentials');
});

test('kiosk, settings, messages, rides', async ({ page }) => {
  await mockApi(page);
  await page.goto('/login');
  await page.evaluate(() => window.localStorage.setItem('alto.kiosk.deviceToken', 'altokiosk_welcome_demo'));
  await page.goto('/kiosk');
  await settle(page);
  await shot(page, '12-kiosk');
  await page.getByRole('button').first().click();
  await settle(page);
  await shot(page, '12b-kiosk-pad');
  await page.goto('/settings');
  await settle(page);
  await shot(page, '13-settings');
  await page.goto('/messages');
  await settle(page);
  await shot(page, '14-messages');
  await page.goto('/rides');
  await settle(page);
  await shot(page, '15-rides');
});

test('rides once authorized', async ({ page }) => {
  await mockApi(page, true, true);
  await page.goto('/rides');
  await settle(page);
  await shot(page, '15b-rides-book');
});

test('dialogs: cannot make it, request time off, fix a punch', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  await settle(page);
  const cant = page.getByRole('button', { name: /can't make it|can’t make it/i }).first();
  if (await cant.count()) {
    await cant.click();
    await settle(page);
    await shot(page, '16-cant-make-it');
  }
  await page.goto('/time-off');
  await settle(page);
  await page.getByRole('button', { name: /Request time off/i }).first().click();
  await settle(page);
  await shot(page, '17-request-time-off');
  await page.goto('/time-attendance');
  await settle(page);
  await page.getByRole('button', { name: /Fix a punch/i }).first().click();
  await settle(page);
  await shot(page, '18-fix-a-punch');
});
