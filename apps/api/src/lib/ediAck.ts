/**
 * A carrier's answer to an 834 enrollment file, read from the X12 it sends
 * back. Two kinds:
 *
 *   TA1   the interchange acknowledgment: TA101 echoes the ISA13 control
 *         number of our file; TA104 is A (accepted), E (accepted with
 *         errors) or R (rejected); TA105 is the note code saying why.
 *   999   the implementation acknowledgment (005010X231A1):
 *           AK1  the functional group answered: AK102 = our GS06
 *           AK2  each transaction set answered: AK202 = our ST02
 *           IK3  a segment in error: its ID, its position counted from ST
 *                (ST = 1), its loop, and the error code
 *           IK4  an element in that segment: its position (element:
 *                component:repetition), the error code, a copy of the bad
 *                value
 *           IK5  the set's result: A, E, M, R, W or X, and up to five codes
 *           AK9  the group's result: A, E, P (partly), M, R, W or X, the
 *                set counts, and up to five group codes
 *         The older 997 (AK3 / AK4 / AK5) is read the same way.
 *
 * Delimiters come from the ISA itself: the element separator is the
 * character after "ISA", the component separator is ISA16 and the segment
 * terminator is the character after it. Line breaks between segments
 * (CR, LF, CRLF) are ignored, and a file without an ISA falls back to
 * "*" and "~" (or one segment a line). One file may carry several
 * acknowledgments — a TA1 and a 999, or one 999 per group — and each is
 * returned on its own, with the control number it answers.
 *
 * Every code is put in plain words here (X12 code lists 620, 621, 618,
 * 716, 717 and the interchange note codes I18). The carrier's companion
 * guide may add its own: an unknown code is shown as the code.
 */

export type AckKind = 'TA1' | '999' | '997';
export type AckStatus = 'ACCEPTED' | 'ACCEPTED_WITH_ERRORS' | 'REJECTED' | 'PARTIAL';

export interface AckError {
  /** What went wrong, in plain words (no member name; see `member`). */
  message: string;
  /** The X12 code behind it: 'IK3:8', 'IK4:7', 'IK5:4', 'AK9:5', 'TA1:006'. */
  code: string;
  /** The transaction set (ST02) the error is in. */
  setControl?: string;
  /** IK3: the segment, its position counted from ST (ST = 1), its loop. */
  segment?: string;
  position?: number;
  loop?: string;
  /** IK4: the element, e.g. 'DMG02', 'N403', 'HD05'. */
  element?: string;
  /** IK4's copy of the bad value, when it is safe to show (never anything shaped like an SSN). */
  badValue?: string;
  /** The member the segment sits under, filled in when the file it answers is ours. */
  member?: string;
}

export interface ParsedSetAck {
  /** AK201: the transaction set answered ('834'). */
  setId: string;
  /** AK202: its control number (our ST02). */
  control: string;
  /** IK501 as sent. */
  code: string;
  status: AckStatus;
  errors: AckError[];
}

export interface ParsedAck {
  kind: AckKind;
  /** The control number answered, as sent: TA101 (our ISA13) or AK102 (our GS06). */
  controlRaw: string;
  /** The same as a number; null when it isn't one. */
  controlNumber: number | null;
  status: AckStatus;
  /** The result code as sent: TA104, or AK901 (derived from the sets when AK9 is missing). */
  code: string;
  /** TA1: TA105 and its words. */
  note?: { code: string; message: string };
  /** 999: AK101, the group answered ('BE' for an 834). */
  groupId?: string;
  /** 999: AK9's counts, when sent. */
  counts?: { included: number; received: number; accepted: number };
  sets: ParsedSetAck[];
  /** Every error in the acknowledgment: the group's, then each set's. */
  errors: AckError[];
}

export interface ParsedAckFile {
  /** The acknowledgment's own envelope (who sent it), when it has one. */
  sender: { qualifier: string; id: string } | null;
  receiver: { qualifier: string; id: string } | null;
  acks: ParsedAck[];
}

export class AckParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AckParseError';
  }
}

/* ----- the code lists, in words -------------------------------------------- */

/** TA104. */
const TA1_STATUS: Record<string, AckStatus> = { A: 'ACCEPTED', E: 'ACCEPTED_WITH_ERRORS', R: 'REJECTED' };

