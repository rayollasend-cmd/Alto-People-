import { describe, expect, it } from 'vitest';
import { AckParseError, memberAt, parseAcknowledgments } from '../../lib/ediAck.js';
import { build834, segmentsOf, type Edi834Member } from '../../lib/edi834.js';
import { answerFor, businessDaysSince } from '../../lib/carrierAcks.js';

/**
 * The carrier's answer to an 834, read: TA1 (the interchange) and 999 (the
 * group and each transaction set), with the delimiters the ISA declares,
 * every code in plain words, and the member an error's segment points at.
 */

/** A carrier's ISA back to us: sender BCBSTX, receiver ALTOHR, its own control number. */
const isa = (ctl: number, el = '*', comp = ':', term = '~') =>
  ['ISA', '00', ' '.repeat(10), '00', ' '.repeat(10), 'ZZ', 'BCBSTX'.padEnd(15), 'ZZ', 'ALTOHR'.padEnd(15), '261016', '0930', '^', '00501', String(ctl).padStart(9, '0'), '0', 'T', comp].join(el) + term;

const ack999 = (groupControl: number, body: string[], ak9: string, ctl = 901) =>
  [
    isa(ctl),
    `GS*FA*BCBSTX*ALTOHR*20261016*0930*${ctl}*X*005010X231A1~`,
    'ST*999*0001*005010X231A1~',
    `AK1*BE*${groupControl}*005010X220A1~`,
    ...body,
    `${ak9}~`,
    `SE*${body.length + 4}*0001~`,
    `GE*1*${ctl}~`,
    `IEA*1*${String(ctl).padStart(9, '0')}~`,
  ].join('\n');

describe('999 implementation acknowledgments', () => {
  it('accepted: AK1 names our group control number, every set A', () => {
    const r = parseAcknowledgments(ack999(12, ['AK2*834*0001*005010X220A1~', 'IK5*A~'], 'AK9*A*1*1*1'));
    expect(r.sender).toEqual({ qualifier: 'ZZ', id: 'BCBSTX' });
    expect(r.acks).toHaveLength(1);
    expect(r.acks[0]).toMatchObject({ kind: '999', controlRaw: '12', controlNumber: 12, status: 'ACCEPTED', code: 'A', groupId: 'BE', counts: { included: 1, received: 1, accepted: 1 }, errors: [] });
    expect(r.acks[0]!.sets).toEqual([{ setId: '834', control: '0001', code: 'A', status: 'ACCEPTED', errors: [] }]);
  });

  it('accepted with errors: the element error replaces “segment has data element errors”, in words, with the bad value', () => {
    const r = parseAcknowledgments(ack999(12, ['AK2*834*0001*005010X220A1~', 'IK3*DMG*14*2100A*8~', 'IK4*2*1251*8*20261340~', 'IK5*E~'], 'AK9*E*1*1*1'));
    const a = r.acks[0]!;
    expect(a.status).toBe('ACCEPTED_WITH_ERRORS');
    expect(a.errors).toEqual([
      {
        code: 'IK4:8',
        message: 'The birth date (DMG02) at segment 14 isn’t a valid date (sent “20261340”).',
        setControl: '0001',
        segment: 'DMG',
        position: 14,
        loop: '2100A',
        element: 'DMG02',
        badValue: '20261340',
      },
    ]);
  });

  it('rejected: segment and set errors; an SSN echoed in IK404 is never shown; “one or more segments” is not repeated', () => {
    const r = parseAcknowledgments(
      ack999(13, ['AK2*834*0001*005010X220A1~', 'IK3*NM1*12*2100A*8~', 'IK4*9*67*6*12345678A~', 'IK4*9*67*4*123456789~', 'IK3*HD*20*2300*7~', 'IK5*R*5~'], 'AK9*R*1*1*0'),
    );
    const a = r.acks[0]!;
    expect(a).toMatchObject({ controlNumber: 13, status: 'REJECTED', code: 'R', counts: { included: 1, received: 1, accepted: 0 } });
    expect(a.errors.map((e) => e.message)).toEqual([
      'The member ID (SSN) (NM109) at segment 12 has a character that isn’t allowed (sent “12345678A”).',
      'The member ID (SSN) (NM109) at segment 12 is too short.',
      'The coverage segment (HD) at segment 20 in loop 2300 is out of order.',
    ]);
    expect(JSON.stringify(a)).not.toContain('123456789');
    expect(a.sets[0]!.status).toBe('REJECTED');
  });

  it('a set rejected for its envelope says why, and an unknown code is shown as the code', () => {
    const r = parseAcknowledgments(ack999(14, ['AK2*834*0001*005010X220A1~', 'IK5*R*4*99~'], 'AK9*R*1*1*0*4'));
    expect(r.acks[0]!.errors.map((e) => [e.code, e.message])).toEqual([
      ['AK9:4', 'The group’s opening and closing control numbers (GS06, GE02) don’t match.'],
      ['IK5:4', 'The file’s segment count (SE01) doesn’t match the segments sent.'],
      ['IK5:99', 'Transaction set error code 99.'],
    ]);
  });

  it('partly accepted (AK9 P), and no AK9 at all reads the result from the sets', () => {
    const p = parseAcknowledgments(ack999(15, ['AK2*834*0001~', 'IK5*A~', 'AK2*834*0002~', 'IK3*INS*9*2000*3~', 'IK5*R~'], 'AK9*P*2*2*1'));
    expect(p.acks[0]!.status).toBe('PARTIAL');
    expect(p.acks[0]!.errors).toEqual([expect.objectContaining({ code: 'IK3:3', setControl: '0002', message: 'The member segment (INS) at segment 9 in loop 2000 is required and missing.' })]);
    const noAk9 = parseAcknowledgments(ack999(16, ['AK2*834*0001~', 'IK5*E~'], 'IK5*E').replace('IK5*E~\nSE', 'SE'));
    expect(noAk9.acks[0]).toMatchObject({ status: 'ACCEPTED_WITH_ERRORS', code: 'E' });
  });

  it('the older 997 (AK3 / AK4 / AK5) reads the same way', () => {
    const text = [isa(77), 'GS*FA*BCBSTX*ALTOHR*20261016*0930*77*X*004010~', 'ST*997*0001~', 'AK1*BE*21~', 'AK2*834*0001~', 'AK3*N4*18*2100A*8~', 'AK4*3*116*7*7870~', 'AK5*R*5~', 'AK9*R*1*1*0~', 'SE*8*0001~', 'GE*1*77~', 'IEA*1*000000077~'].join('');
    const a = parseAcknowledgments(text).acks[0]!;
    expect(a).toMatchObject({ kind: '997', controlNumber: 21, status: 'REJECTED' });
    expect(a.errors[0]!.message).toBe('The ZIP code (N403) at segment 18 has a code the carrier doesn’t accept (sent “7870”).');
  });
});

