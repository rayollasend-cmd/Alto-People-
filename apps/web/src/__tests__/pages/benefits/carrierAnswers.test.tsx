import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderAs } from '../hrPack/harness';
import type { Carrier, CarrierAck, Edi834File } from '@/lib/deductionsApi';

const ded = vi.hoisted(() => ({ listCarriers: vi.fn(), list834: vi.fn(), listCarrierAcks: vi.fn(), uploadCarrierAck: vi.fn(), saveCarrierConnection: vi.fn(), updateCarrier: vi.fn() }));
vi.mock('@/lib/deductionsApi', async (orig) => ({ ...(await orig<typeof import('@/lib/deductionsApi')>()), ...ded }));

import { CarrierFeeds, ackResultWords, answerWords, pickupWords } from '@/pages/deductions/CarrierFeeds';

/**
 * Carrier answers on Carrier feeds: each file says where it stands with the
 * carrier (accepted, with errors, rejected, waiting n business days, no
 * answer expected), the errors in words with the member, the feed's latest
 * answer, an answer that matched no file, the upload, the SFTP answers
 * folder — and plainly when SFTP isn't installed.
 */

const carrier = (o: Partial<Carrier> = {}): Carrier => ({
  id: 'k1',
  name: 'Blue Cross Blue Shield of Texas',
  receiverId: 'BCBSTX834',
  receiverQualifier: 'ZZ',
  senderId: 'ALTOHR',
  senderQualifier: 'ZZ',
  sponsorTaxId: null,
  policyNumber: 'GRP-118204',
  usageIndicator: 'P',
  transport: 'SFTP',
  connection: { host: 'sftp.bcbstx.com', username: 'alto', remoteDir: '/inbound', inboundDir: '/outbound', baseUrl: null, hasSecret: true },
  active: true,
  plans: [{ id: 'p1', name: 'PPO 500', kind: 'HEALTH_MEDICAL', insuranceLineCode: 'HLT', carrierPlanCode: null }],
  lastFile: { createdAt: '2026-10-19T12:00:00.000Z', mode: 'CHANGE', status: 'SENT' },
  ackCheckedAt: '2026-10-23T14:00:00.000Z',
  ackCheckError: null,
  health: {
    people: 40,
    changesWaiting: 0,
    lastFile: { createdAt: '2026-10-19T12:00:00.000Z', mode: 'CHANGE', status: 'SENT', controlNumber: 14, memberCount: 3, sentAt: '2026-10-19T12:05:00.000Z', error: null, answer: { state: 'WAITING', waitingDays: 4, overdue: true } },
    lastAnswer: { kind: '999', status: 'REJECTED', receivedAt: '2026-10-16T09:00:00.000Z', controlNumber: 13, matched: true, errorCount: 3, source: 'SFTP' },
  },
  ...o,
});

const errors = [
  { code: 'IK4:8', message: 'The birth date (DMG02) at segment 24 isn’t a valid date (sent “19850230”).', member: 'Bo Ray', element: 'DMG02' },
  { code: 'IK4:7', message: 'The ZIP code (N403) at segment 22 has a code the carrier doesn’t accept.', member: 'Ann Lee', element: 'N403' },
  { code: 'IK3:7', message: 'The coverage segment (HD) at segment 30 in loop 2300 is out of order.', member: 'Cy Day (dependent)' },
];
const ack = (o: Partial<CarrierAck> = {}): CarrierAck => ({ id: 'a1', kind: '999', status: 'REJECTED', controlNumber: 13, receivedAt: '2026-10-16T09:00:00.000Z', source: 'SFTP', fileId: 'f13', file: { id: 'f13', controlNumber: 13, mode: 'CHANGE', createdAt: '2026-10-15T12:00:00.000Z' }, errorCount: 3, errors, ...o });
const file = (o: Partial<Edi834File>): Edi834File => ({ id: 'f', mode: 'CHANGE', controlNumber: 1, memberCount: 2, status: 'SENT', error: null, sentAt: '2026-10-15T12:00:00.000Z', createdAt: '2026-10-15T12:00:00.000Z', ...o });