/** TA105 interchange note codes (X12 I18). */
export const TA1_NOTES: Record<string, string> = {
  '000': 'No error.',
  '001': 'The interchange control numbers in the header (ISA) and trailer (IEA) don’t match.',
  '002': 'The carrier doesn’t support this standard (ISA11).',
  '003': 'The carrier doesn’t support this version of the envelope (ISA12).',
  '004': 'The segment terminator isn’t valid.',
  '005': 'The sender ID type (ISA05) isn’t valid.',
  '006': 'The sender ID (ISA06) isn’t valid.',
  '007': 'The receiver ID type (ISA07) isn’t valid.',
  '008': 'The receiver ID (ISA08) isn’t valid.',
  '009': 'The carrier doesn’t know the receiver ID (ISA08).',
  '010': 'The authorization qualifier (ISA01) isn’t valid.',
  '011': 'The authorization information (ISA02) isn’t valid.',
  '012': 'The security qualifier (ISA03) isn’t valid.',
  '013': 'The security information (ISA04) isn’t valid.',
  '014': 'The interchange date (ISA09) isn’t valid.',
  '015': 'The interchange time (ISA10) isn’t valid.',
  '016': 'The standards identifier (ISA11) isn’t valid.',
  '017': 'The version (ISA12) isn’t valid.',
  '018': 'The interchange control number (ISA13) isn’t valid.',
  '019': 'The acknowledgment-requested flag (ISA14) isn’t valid.',
  '020': 'The test or production flag (ISA15) isn’t valid.',
  '021': 'The number of groups in the trailer (IEA01) doesn’t match.',
  '022': 'The file’s structure isn’t valid.',
  '023': 'The file ended early.',
  '024': 'The content isn’t valid (for example, a bad GS segment).',
  '025': 'The carrier already received a file with this interchange control number.',
  '026': 'The element separator isn’t valid.',
  '027': 'The component separator (ISA16) isn’t valid.',
  '028': 'The deferred delivery date isn’t valid.',
  '029': 'The deferred delivery time isn’t valid.',
  '030': 'The deferred delivery time code isn’t valid.',
  '031': 'The grade of service isn’t valid.',
};

/** IK501 / AK501 (X12 717). */
const SET_STATUS: Record<string, AckStatus> = { A: 'ACCEPTED', E: 'ACCEPTED_WITH_ERRORS', M: 'REJECTED', R: 'REJECTED', W: 'REJECTED', X: 'REJECTED' };
/** AK901 (X12 715). */
const GROUP_STATUS: Record<string, AckStatus> = { ...SET_STATUS, P: 'PARTIAL' };

/** IK304 / AK304 segment errors (X12 620): finishes "The <segment> …". */
const SEGMENT_ERRORS: Record<string, string> = {
  '1': 'isn’t a segment the carrier recognizes',
  '2': 'isn’t expected here',
  '3': 'is required and missing',
  '4': 'loop repeats more times than allowed',
  '5': 'appears more times than allowed',
  '6': 'isn’t part of this kind of file',
  '7': 'is out of order',
  '8': 'has errors in its fields',
  I4: 'is sent but the carrier’s guide says not to send it',
  I6: 'is required in this situation and missing',
  I7: 'loop appears fewer times than required',
  I8: 'appears fewer times than required',
  I9: 'is sent but isn’t used in this situation',
};

/** IK403 / AK403 element errors (X12 621): finishes "The <element> …". */
const ELEMENT_ERRORS: Record<string, string> = {
  '1': 'is required and missing',
  '2': 'is required here (because of another field) and missing',
  '3': 'has too many fields after it',
  '4': 'is too short',
  '5': 'is too long',
  '6': 'has a character that isn’t allowed',
  '7': 'has a code the carrier doesn’t accept',
  '8': 'isn’t a valid date',
  '9': 'isn’t a valid time',
  '10': 'can’t be sent together with another field',
  '12': 'repeats more times than allowed',
  '13': 'has too many parts',
  I6: 'has a code the carrier’s guide doesn’t use',
  I9: 'is required in this situation and missing',
  I10: 'is filled in but the carrier’s guide says not to send it',
  I11: 'repeats fewer times than required',
  I12: 'doesn’t match the format the carrier’s guide requires',
  I13: 'is filled in but isn’t used in this situation',
};