describe('TA1 interchange acknowledgments', () => {
  it('rejected: the note code in words; accepted: no errors', () => {
    const rej = parseAcknowledgments(`${isa(902)}TA1*000000012*261016*0930*R*006~IEA*0*000000902~`);
    expect(rej.acks).toEqual([{ kind: 'TA1', controlRaw: '000000012', controlNumber: 12, status: 'REJECTED', code: 'R', note: { code: '006', message: 'The sender ID (ISA06) isn’t valid.' }, sets: [], errors: [{ code: 'TA1:006', message: 'The sender ID (ISA06) isn’t valid.' }] }]);
    const ok = parseAcknowledgments(`${isa(903)}TA1*000000012*261016*0930*A*000~IEA*0*000000903~`);
    expect(ok.acks[0]).toMatchObject({ status: 'ACCEPTED', errors: [] });
    const withErrors = parseAcknowledgments(`${isa(904)}TA1*000000012*261016*0930*E*025~IEA*0*000000904~`);
    expect(withErrors.acks[0]).toMatchObject({ status: 'ACCEPTED_WITH_ERRORS', errors: [{ code: 'TA1:025', message: 'The carrier already received a file with this interchange control number.' }] });
  });

  it('a TA1 and a 999 in one interchange, and one 999 per group: each answer on its own', () => {
    const text = [
      isa(905),
      'TA1*000000030*261016*0930*A*000~',
      'GS*FA*BCBSTX*ALTOHR*20261016*0930*905*X*005010X231A1~',
      'ST*999*0001*005010X231A1~AK1*BE*30*005010X220A1~AK2*834*0001~IK5*A~AK9*A*1*1*1~SE*6*0001~',
      'ST*999*0002*005010X231A1~AK1*BE*31*005010X220A1~AK2*834*0001~IK5*R*1~AK9*R*1*1*0~SE*6*0002~',
      'GE*2*905~IEA*1*000000905~',
    ].join('\r\n');
    const r = parseAcknowledgments(text);
    expect(r.acks.map((a) => [a.kind, a.controlNumber, a.status])).toEqual([
      ['TA1', 30, 'ACCEPTED'],
      ['999', 30, 'ACCEPTED'],
      ['999', 31, 'REJECTED'],
    ]);
    expect(r.acks[2]!.errors[0]!.message).toBe('The carrier doesn’t accept this kind of file.');
  });
});