beforeEach(() => {
  for (const f of Object.values(ded)) f.mockReset();
  ded.listCarriers.mockResolvedValue({ carriers: [carrier()], plans: [], sftpAvailable: true });
  ded.list834.mockResolvedValue({
    files: [
      file({ id: 'f14', controlNumber: 14, answer: { state: 'WAITING', waitingDays: 4, overdue: true }, ack: null }),
      file({ id: 'f13', controlNumber: 13, ackStatus: 'REJECTED', answer: { state: 'REJECTED' }, ack: ack() }),
      file({ id: 'f12', controlNumber: 12, ackStatus: 'ACCEPTED_WITH_ERRORS', answer: { state: 'ACCEPTED_WITH_ERRORS' }, ack: ack({ id: 'a12', status: 'ACCEPTED_WITH_ERRORS', errorCount: 1, errors: [errors[0]!] }) }),
      file({ id: 'f11', controlNumber: 11, ackStatus: 'ACCEPTED', answer: { state: 'ACCEPTED' }, ack: ack({ id: 'a11', kind: 'TA1', status: 'ACCEPTED', errorCount: 0, errors: [] }) }),
      file({ id: 'f10', controlNumber: 10, status: 'FAILED', sentAt: null, answer: { state: 'NOT_EXPECTED', why: 'The file wasn’t delivered.' }, ack: null }),
    ],
  });
  ded.listCarrierAcks.mockResolvedValue({ acks: [ack(), ack({ id: 'u1', kind: 'TA1', status: 'REJECTED', controlNumber: 4242, fileId: null, file: null, errorCount: 1, errors: [{ code: 'TA1:025', message: 'The carrier already received a file with this interchange control number.' }] })], truncated: false });
});