/** IK502–506 / AK502–506 transaction set errors (X12 618). */
const SET_ERRORS: Record<string, string> = {
  '1': 'The carrier doesn’t accept this kind of file.',
  '2': 'The file is missing its closing segment (SE).',
  '3': 'The file’s opening and closing control numbers (ST02, SE02) don’t match.',
  '4': 'The file’s segment count (SE01) doesn’t match the segments sent.',
  '5': 'One or more segments have errors.',
  '6': 'The file type (ST01) is missing or not valid.',
  '7': 'The file’s control number (ST02) is missing or not valid.',
  '18': 'The file isn’t inside a group (GS/GE).',
  '19': 'The carrier doesn’t accept this version of the enrollment format (ST03).',
  '23': 'The file’s control number (ST02) is used twice in the group.',
  I5: 'One or more segments have errors.',
  I6: 'The carrier doesn’t support this implementation guide.',
};
const SET_SECURITY = new Set(['8', '9', '10', '11', '12', '13', '15', '16', '17', '24', '25', '26', '27']);

/** AK905–909 functional group errors (X12 716). */
const GROUP_ERRORS: Record<string, string> = {
  '1': 'The carrier doesn’t accept this kind of group.',
  '2': 'The carrier doesn’t accept this version of the group (GS08).',
  '3': 'The group is missing its closing segment (GE).',
  '4': 'The group’s opening and closing control numbers (GS06, GE02) don’t match.',
  '5': 'The group’s count of files (GE01) doesn’t match what was sent.',
  '6': 'The group control number (GS06) isn’t valid.',
  '19': 'The group control number (GS06) is used twice in the interchange.',
};
const GROUP_SECURITY = new Set(['10', '11', '12', '13', '14', '15', '16', '17', '18', '23', '24', '25', '26']);

/** What each segment of an 834 is, for the words. */
const SEGMENT_NAMES: Record<string, string> = {
  BGN: 'file header',
  REF: 'reference',
  DTP: 'date',
  QTY: 'totals',
  N1: 'sponsor or carrier name',
  INS: 'member',
  NM1: 'member name',
  PER: 'member phone',
  N3: 'member address',
  N4: 'member city, state and ZIP',
  DMG: 'member birth date and gender',
  HD: 'coverage',
  SE: 'file trailer',
  ST: 'file header',
};

/** What each element of an 834 is (segment + two-digit position). */
const ELEMENT_NAMES: Record<string, string> = {
  BGN01: 'purpose code',
  BGN02: 'reference ID',
  BGN03: 'file date',
  BGN04: 'file time',
  BGN08: 'action code (full or change)',
  REF01: 'reference type',
  REF02: 'reference number',
  DTP01: 'date type',
  DTP02: 'date format',
  DTP03: 'date',
  QTY01: 'total type',
  QTY02: 'total',
  N101: 'name type',
  N102: 'name',
  N103: 'ID type',
  N104: 'tax ID',
  INS01: 'subscriber flag',
  INS02: 'relationship',
  INS03: 'change type',
  INS04: 'reason for the change',
  INS05: 'benefit status',
  INS08: 'employment status',
  NM101: 'name type',
  NM102: 'person or company flag',
  NM103: 'last name',
  NM104: 'first name',
  NM108: 'ID type',
  NM109: 'member ID (SSN)',
  PER01: 'contact type',
  PER03: 'phone type',
  PER04: 'phone number',
  N301: 'address',
  N302: 'address line 2',
  N401: 'city',
  N402: 'state',
  N403: 'ZIP code',
  DMG01: 'date format',
  DMG02: 'birth date',
  DMG03: 'gender',
  HD01: 'change type',
  HD03: 'insurance line',
  HD04: 'plan code',
  HD05: 'coverage level',
  SE01: 'segment count',
  SE02: 'control number',
};

const segmentLabel = (id: string): string => (SEGMENT_NAMES[id] ? `${SEGMENT_NAMES[id]} segment (${id})` : `${id} segment`);
const elementLabel = (ref: string): string => (ELEMENT_NAMES[ref] ? `${ELEMENT_NAMES[ref]} (${ref})` : ref);