describe('delimiters from the ISA', () => {
  it('reads “|” elements, “>” components and one segment a line (CRLF)', () => {
    const text = [isa(906, '|', '>', '\r\n'), 'GS|FA|BCBSTX|ALTOHR|20261016|0930|906|X|005010X231A1', 'ST|999|0001|005010X231A1', 'AK1|BE|40|005010X220A1', 'AK2|834|0001', 'IK3|HD|22|2300|8', 'IK4|5>1|1371|7|ZZZ', 'IK5|E', 'AK9|E|1|1|1', 'SE|8|0001', 'GE|1|906', 'IEA|1|000000906', ''].join('\r\n');
    const a = parseAcknowledgments(`\uFEFF${text}`).acks[0]!;
    expect(a).toMatchObject({ controlNumber: 40, status: 'ACCEPTED_WITH_ERRORS' });
    expect(a.errors[0]).toMatchObject({ element: 'HD05-1', badValue: 'ZZZ' });
  });

  it('a file without an envelope falls back to * and ~', () => {
    const r = parseAcknowledgments('ST*999*0001~AK1*BE*41~AK2*834*0001~IK5*A~AK9*A*1*1*1~SE*6*0001~');
    expect(r).toMatchObject({ sender: null, acks: [{ controlNumber: 41, status: 'ACCEPTED' }] });
  });

  it('says plainly what isn’t an answer: an 834 sent back, an empty file, another kind of file', () => {
    expect(() => parseAcknowledgments(`${isa(907)}GS*BE*X*Y*20261016*0930*1*X*005010X220A1~ST*834*0001*005010X220A1~SE*2*0001~`)).toThrow(/This is an enrollment file \(834\), not the carrier’s answer/);
    expect(() => parseAcknowledgments('  \n')).toThrow(AckParseError);
    expect(() => parseAcknowledgments('ST*277*0001~SE*2*0001~')).toThrow(/holds a 277, not a 999 or TA1/);
    expect(() => parseAcknowledgments('hello')).toThrow(/No 999 or TA1/);
    expect(() => parseAcknowledgments(`${isa(908)}TA1*000000012*261016*0930*Q*000~`)).toThrow(/expected A, E or R/);
  });
});

