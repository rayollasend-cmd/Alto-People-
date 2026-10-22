import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@/lib/i18n';
import { renderAs } from '../pages/hrPack/harness';

/**
 * The last floor screens in English (the decision queue, who isn't in yet,
 * text the crew, availability) and the managers' tabs of Open shifts now
 * speak Spanish when the app does — the strings come from t(), not JSX.
 */

const api = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), apiFetch: api.apiFetch }));
vi.mock('@/components/DecisionRoom', () => ({ DecisionRoom: () => null }));
const late = vi.hoisted(() => ({ getLateNow: vi.fn() }));
vi.mock('@/lib/attendanceInsightsApi', () => late);
const floor = vi.hoisted(() => ({ textCrew: vi.fn(), raiseFloorFlag: vi.fn(), coverShift: vi.fn() }));
vi.mock('@/lib/floorApi', () => floor);
const sched = vi.hoisted(() => ({
  listShifts: vi.fn(),
  getMyAvailability: vi.fn(),
  replaceMyAvailability: vi.fn(),
  listMyAvailabilityExceptions: vi.fn(),
  addAvailabilityException: vi.fn(),
  deleteAvailabilityException: vi.fn(),
}));
vi.mock('@/lib/schedulingApi', async (orig) => ({ ...(await orig<typeof import('@/lib/schedulingApi')>()), ...sched }));
vi.mock('@/lib/qualApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/qualApi')>()),
  listPendingClaims: vi.fn().mockResolvedValue({ claims: [] }),
  listQualifications: vi.fn().mockResolvedValue({ qualifications: [] }),
  listOpenShifts: vi.fn().mockResolvedValue({ shifts: [] }),
}));
vi.mock('@/lib/callOutsApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/callOutsApi')>()),
  listCallOuts: vi.fn().mockResolvedValue({ range: 'week', total: 0, covered: 0, looking: 0, uncovered: 0, late: 0, truncated: false, items: [] }),
}));

import { RoleDecisionQueue } from '@/components/RoleDecisionQueue';
import { NotInYetCard } from '@/components/attendance/NotInYetCard';
import { CrewTextDialog } from '@/components/floor/CrewTextDialog';
import { AvailabilityEditor } from '@/pages/scheduling/AvailabilityEditor';
import { MarketplaceHome } from '@/pages/marketplace/MarketplaceHome';

const inSpanish = (ui: React.ReactNode) => <I18nProvider>{ui}</I18nProvider>;

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.setItem('alto.lang', 'es');
});
afterEach(() => {
  window.localStorage.removeItem('alto.lang');
  document.documentElement.lang = 'en';
});