/** An IK404 copy, unless it could be an identifier (a run of nine or more digits: an SSN, a member ID). */
function safeBadValue(v: string | undefined): string | undefined {
  const s = (v ?? '').trim();
  if (!s || s.length > 40 || /\d{9,}/.test(s.replace(/[\s-]/g, ''))) return undefined;
  return s;
}

/* ----- splitting ------------------------------------------------------------ */

interface Delimiters {
  element: string;
  segment: string;
  component: string;
}

/** The delimiters an interchange declares in its ISA; defaults when there is no ISA. */
export function delimitersOf(text: string): Delimiters {
  const at = text.search(/ISA/);
  if (at < 0 || text.slice(0, at).trim() !== '') {
    return { element: '*', segment: text.includes('~') ? '~' : '\n', component: ':' };
  }
  const element = text[at + 3];
  if (!element || /[A-Za-z0-9\s]/.test(element)) throw new AckParseError('The ISA segment’s element separator isn’t valid.');
  // ISA has 16 elements: after the 16th separator comes ISA16 (one character), then the terminator.
  let pos = at + 3;
  for (let n = 1; n < 16; n += 1) {
    pos = text.indexOf(element, pos + 1);
    if (pos < 0) throw new AckParseError('The ISA segment is cut short.');
  }
  const component = text[pos + 1];
  const segment = text[pos + 2];
  if (!component || !segment) throw new AckParseError('The ISA segment is cut short.');
  return { element, segment, component };
}

/** Segments as arrays of elements, line breaks and blank segments dropped. */
export function splitSegments(text: string, d: Delimiters): string[][] {
  return text
    .split(d.segment)
    .map((s) => s.replace(/^[\s]+/, '').replace(/[\r\n]+$/, ''))
    .filter((s) => s.length > 0)
    .map((s) => s.split(d.element));
}

const int = (s: string | undefined): number | null => (s && /^\s*\d+\s*$/.test(s) ? Number(s.trim()) : null);
const el = (seg: string[], i: number): string => (seg[i] ?? '').trim();

/* ----- reading --------------------------------------------------------------- */

/**
 * Read every acknowledgment in a file. Throws AckParseError, in words, when
 * the file holds no TA1 and no 999/997 (an 834 sent back by mistake says so).
 */