describe('naming the member an error points at', () => {
  const member = (o: Partial<Edi834Member>): Edi834Member => ({
    subscriber: true,
    relationship: '18',
    maintenance: '030',
    reason: 'XN',
    employmentStatus: 'FT',
    subscriberId: '111223333',
    lastName: 'Lee',
    firstName: 'Ann',
    ssn: '111223333',
    dob: '1985-03-04',
    gender: 'U',
    phone: null,
    address: { line1: '5 Elm St', line2: null, city: 'Austin', state: 'TX', zip: '78701' },
    hireDate: '2024-01-10',
    coverages: [{ maintenance: '030', insuranceLine: 'HLT', planCode: 'PPO500', coverageLevel: 'E1D', begin: '2026-01-01', end: null }],
    ...o,
  });
  const built = build834(
    { senderQualifier: 'ZZ', senderId: 'ALTOHR', receiverQualifier: 'ZZ', receiverId: 'BCBSTX', usage: 'T', controlNumber: 12, createdAt: new Date('2026-10-15T12:00:00Z') },
    { mode: 'FULL', referenceId: 'x-12', policyNumber: 'GRP-1', effectiveDate: '2026-10-15', sponsorName: 'Alto', sponsorTaxId: null, carrierName: 'Blue Cross' },
    [member({}), member({ subscriber: false, relationship: '19', firstName: "D'ANDRE", lastName: 'Lee', ssn: null, employmentStatus: null, address: null, hireDate: null, dob: '2015-06-01' })],
  ).content;
  const segs = segmentsOf(built);
  const st = segs.findIndex((s) => s[0] === 'ST');
  const positionOf = (pred: (s: string[]) => boolean, nth = 0) => segs.map((s, i) => (pred(s) ? i : -1)).filter((i) => i >= 0)[nth]! - st + 1;

  it('the segment’s INS loop and its NM1*IL name; a dependent says so', () => {
    const annDmg = positionOf((s) => s[0] === 'DMG', 0);
    const kidDmg = positionOf((s) => s[0] === 'DMG', 1);
    expect(memberAt(built, { code: 'IK4:8', setControl: '0001', position: annDmg, segment: 'DMG' })).toBe('Ann Lee');
    expect(memberAt(built, { code: 'IK4:8', setControl: '0001', position: kidDmg, segment: 'DMG' })).toBe("D'Andre Lee (dependent)");
    // The coverage line under the subscriber: still Ann.
    expect(memberAt(built, { code: 'IK3:7', setControl: '0001', position: positionOf((s) => s[0] === 'HD', 0), segment: 'HD' })).toBe('Ann Lee');
  });

  it('no one for a header segment, a pointer past the file, or a segment ID that isn’t there', () => {
    expect(memberAt(built, { code: 'IK3:8', setControl: '0001', position: 2, segment: 'BGN' })).toBeNull();
    expect(memberAt(built, { code: 'IK3:8', setControl: '0001', position: 999, segment: 'DMG' })).toBeNull();
    expect(memberAt(built, { code: 'IK3:8', setControl: '0001', position: positionOf((s) => s[0] === 'DMG', 0), segment: 'HD' })).toBeNull();
    // A missing segment points where it should have been.
    expect(memberAt(built, { code: 'IK3:3', setControl: '0001', position: positionOf((s) => s[0] === 'DMG', 0), segment: 'PER' })).toBe('Ann Lee');
  });
});

describe('where a file stands with the carrier', () => {
  const NOW = new Date('2026-10-23T15:00:00Z'); // a Friday
  it('business days since: weekends and federal holidays skipped', () => {
    expect(businessDaysSince(new Date('2026-10-19T18:00:00Z'), NOW)).toBe(4); // Mon → Tue..Fri
    expect(businessDaysSince(new Date('2026-10-23T08:00:00Z'), NOW)).toBe(0);
    expect(businessDaysSince(new Date('2026-10-16T18:00:00Z'), new Date('2026-10-19T09:00:00Z'))).toBe(1); // Fri → Mon
    expect(businessDaysSince(new Date('2026-10-09T12:00:00Z'), new Date('2026-10-13T12:00:00Z'))).toBe(1); // Columbus Day skipped
  });

  it('answered, waiting (overdue after 3 business days), or no answer expected — and why', () => {
    const f = (o: Partial<{ status: string; sentAt: Date | null; createdAt: Date; ackStatus: string | null }>) => ({ status: 'SENT', sentAt: new Date('2026-10-19T18:00:00Z'), createdAt: new Date('2026-10-19T17:00:00Z'), ackStatus: null, ...o });
    expect(answerFor(f({ ackStatus: 'REJECTED' }), { transport: 'SFTP' }, true, NOW)).toEqual({ state: 'REJECTED' });
    expect(answerFor(f({}), { transport: 'SFTP' }, false, NOW)).toEqual({ state: 'WAITING', waitingDays: 4, overdue: true });
    expect(answerFor(f({ sentAt: new Date('2026-10-21T18:00:00Z') }), { transport: 'HTTPS' }, false, NOW)).toEqual({ state: 'WAITING', waitingDays: 2, overdue: false });
    expect(answerFor(f({ status: 'GENERATED', sentAt: null }), { transport: 'SFTP' }, true, NOW)).toEqual({ state: 'NOT_EXPECTED', why: 'Not sent yet.' });
    expect(answerFor(f({ status: 'FAILED', sentAt: null }), { transport: 'SFTP' }, true, NOW)).toEqual({ state: 'NOT_EXPECTED', why: 'The file wasn’t delivered.' });
    // Download carriers: no answer expected here until the carrier has answered here once.
    expect(answerFor(f({ status: 'GENERATED', sentAt: null }), { transport: 'DOWNLOAD' }, false, NOW).state).toBe('NOT_EXPECTED');
    expect(answerFor(f({ status: 'GENERATED', sentAt: null }), { transport: 'DOWNLOAD' }, true, NOW)).toEqual({ state: 'WAITING', waitingDays: 4, overdue: false });
  });
});