describe('floor screens in Spanish', () => {
  it('the decision queue says all-clear in Spanish', async () => {
    api.apiFetch.mockResolvedValue({ decisions: [] });
    renderAs('SHIFT_SUPERVISOR', inSpanish(<RoleDecisionQueue />));
    expect(await screen.findByText('No hay nada pendiente para ti.')).toBeInTheDocument();
    expect(screen.queryByText('Nothing needs you.')).not.toBeInTheDocument();
  });

  it('the decision queue titles and offers its item in Spanish', async () => {
    api.apiFetch.mockResolvedValue({
      decisions: [
        {
          key: 'time:pending', severity: 'high', label: '3 timesheets', detail: 'Waiting since Monday', stakes: 1200, ageDays: 2,
          linkUrl: '/time', claimedBy: null, claimedByMe: false, assigned: false, note: null, escalated: false, nextStep: null,
        },
      ],
    });
    renderAs('SHIFT_SUPERVISOR', inSpanish(<RoleDecisionQueue />));
    expect(await screen.findByText('Necesita tu decisión')).toBeInTheDocument();
    // The rows arrive through the shared decisions query (a tick after the heading).
    expect(await screen.findByRole('button', { name: 'Yo me encargo' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Ir a ello' })).toBeInTheDocument();
    expect(screen.getByText('esperando 2 d')).toBeInTheDocument();
  });

  it('who isn’t in yet reads in Spanish, lateness included', async () => {
    late.getLateNow.mockResolvedValue({
      graceMinutes: 5,
      noShowRiskMinutes: 30,
      canText: true,
      people: [
        {
          shiftId: 's1', associateId: 'a1', name: 'Ana Reyes', position: 'Housekeeper', clientId: 'c1', siteId: 'l1', siteName: 'Harbor Inn',
          startsAt: '2026-10-20T11:00:00.000Z', endsAt: '2026-10-20T19:00:00.000Z', timezone: 'America/New_York',
          minutesLate: 12, status: 'late', phone: '3055550101', textable: true, calledOutHow: null,
        },
      ],
    });
    renderAs('SHIFT_SUPERVISOR', inSpanish(<NotInYetCard canCover />));
    expect(await screen.findByText('Quién no ha llegado')).toBeInTheDocument();
    expect(screen.getByText('12 min tarde')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Llamar a Ana Reyes' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Escribir a los 1 con retraso/ })).toBeInTheDocument();
    expect(screen.getByText(/Tarde después de 5 minutos; busca reemplazo después de 30/)).toBeInTheDocument();
  });

  it('nobody late reads "Ya llegaron todos"', async () => {
    late.getLateNow.mockResolvedValue({ graceMinutes: 5, noShowRiskMinutes: 30, canText: false, people: [] });
    renderAs('SHIFT_SUPERVISOR', inSpanish(<NotInYetCard />));
    expect(await screen.findByText('Ya llegaron todos')).toBeInTheDocument();
  });

  it('text the crew: the dialog and its outcome toast are Spanish', async () => {
    floor.textCrew.mockResolvedValue({ sent: 2, failed: 0, optedOut: 1, noPhone: [], notConfigured: null });
    renderAs('SHIFT_SUPERVISOR', inSpanish(<CrewTextDialog open onOpenChange={() => {}} shiftIds={['s1', 's2', 's3']} label="Mañana" count={3} />));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Escribir al equipo')).toBeInTheDocument();
    expect(within(dialog).getByText(/Mañana · 3 personas\. Un SMS para cada uno/)).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText(/Mensaje/), 'Hola');
    expect(within(dialog).getByRole('button', { name: 'Enviar a 3' })).toBeEnabled();
  });

  it('availability: headings, buttons and the weekday names follow the language', async () => {
    sched.getMyAvailability.mockResolvedValue({ windows: [{ id: 'w1', dayOfWeek: 1, startMinute: 540, endMinute: 1020 }] });
    sched.listMyAvailabilityExceptions.mockResolvedValue({ exceptions: [] });
    renderAs('ASSOCIATE', inSpanish(<AvailabilityEditor />));
    expect(await screen.findByText('Mi disponibilidad')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Quitar' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Guardar' })).toBeInTheDocument();
    expect(await screen.findByText('Días libres (una sola vez)')).toBeInTheDocument();
    // Monday, in Spanish ("lun"), not "Mon".
    const select = screen.getByRole('combobox');
    expect((select as HTMLSelectElement).selectedOptions[0]!.textContent).toMatch(/^lun/i);
  });
});

describe('Open shifts — the managers’ tabs in Spanish', () => {
  it('names the tabs and the empty qualifications catalog in Spanish', async () => {
    sched.listShifts.mockResolvedValue({ shifts: [] });
    renderAs('HR_ADMINISTRATOR', inSpanish(<MarketplaceHome />));
    expect(await screen.findByRole('tab', { name: 'Solicitudes pendientes' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'Calificaciones' }));
    await waitFor(() => expect(screen.getByText('No hay calificaciones')).toBeInTheDocument());
    expect(screen.getAllByRole('button', { name: 'Nueva calificación' }).length).toBeGreaterThan(0);
  });
});