export function parseAcknowledgments(raw: string): ParsedAckFile {
  const text = raw.replace(/^\uFEFF/, '');
  if (!text.trim()) throw new AckParseError('The file is empty.');
  const d = delimitersOf(text);
  const segments = splitSegments(text, d);

  let sender: ParsedAckFile['sender'] = null;
  let receiver: ParsedAckFile['receiver'] = null;
  const acks: ParsedAck[] = [];
  const otherSets = new Set<string>();

  let setKind: '999' | '997' | null = null;
  let group: (ParsedAck & { sawAk9: boolean }) | null = null;
  let set: ParsedSetAck | null = null;
  let lastSegError: AckError | null = null;
  let lastSegErrorHasElements = false;

  const closeSet = () => {
    set = null;
    lastSegError = null;
    lastSegErrorHasElements = false;
  };

  for (const seg of segments) {
    const id = el(seg, 0).toUpperCase();
    switch (id) {
      case 'ISA':
        sender = { qualifier: el(seg, 5), id: el(seg, 6) };
        receiver = { qualifier: el(seg, 7), id: el(seg, 8) };
        break;
      case 'TA1': {
        const code = el(seg, 4).toUpperCase();
        const status = TA1_STATUS[code];
        if (!status) throw new AckParseError(`The TA1’s result (TA104) is “${code}”; expected A, E or R.`);
        const noteCode = el(seg, 5);
        const noteWords = noteCode ? (TA1_NOTES[noteCode] ?? `Interchange note code ${noteCode}.`) : '';
        acks.push({
          kind: 'TA1',
          controlRaw: el(seg, 1),
          controlNumber: int(seg[1]),
          status,
          code,
          ...(noteCode ? { note: { code: noteCode, message: noteWords } } : {}),
          sets: [],
          errors: noteCode && noteCode !== '000' ? [{ code: `TA1:${noteCode}`, message: noteWords }] : [],
        });
        break;
      }
      case 'ST': {
        const kind = el(seg, 1);
        if (kind === '999' || kind === '997') setKind = kind;
        else {
          setKind = null;
          if (kind) otherSets.add(kind);
        }
        group = null;
        closeSet();
        break;
      }
      case 'AK1': {
        if (!setKind) break;
        group = { kind: setKind, controlRaw: el(seg, 2), controlNumber: int(seg[2]), groupId: el(seg, 1), status: 'ACCEPTED', code: '', sets: [], errors: [], sawAk9: false };
        acks.push(group);
        closeSet();
        break;
      }
      case 'AK2': {
        if (!group) break;
        set = { setId: el(seg, 1), control: el(seg, 2), code: '', status: 'ACCEPTED', errors: [] };
        group.sets.push(set);
        lastSegError = null;
        break;
      }
      case 'IK3':
      case 'AK3': {
        if (!set) break;
        const segmentId = el(seg, 1).toUpperCase();
        const position = int(seg[2]);
        const loop = el(seg, 3);
        const code = el(seg, 4);
        const words = SEGMENT_ERRORS[code] ?? `has an error (code ${code || 'not given'})`;
        lastSegError = {
          code: `IK3:${code}`,
          message: `The ${segmentLabel(segmentId)}${position ? ` at segment ${position}` : ''}${loop ? ` in loop ${loop}` : ''} ${words}.`,
          setControl: set.control,
          segment: segmentId,
          ...(position ? { position } : {}),
          ...(loop ? { loop } : {}),
        };
        lastSegErrorHasElements = false;
        set.errors.push(lastSegError);
        break;
      }
      case 'IK4':
      case 'AK4': {
        if (!set) break;
        const [elementPos, componentPos] = el(seg, 1).split(d.component);
        const n = int(elementPos);
        const code = el(seg, 3);
        const segmentId = lastSegError?.segment ?? '';
        const ref = segmentId && n ? `${segmentId}${String(n).padStart(2, '0')}${componentPos ? `-${componentPos}` : ''}` : el(seg, 2) ? `data element ${el(seg, 2)}` : 'a field';
        const words = ELEMENT_ERRORS[code] ?? `has an error (code ${code || 'not given'})`;
        const bad = safeBadValue(seg[4]);
        const where = lastSegError?.position ? ` at segment ${lastSegError.position}` : '';
        const error: AckError = {
          code: `IK4:${code}`,
          message: `The ${elementLabel(ref)}${where} ${words}${bad ? ` (sent “${bad}”)` : ''}.`,
          setControl: set.control,
          ...(segmentId ? { segment: segmentId } : {}),
          ...(lastSegError?.position ? { position: lastSegError.position } : {}),
          ...(lastSegError?.loop ? { loop: lastSegError.loop } : {}),
          element: ref,
          ...(bad ? { badValue: bad } : {}),
        };
        // "Segment has data element errors" says nothing the element errors don't: replace it.
        if (lastSegError && lastSegError.code === 'IK3:8' && !lastSegErrorHasElements) {
          const i = set.errors.indexOf(lastSegError);
          if (i >= 0) set.errors.splice(i, 1);
        }
        lastSegErrorHasElements = true;
        set.errors.push(error);
        break;
      }
      case 'IK5':
      case 'AK5': {
        if (!set) break;
        const code = el(seg, 1).toUpperCase();
        set.code = code;
        set.status = SET_STATUS[code] ?? 'REJECTED';
        const hasSegmentErrors = set.errors.some((e) => e.code.startsWith('IK3') || e.code.startsWith('IK4'));
        for (const c of seg.slice(2, 7).map((x) => x.trim()).filter(Boolean)) {
          if ((c === '5' || c === 'I5') && hasSegmentErrors) continue;
          const message = SET_ERRORS[c] ?? (SET_SECURITY.has(c) ? `The carrier couldn’t verify or decrypt the file (code ${c}).` : `Transaction set error code ${c}.`);
          set.errors.push({ code: `IK5:${c}`, message, setControl: set.control });
        }
        closeSet();
        break;
      }
      case 'AK9': {
        if (!group) break;
        const code = el(seg, 1).toUpperCase();
        group.code = code;
        group.status = GROUP_STATUS[code] ?? 'REJECTED';
        group.sawAk9 = true;
        const included = int(seg[2]);
        const received = int(seg[3]);
        const accepted = int(seg[4]);
        if (included !== null && received !== null && accepted !== null) group.counts = { included, received, accepted };
        for (const c of seg.slice(5, 10).map((x) => x.trim()).filter(Boolean)) {
          const message = GROUP_ERRORS[c] ?? (GROUP_SECURITY.has(c) ? `The carrier couldn’t verify or decrypt the group (code ${c}).` : `Functional group error code ${c}.`);
          group.errors.push({ code: `AK9:${c}`, message });
        }
        break;
      }
      case 'SE':
        group = null;
        closeSet();
        setKind = null;
        break;
      default:
        break;
    }
  }

  if (!acks.length) {
    if (otherSets.has('834')) throw new AckParseError('This is an enrollment file (834), not the carrier’s answer to one. Upload the 999 or TA1 the carrier sent back.');
    if (otherSets.size) throw new AckParseError(`This file holds a ${[...otherSets].join(', ')}, not a 999 or TA1 acknowledgment.`);
    throw new AckParseError('No 999 or TA1 acknowledgment was found in this file.');
  }

  for (const a of acks as Array<ParsedAck & { sawAk9?: boolean }>) {
    if (a.kind !== 'TA1') {
      if (!a.sawAk9) {
        // No AK9: the group's result is what its sets say.
        const s = a.sets.map((x) => x.status);
        const rejected = s.filter((x) => x === 'REJECTED').length;
        a.status = !s.length ? 'ACCEPTED' : rejected === s.length ? 'REJECTED' : rejected ? 'PARTIAL' : s.includes('ACCEPTED_WITH_ERRORS') ? 'ACCEPTED_WITH_ERRORS' : 'ACCEPTED';
        a.code = { ACCEPTED: 'A', ACCEPTED_WITH_ERRORS: 'E', PARTIAL: 'P', REJECTED: 'R' }[a.status];
      }
      a.errors = [...a.errors, ...a.sets.flatMap((x) => x.errors)];
      delete a.sawAk9;
    }
  }
  return { sender, receiver, acks };
}

