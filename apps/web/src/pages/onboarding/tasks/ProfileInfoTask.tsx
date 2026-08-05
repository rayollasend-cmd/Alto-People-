import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { getProfile, submitProfile } from '@/lib/onboardingApi';
import { ApiError } from '@/lib/api';
import { Button } from '@/components/ui/Button';
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

  // Hydrate from the server, seeding only fields the user (or their draft)
  // hasn't already filled — server values must never clobber typed input.
  useEffect(() => {
    if (!applicationId) return;
    let cancelled = false;
    (async () => {
      try {
        const p = await getProfile(applicationId);
        if (cancelled) return;
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
      } catch {
        // Hydration is best-effort — the blank form still works. Apply the
        // final state fallback so the select isn't left empty.
        if (!cancelled) setState((cur) => cur || 'FL');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applicationId]);

  // Debounced draft save — cleared on successful submit. The cleanup also
  // cancels any pending write when the component unmounts after submit.
  useEffect(() => {
    if (!applicationId) return;
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
        dob: dob ? new Date(dob).toISOString() : null,
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
      navigate(backTo, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Submission failed.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <TaskShell title="Profile information" backTo={backTo}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="First name" required>
            <input
              type="text"
              required
              autoComplete="given-name"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field label="Last name" required>
            <input
              type="text"
              required
              autoComplete="family-name"
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field label="Date of birth">
            <input
              type="date"
              autoComplete="bday"
              value={dob}
              onChange={(e) => setDob(e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field label="Phone">
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

        <Field label="Address line 1">
          <input
            type="text"
            autoComplete="address-line1"
            value={addressLine1}
            onChange={(e) => setAddressLine1(e.target.value)}
            className={inputCls}
          />
        </Field>
        <Field label="Address line 2">
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
            <Field label="City">
              <input
                type="text"
                autoComplete="address-level2"
                value={city}
                onChange={(e) => setCity(e.target.value)}
                className={inputCls}
              />
            </Field>
          </div>
          <Field label="State">
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
          <Field label="ZIP">
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

        <SubmitRow submitting={submitting} backTo={backTo} />
      </form>
    </TaskShell>
  );
}

/* Shared bits exported so the other task forms reuse them ---------------- */

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

export function SubmitRow({
  submitting,
  backTo,
  label = 'Save',
}: {
  submitting: boolean;
  backTo: string;
  label?: string;
}) {
  return (
    // Sticky on phones: "Submit W-4" used to sit below ~3 screens of form,
    // so the user finished typing and then scrolled hunting for the button.
    // The negative margins let the bar span the TaskShell card edge-to-edge
    // so its backdrop reads as a footer, not a floating strip. md+ (roomy
    // screens) keeps the plain inline row.
    // Cancel-left / submit-right, matching every dialog footer in the app.
    <div className="sticky bottom-0 z-10 -mx-5 -mb-5 mt-2 flex items-center gap-3 border-t border-navy-secondary bg-navy/95 px-5 py-3 backdrop-blur pb-[max(0.75rem,env(safe-area-inset-bottom))] md:static md:z-auto md:mx-0 md:mb-0 md:border-t-0 md:bg-transparent md:p-0 md:pt-2 md:backdrop-blur-none">
      <Link to={backTo} className="text-sm text-silver hover:text-white">
        Cancel
      </Link>
      <Button type="submit" loading={submitting} disabled={submitting}>
        {submitting ? 'Saving…' : label}
      </Button>
    </div>
  );
}

export function TaskShell({
  title,
  children,
  backTo,
}: {
  title: string;
  children: React.ReactNode;
  backTo: string;
}) {
  return (
    <div className="mx-auto">
      <Link
        to={backTo}
        className="text-sm text-silver hover:text-gold inline-block mb-3"
      >
        ← Back to checklist
      </Link>
      <h1 className="font-display text-3xl md:text-4xl text-white mb-6">
        {title}
      </h1>
      <div className="bg-navy border border-navy-secondary rounded-lg p-5 md:p-6">
        {children}
      </div>
    </div>
  );
}
