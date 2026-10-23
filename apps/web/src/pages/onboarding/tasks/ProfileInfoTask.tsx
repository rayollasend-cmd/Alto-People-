import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ListChecks } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { usePageHero } from '@/lib/pageTitle';
import { getApplication, getProfile, submitProfile } from '@/lib/onboardingApi';
import { ApiError } from '@/lib/api';
import { fmtSize } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Select } from '@/components/ui/Select';

const STATES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
  'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
];

interface ProfileDraft {
  firstName?: string;
  lastName?: string;
  dob?: string;
  phone?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  state?: string;
  zip?: string;
}

const draftKeyFor = (applicationId: string) =>
  `alto:onboarding-profile-draft:${applicationId}`;

function readDraft(key: string): ProfileDraft | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as ProfileDraft;
    return null;
  } catch {
    return null; // corrupt / unavailable storage — drafts are best-effort
  }
}

export function ProfileInfoTask() {
  const { applicationId } = useParams<{ applicationId: string }>();
  const { user } = useAuth();
  const { t } = useI18n();
  const navigate = useNavigate();

  const draftKey = draftKeyFor(applicationId ?? '');
  // Read once, synchronously, so the local draft wins over anything the
  // server sends back later.
  const [draft] = useState<ProfileDraft | null>(() => readDraft(draftKey));

  const [firstName, setFirstName] = useState(draft?.firstName ?? '');
  const [lastName, setLastName] = useState(draft?.lastName ?? '');
  const [dob, setDob] = useState(draft?.dob ?? '');
  const [phone, setPhone] = useState(draft?.phone ?? '');
  const [addressLine1, setAddressLine1] = useState(draft?.addressLine1 ?? '');
  const [addressLine2, setAddressLine2] = useState(draft?.addressLine2 ?? '');
  const [city, setCity] = useState(draft?.city ?? '');
  // 'FL' is only the LAST-resort fallback — applied after both the draft and
  // the server profile have had a chance to fill this in (see the fetch below).
  const [state, setState] = useState(draft?.state ?? '');
  const [zip, setZip] = useState(draft?.zip ?? '');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const isAssociate = user?.role === 'ASSOCIATE';
  const backTo = isAssociate
    ? `/onboarding/me/${applicationId}`
    : `/onboarding/applications/${applicationId}`;
  const next = useNextTask('PROFILE_INFO');

  // Hydrate from the server, seeding only fields the user (or their draft)
  // hasn't already filled — server values must never clobber typed input.
  const stateQuery = useQuery({
    queryKey: ['ProfileInfoTask', 'state', applicationId],
    queryFn: () => getProfile(applicationId!),
    enabled: Boolean(applicationId),
  });
  useEffect(() => {
    const p = stateQuery.data;
    if (p === undefined) return;
    const seed = (
      setter: React.Dispatch<React.SetStateAction<string>>,
      value: string | null
    ) => setter((cur) => (cur !== '' ? cur : value ?? ''));
    seed(setFirstName, p.firstName);
    seed(setLastName, p.lastName);
    seed(setDob, p.dob);
    seed(setPhone, p.phone);
    seed(setAddressLine1, p.addressLine1);
    seed(setAddressLine2, p.addressLine2);
    seed(setCity, p.city);
    seed(setZip, p.zip);
    setState((cur) => cur || p.state || 'FL');
  }, [stateQuery.data]);
  useEffect(() => {
    if (!stateQuery.isError) return;
    setState((cur) => cur || 'FL');
  }, [stateQuery.isError, stateQuery.error]);

  // Draft saves only fire once the USER has typed something. Without the
  // dirty gate, the effect persisted the server-hydrated snapshot as a
  // "draft" 400ms after mount — and since drafts win over server data on
  // the next visit, a revisiting associate saw (and could silently
  // re-save) stale pre-correction values after HR fixed their record.
  const dirtyRef = useRef(false);

  // Debounced draft save — cleared on successful submit. The cleanup also
  // cancels any pending write when the component unmounts after submit.
  useEffect(() => {
    if (!applicationId) return;
    if (!dirtyRef.current) return;
    const t = window.setTimeout(() => {
      try {
        localStorage.setItem(
          draftKey,
          JSON.stringify({
            firstName,
            lastName,
            dob,
            phone,
            addressLine1,
            addressLine2,
            city,
            state,
            zip,
          } satisfies ProfileDraft)
        );
      } catch {
        // storage full / unavailable — drafts are best-effort
      }
    }, 400);
    return () => window.clearTimeout(t);
  }, [
    applicationId,
    draftKey,
    firstName,
    lastName,
    dob,
    phone,
    addressLine1,
    addressLine2,
    city,
    state,
    zip,
  ]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!applicationId || submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      await submitProfile(applicationId, {
        firstName,
        lastName,
        // Calendar date — the input already yields YYYY-MM-DD, which is
        // exactly what the contract (z.string().date()) accepts. Wrapping
        // it in new Date().toISOString() made it a timestamp and the API
        // rejected the whole body.
        dob: dob || null,
        phone: phone || null,
        addressLine1: addressLine1 || null,
        addressLine2: addressLine2 || null,
        city: city || null,
        state: state || null,
        zip: zip || null,
      });
      try {
        localStorage.removeItem(draftKey);
      } catch {
        // best-effort
      }
      navigate(next?.route ?? backTo, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('ob.profile.submitFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <TaskShell title={t('ob.profile.title')} backTo={backTo} kind="PROFILE_INFO">
      {/* onInput bubbles from every field (inputs and the state select) —
          one listener marks the form user-dirty for the draft gate. */}
      <form
        onSubmit={handleSubmit}
        onInput={() => {
          dirtyRef.current = true;
        }}
        className="space-y-4"
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label={t('ob.profile.firstName')} required>
            <input
              type="text"
              required
              autoComplete="given-name"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field label={t('ob.profile.lastName')} required>
            <input
              type="text"
              required
              autoComplete="family-name"
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field label={t('ob.profile.dob')}>
            <input
              type="date"
              autoComplete="bday"
              value={dob}
              onChange={(e) => setDob(e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field label={t('ob.profile.phone')}>
            <input
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className={inputCls}
            />
          </Field>
        </div>

        {/* Required: a hire whose city, state and ZIP came prefilled saw an
            empty line 1 with nothing saying it mattered — payroll and the
            W-2 need the street. */}
        <Field
          label={t('ob.profile.addr1')}
          required
          hint={!addressLine1 && (city || zip) ? t('ob.profile.addr1Hint') : undefined}
        >
          <input
            type="text"
            required
            autoComplete="address-line1"
            value={addressLine1}
            onChange={(e) => setAddressLine1(e.target.value)}
            className={inputCls}
          />
        </Field>
        <Field label={t('ob.profile.addr2')}>
          <input
            type="text"
            autoComplete="address-line2"
            value={addressLine2}
            onChange={(e) => setAddressLine2(e.target.value)}
            className={inputCls}
          />
        </Field>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="sm:col-span-2">
            <Field label={t('ob.profile.city')}>
              <input
                type="text"
                autoComplete="address-level2"
                value={city}
                onChange={(e) => setCity(e.target.value)}
                className={inputCls}
              />
            </Field>
          </div>
          <Field label={t('ob.profile.state')}>
            <Select
              autoComplete="address-level1"
              value={state}
              onChange={(e) => setState(e.target.value)}
            >
              {state === '' && <option value="">—</option>}
              {STATES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('ob.profile.zip')}>
            <input
              type="text"
              inputMode="numeric"
              autoComplete="postal-code"
              pattern="[0-9-]*"
              value={zip}
              onChange={(e) => setZip(e.target.value)}
              className={inputCls}
              maxLength={10}
            />
          </Field>
        </div>

        {error && (
          <p role="alert" className="text-sm text-alert">
            {error}
          </p>
        )}

        <SubmitRow submitting={submitting} backTo={backTo} next={next} />
      </form>
    </TaskShell>
  );
}

/* Shared bits exported so the other task forms reuse them ---------------- */

// Task kinds the associate flow chains through in order (every kind has
// its own page; a kind outside this set ends the chain at the checklist).
const CHAINABLE_KINDS = new Set([
  'PROFILE_INFO',
  'PROFILE_PHOTO',
  'W4',
  'DIRECT_DEPOSIT',
  'POLICY_ACK',
  'I9_VERIFICATION',
  'DOCUMENT_UPLOAD',
  'BACKGROUND_CHECK',
  'J1_DOCS',
  'E_SIGN',
  'WOTC_SCREENING',
]);

// Short names for the "Next: …" line under a task's continue button.
function taskShortLabel(
  t: ReturnType<typeof useI18n>['t'],
  kind: string,
): string | null {
  switch (kind) {
    case 'PROFILE_INFO':
      return t('ob.shell.task.profile');
    case 'PROFILE_PHOTO':
      return t('ob.shell.task.photo');
    case 'DOCUMENT_UPLOAD':
      return t('ob.shell.task.documents');
    case 'E_SIGN':
      return t('ob.shell.task.esign');
    case 'BACKGROUND_CHECK':
      return t('ob.shell.task.backgroundCheck');
    case 'W4':
      return t('ob.shell.task.w4');
    case 'DIRECT_DEPOSIT':
      return t('ob.shell.task.directDeposit');
    case 'POLICY_ACK':
      return t('ob.shell.task.policies');
    case 'J1_DOCS':
      return t('ob.shell.task.j1Docs');
    case 'I9_VERIFICATION':
      return t('ob.shell.task.i9');
    case 'WOTC_SCREENING':
      return t('ob.shell.task.wotc');
    default:
      return null;
  }
}

export interface NextTaskTarget {
  route: string;
  label: string;
}

/**
 * The application a task page belongs to — one read, shared by the shell
 * ("Step 3 of 8", "this step isn't part of your onboarding") and the
 * "Save & continue" chaining below. Best-effort: when it can't be loaded
 * the page still works, it just can't say where it sits.
 */
export function useTaskApplication() {
  const { applicationId } = useParams<{ applicationId: string }>();
  return useQuery({
    queryKey: ['onboardingTask', 'application', applicationId ?? null],
    queryFn: () => getApplication(applicationId!),
    enabled: Boolean(applicationId),
  });
}

/**
 * "Save & continue" chaining: the next incomplete real task after the one
 * currently open, so a successful submit can jump straight there instead of
 * round-tripping through the checklist (a tap + a page load per task, ×8).
 * Best-effort — when the application can't be loaded (or the viewer is HR,
 * who reviews rather than fills), callers fall back to the checklist.
 */
export function useNextTask(currentKind: string): NextTaskTarget | null {
  const { applicationId } = useParams<{ applicationId: string }>();
  const { user } = useAuth();
  const { t } = useI18n();
  const isAssociate = user?.role === 'ASSOCIATE';
  const { data: detail } = useTaskApplication();

  return useMemo(() => {
    if (!isAssociate || !detail || !applicationId) return null;
    const candidates = detail.tasks.filter(
      (task) =>
        task.kind !== currentKind &&
        task.status !== 'DONE' &&
        task.status !== 'SKIPPED' &&
        CHAINABLE_KINDS.has(task.kind)
    );
    const curIdx = detail.tasks.findIndex((task) => task.kind === currentKind);
    const target =
      candidates.find((task) => detail.tasks.indexOf(task) > curIdx) ??
      candidates[0] ??
      null;
    return target
      ? {
          route: `/onboarding/me/${applicationId}/tasks/${target.kind.toLowerCase()}`,
          label: taskShortLabel(t, target.kind) ?? target.title,
        }
      : null;
  }, [isAssociate, detail, applicationId, currentKind, t]);
}

// Touch parity with ui/Input: explicit height (comfortable finger target,
// 44px on coarse pointers) and 16px text on touch so iOS Safari never
// zooms the viewport mid-onboarding — this string styles ~35 fields across
// the whole wizard (W-4, I-9, direct deposit, background check, e-sign).
export const inputCls =
  'w-full h-10 coarse:h-11 px-3 py-2 text-sm coarse:text-base rounded bg-navy-secondary/60 border border-navy-secondary focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold text-white';

// The shared, a11y-wired Field replaced the wrapping-label copy that lived
// here: explicit htmlFor/id and hints linked via aria-describedby, injected
// into the child element so no call site changes. Re-exported because the
// sibling task files import it from this module.
import { Field } from '@/components/ui/Field';
export { Field };

/** An upload limit the way people say it: "10 MB", not "10.00 MB". */
export function fmtLimit(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return Number.isInteger(mb) ? `${mb} MB` : fmtSize(bytes);
}

/**
 * The task's main button, sized for the footer: full width on a phone (it
 * shrinks instead of running off a 390px screen — "Save payout method &
 * continue → Policies" did), its natural width from md.
 */
export const taskButtonCls = 'w-full min-w-0 h-auto min-h-10 py-1.5 coarse:min-h-11 md:w-auto';

/**
 * A continue button's words: the verb on the first line, where it goes
 * next as a quieter second line ("Save & continue" / "Next: Policies").
 * One line, and nothing else, when nothing follows.
 */
export function ContinueLabel({ label, next }: { label: string; next?: NextTaskTarget | null }) {
  const { t } = useI18n();
  if (!next) return <span className="min-w-0 truncate">{label}</span>;
  return (
    <span className="flex min-w-0 flex-col items-center leading-tight md:items-start">
      <span className="max-w-full truncate">{label}</span>
      <span className="max-w-full truncate text-xs font-normal opacity-80">
        {t('ob.shell.nextStep', { label: next.label })}
      </span>
    </span>
  );
}

/**
 * The bar every task ends with: Cancel on the left, the task's one action
 * on the right — the order of every dialog footer in the app. Sticky on a
 * phone ("Submit W-4" used to sit below ~3 screens of form, so people
 * scrolled hunting for it); the negative margins let it span the
 * TaskShell card edge to edge so its backdrop reads as a footer. md+
 * keeps a plain inline row.
 */
export function TaskFooter({
  backTo,
  cancelLabel,
  children,
}: {
  backTo: string;
  cancelLabel?: string;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div className="sticky bottom-0 z-10 -mx-5 -mb-5 mt-2 flex items-center gap-3 border-t border-navy-secondary bg-navy/95 px-5 py-3 backdrop-blur pb-[max(0.75rem,env(safe-area-inset-bottom))] md:static md:z-auto md:mx-0 md:mb-0 md:border-t-0 md:bg-transparent md:p-0 md:pt-2 md:backdrop-blur-none">
      <Link to={backTo} className="inline-flex shrink-0 items-center text-sm text-silver hover:text-white coarse:min-h-11">
        {cancelLabel ?? t('ob.shell.cancel')}
      </Link>
      <div className="flex min-w-0 flex-1 items-center gap-3 md:flex-none">{children}</div>
    </div>
  );
}

export function SubmitRow({
  submitting,
  backTo,
  label,
  next,
}: {
  submitting: boolean;
  backTo: string;
  label?: string;
  /** When set, the button says "Save & continue" with "Next: …" under it. */
  next?: NextTaskTarget | null;
}) {
  const { t } = useI18n();
  const effectiveLabel = label ?? t('ob.shell.save');
  return (
    <TaskFooter backTo={backTo}>
      <Button type="submit" loading={submitting} disabled={submitting} className={taskButtonCls}>
        {submitting ? (
          t('ob.shell.saving')
        ) : (
          <ContinueLabel label={next ? t('ob.shell.saveAndContinue') : effectiveLabel} next={next} />
        )}
      </Button>
    </TaskFooter>
  );
}

export function TaskShell({
  title,
  children,
  backTo,
  kind,
}: {
  title: string;
  children: React.ReactNode;
  backTo: string;
  /** The task kind this page fills — gives "Step 3 of 8", and an honest
   *  "not part of your onboarding" when the checklist has no such task. */
  kind?: string;
}) {
  const { t } = useI18n();
  // The task names itself in the top bar (it read "Alto …" on a phone) with
  // the checklist as its parent — which is also where the phone's Back goes.
  const heroRef = usePageHero(title, [{ label: t('ob.check.pageTitle'), to: backTo }, { label: title }]);
  const tasks = useTaskApplication().data?.tasks;
  const index = kind && tasks ? tasks.findIndex((task) => task.kind === kind) : -1;
  // Only once the checklist is known: a page never hides while loading,
  // and a checklist that can't be read never hides a task either.
  const notOnChecklist = Boolean(kind && tasks && index === -1);
  return (
    // A form reads best at a form's width — at 1440 the fields stretched
    // ~1,100px.
    <div className="mx-auto max-w-2xl">
      {/* On a phone the top bar's Back already says "My onboarding". */}
      <Link
        to={backTo}
        className="hidden md:inline-flex text-sm text-silver hover:text-gold items-center coarse:min-h-11 mb-3"
      >
        {t('ob.shell.backToChecklist')}
      </Link>
      {tasks && index >= 0 && (
        <p className="mb-1 text-xs uppercase tracking-widest text-silver" data-testid="task-step">
          {t('ob.shell.stepOf', { n: index + 1, total: tasks.length })}
        </p>
      )}
      <h1 ref={heroRef} className="font-display text-3xl md:text-4xl text-white mb-6">
        {title}
      </h1>
      <div className="bg-navy border border-navy-secondary rounded-lg p-5 md:p-6">
        {notOnChecklist ? (
          <EmptyState
            icon={ListChecks}
            title={t('ob.shell.notOnChecklistTitle')}
            description={t('ob.shell.notOnChecklistBody')}
            action={
              <Button asChild>
                <Link to={backTo}>{t('ob.shell.toChecklist')}</Link>
              </Button>
            }
          />
        ) : (
          children
        )}
      </div>
    </div>
  );
}