/* ----- naming the member a segment points at -------------------------------- */

const title = (s: string) => s.toLowerCase().replace(/(^|[\s'-])([a-z])/g, (_m, p: string, c: string) => p + c.toUpperCase());

/**
 * The member an error's segment sits under, read from the 834 it answers:
 * the segment at `position` (ST = 1) of the transaction set `setControl`,
 * back to its INS loop, and that loop's NM1*IL name. Null for a header
 * segment, a position outside the file, or a segment ID that doesn't match
 * the one there (then the pointer isn't into this file, and no one is
 * named) — except for a missing segment, whose position is where it should
 * have been.
 */
export function memberAt(file834: string, error: Pick<AckError, 'setControl' | 'position' | 'segment' | 'code'>): string | null {
  const position = error.position;
  if (!position || position < 1) return null;
  let d: Delimiters;
  try {
    d = delimitersOf(file834);
  } catch {
    return null;
  }
  const segs = splitSegments(file834, d);
  const starts = segs.map((s, i) => (s[0] === 'ST' ? i : -1)).filter((i) => i >= 0);
  const st = starts.find((i) => !error.setControl || el(segs[i]!, 2) === error.setControl) ?? starts[0];
  if (st === undefined) return null;
  const at = st + position - 1;
  const target = segs[at];
  if (!target) return null;
  const missing = /^IK3:(3|I6|I7|I8)$/.test(error.code);
  if (error.segment && target[0] !== error.segment && !missing) return null;
  let ins = -1;
  for (let i = at; i > st; i -= 1) {
    const id = segs[i]![0];
    if (id === 'ST' || (id === 'SE' && i !== at)) break;
    if (id === 'INS') {
      ins = i;
      break;
    }
  }
  if (ins < 0) return null;
  for (let i = ins + 1; i < segs.length; i += 1) {
    const s = segs[i]!;
    if (s[0] === 'INS' || s[0] === 'SE') break;
    if (s[0] === 'NM1' && s[1] === 'IL') {
      const name = `${title(el(s, 4))} ${title(el(s, 3))}`.trim();
      if (!name) return null;
      return el(segs[ins]!, 1) === 'N' ? `${name} (dependent)` : name;
    }
  }
  return null;
}