describe('<CarrierFeeds> carrier answers', () => {
  it('each file’s answer, the errors in words with the member, and the feed’s latest answer', async () => {
    const user = userEvent.setup();
    renderAs('FINANCE_ACCOUNTANT', <CarrierFeeds />, '/benefits/carriers');
    const strip = await screen.findByRole('group', { name: 'Feed health' });
    expect(within(strip).getByText('Carrier’s answer').parentElement).toHaveTextContent('Rejected');
    expect(within(strip).getByText('Carrier’s answer').parentElement).toHaveTextContent('999 · control 13');
    expect(within(strip).getByText('Delivery').parentElement).toHaveTextContent('Sent Oct 19, 2026 · no answer, 4 business days');
    expect(screen.getByText(/Answers are picked up from \/outbound · last looked/)).toBeInTheDocument();

    const log = await screen.findByRole('table', { name: 'Enrollment files' });
    await waitFor(() => expect(within(log).getAllByRole('row')).toHaveLength(6));
    const rows = within(log).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('Waiting for an answer');
    expect(rows[0]).toHaveTextContent('4 business days so far: more than 3, so it’s in the Inbox.');
    expect(rows[1]).toHaveTextContent('Rejected');
    expect(rows[1]).toHaveTextContent('Bo Ray: The birth date (DMG02) at segment 24 isn’t a valid date (sent “19850230”).');
    expect(rows[1]).toHaveTextContent('Ann Lee: The ZIP code (N403)');
    expect(rows[1]).not.toHaveTextContent('Cy Day');
    expect(rows[2]).toHaveTextContent('Accepted with errors (1)');
    expect(rows[3]).toHaveTextContent('Accepted');
    // A TA1 alone speaks for the envelope, and says so.
    expect(rows[3]).toHaveTextContent('From the envelope check (TA1); the carrier’s file check (999) hasn’t come.');
    expect(rows[2]).not.toHaveTextContent('envelope check');
    expect(rows[4]).toHaveTextContent('No answer expected');
    expect(rows[4]).toHaveTextContent('The file wasn’t delivered.');

    // An answer that matched no file is kept and says so.
    const answers = await screen.findByRole('table', { name: 'Carrier answers' });
    await waitFor(() => expect(answers).toHaveTextContent('Didn’t match a file we sent (control 4242)'));
    expect(answers).toHaveTextContent('Envelope check (TA1)');
    expect(answers).toHaveTextContent('The carrier already received a file with this interchange control number.');
    expect(screen.queryByText(/834/)).toBeNull();

    // All the errors, in a dialog.
    await user.click(within(rows[1]!).getByRole('button', { name: 'All 3 errors' }));
    const dialog = await screen.findByRole('dialog', { name: 'Errors in control 13' });
    expect(dialog).toHaveTextContent('Cy Day (dependent): The coverage segment (HD) at segment 30 in loop 2300 is out of order.');
  });

  it('“Upload acknowledgment”: pasted text, read and matched, said in words', async () => {
    ded.uploadCarrierAck.mockResolvedValue({ duplicate: false, acks: [ack({ id: 'n1', status: 'ACCEPTED', controlNumber: 14, file: { id: 'f14', controlNumber: 14, mode: 'CHANGE', createdAt: '2026-10-19T12:00:00.000Z' }, errorCount: 0, errors: [] }), ack({ id: 'n2', kind: 'TA1', status: 'REJECTED', controlNumber: 99, fileId: null, file: null, errorCount: 0, errors: [] })] });
    const user = userEvent.setup();
    renderAs('FINANCE_ACCOUNTANT', <CarrierFeeds />, '/benefits/carriers');
    await user.click(await screen.findByRole('button', { name: 'Upload acknowledgment' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Read the answer' })).toBeDisabled();
    await user.click(within(dialog).getByLabelText('Or paste the text'));
    await user.paste('ISA*00*~TA1*000000099*261016*0930*R*006~');
    await user.click(within(dialog).getByRole('button', { name: 'Read the answer' }));
    await waitFor(() => expect(ded.uploadCarrierAck).toHaveBeenCalledWith('k1', 'ISA*00*~TA1*000000099*261016*0930*R*006~'));
    expect(await within(dialog).findByText(/Control 14 · change file of Oct 19, 2026/)).toBeInTheDocument();
    expect(within(dialog).getByText('Didn’t match a file we sent (control 99)')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Done' })).toBeInTheDocument();
  });

  it('the answers folder is saved with the SFTP connection; SFTP not installed is said plainly', async () => {
    ded.listCarriers.mockResolvedValue({ carriers: [carrier({ connection: { ...carrier().connection, inboundDir: null } })], plans: [], sftpAvailable: false });
    ded.updateCarrier.mockResolvedValue({ carrier: carrier() });
    ded.saveCarrierConnection.mockResolvedValue({ connection: carrier().connection });
    const user = userEvent.setup();
    renderAs('FINANCE_ACCOUNTANT', <CarrierFeeds />, '/benefits/carriers');
    await user.click(await screen.findByRole('button', { name: 'Add the answers folder' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('SFTP isn’t installed on this server yet');
    await user.type(within(dialog).getByLabelText('Answers folder'), '/outbound/999');
    await user.click(within(dialog).getByRole('button', { name: 'Save carrier' }));
    await waitFor(() => expect(ded.saveCarrierConnection).toHaveBeenCalledWith('k1', expect.objectContaining({ inboundDir: '/outbound/999', host: 'sftp.bcbstx.com' })));
  });
});

describe('answer words', () => {
  it('every state of a file, and an answer that wasn’t one', () => {
    expect(answerWords({ state: 'ACCEPTED' })).toEqual({ label: 'Accepted', tone: 'good' });
    expect(answerWords({ state: 'ACCEPTED_WITH_ERRORS' }, 2)).toEqual({ label: 'Accepted with errors (2)', tone: 'warning' });
    expect(answerWords({ state: 'PARTIAL' }, 1).label).toBe('Partly accepted (1)');
    expect(answerWords({ state: 'REJECTED' })).toEqual({ label: 'Rejected', tone: 'alert' });
    expect(answerWords({ state: 'WAITING', waitingDays: 1, overdue: false })).toEqual({ label: 'Waiting for an answer', tone: 'info', hint: '1 business day so far.' });
    expect(answerWords({ state: 'WAITING', waitingDays: 0, overdue: false }).hint).toBe('Sent today.');
    expect(answerWords({ state: 'WAITING', waitingDays: 5, overdue: true }).tone).toBe('warning');
    expect(answerWords({ state: 'NOT_EXPECTED', why: 'Not sent yet.' })).toEqual({ label: 'No answer expected', tone: 'neutral', hint: 'Not sent yet.' });
    expect(ackResultWords({ status: 'UNREADABLE', errorCount: 1 }).label).toBe('Couldn’t read');
  });

  it('how answers arrive, per carrier', () => {
    const c = carrier();
    expect(pickupWords({ ...c, transport: 'DOWNLOAD' }, true).text).toBe('Upload the carrier’s answer (999 or TA1) when it sends one.');
    expect(pickupWords({ ...c, connection: { ...c.connection, inboundDir: null } }, true)).toMatchObject({ setUp: true });
    expect(pickupWords(c, false)).toEqual({ text: 'SFTP isn’t installed on this server, so answers can’t be picked up from /outbound. Upload them here instead.', warn: true, setUp: false });
    expect(pickupWords({ ...c, ackCheckError: 'Couldn’t read the carrier’s folder: auth failed' }, true)).toMatchObject({ warn: true, text: expect.stringMatching(/^The last look in \/outbound failed .*: Couldn’t read the carrier’s folder: auth failed$/) });
    expect(pickupWords({ ...c, ackCheckedAt: null }, true).text).toBe('Answers will be picked up from /outbound; the first look hasn’t run yet.');
  });
});
