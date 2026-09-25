import { useEffect, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Briefcase, CheckCircle2, MapPin } from 'lucide-react';
import { ApiError } from '@/lib/api';
import {
  applyToPosting,
  getCareerPosting,
  listCareerPostings,
  type CareerPosting,
  type CareerPostingSummary,
} from '@/lib/careersApi';
import { fmtMoney } from '@/lib/format';
import { Logo } from '@/components/Logo';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Input, Textarea } from '@/components/ui/Input';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * The public careers site.
 *
 * Recruiters could open a job posting and the Postings tab showed its
 * address — /careers/{slug} — but there was no such page: the API served
 * the postings and took applications, and nothing rendered them. These two
 * pages are that site: the open jobs, and one job with its application.
 *
 * No login and no app chrome, like the hotline. A `?source=` on the link
 * (e.g. ?source=indeed on the link placed there) is passed through, so the
 * recruiter's "where did they come from" is filled in for them.
 */

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-gradient-to-br from-midnight via-navy to-navy-secondary text-white">
      <div className="mx-auto max-w-3xl px-4 py-10 md:px-6 md:py-14">
        <Link to="/careers" className="mb-8 flex items-center justify-center" aria-label="All jobs at Alto">
          <Logo size="lg" alt="Alto" />
        </Link>
        {children}
      </div>
    </div>
  );
}

/**
 * "$15.00 – $18.00 an hour". A posting says whether its range is hourly or
 * yearly; an older one that doesn't is read by size — a range under a few
 * hundred can only be hourly pay, anything above it annual.
 */
function payLine(p: CareerPostingSummary): string | null {
  const min = p.minSalary ? Number(p.minSalary) : null;
  const max = p.maxSalary ? Number(p.maxSalary) : null;
  if (min === null && max === null) return null;
  const top = max ?? min ?? 0;
  const per = p.payUnit ? (p.payUnit === 'HOUR' ? 'an hour' : 'a year') : top < 500 ? 'an hour' : 'a year';
  const f = (n: number) => fmtMoney(n, { currency: p.currency });
  if (min !== null && max !== null && min !== max) return `${f(min)} – ${f(max)} ${per}`;
  return `${f((min ?? max)!)} ${per}`;
}

const SCHEDULE_WORD: Record<NonNullable<CareerPostingSummary['schedule']>, string> = {
  FULL_TIME: 'Full-time',
  PART_TIME: 'Part-time',
  TEMPORARY: 'Temporary',
  SEASONAL: 'Seasonal',
};

function Meta({ p }: { p: CareerPostingSummary }) {
  const pay = payLine(p);
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-silver">
      {p.location && (
        <span className="inline-flex items-center gap-1.5">
          <MapPin className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {p.location}
        </span>
      )}
      {p.clientName && (
        <span className="inline-flex items-center gap-1.5">
          <Briefcase className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {p.clientName}
        </span>
      )}
      {p.schedule && <span>{SCHEDULE_WORD[p.schedule]}</span>}
      {pay && <span className="text-white">{pay}</span>}
    </div>
  );
}

/* ===== /careers =========================================================== */

export function CareersListPage() {
  const [search] = useSearchParams();
  const source = search.get('source');
  const q = useQuery({ queryKey: ['careers', 'postings'], queryFn: listCareerPostings });
  const postings = q.data?.postings ?? null;
  const error = q.error ? (q.error instanceof ApiError ? q.error.message : 'Could not load open jobs.') : null;

  useEffect(() => {
    document.title = 'Jobs at Alto';
  }, []);

  return (
    <Shell>
      <h1 className="font-display text-3xl md:text-4xl text-white">Work with Alto</h1>
      <p className="mt-2 text-silver">
        Open jobs at stores across the Florida Panhandle. Apply in a couple of minutes — a recruiter will
        get back to you.
      </p>

      <div className="mt-8 space-y-3">
        {error && <ErrorBanner>{error}</ErrorBanner>}
        {postings === null && !error &&
          Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="rounded-lg border border-navy-secondary bg-navy/60 p-5">
              <Skeleton className="h-5 w-1/2 mb-3" />
              <Skeleton className="h-3 w-1/3" />
            </div>
          ))}
        {postings?.length === 0 && (
          <div className="rounded-lg border border-navy-secondary bg-navy/60 p-6 text-center text-silver">
            There are no open jobs right now. Check back soon.
          </div>
        )}
        {postings?.map((p) => (
          <Link
            key={p.slug}
            to={`/careers/${p.slug}${source ? `?source=${encodeURIComponent(source)}` : ''}`}
            className="block rounded-lg border border-navy-secondary bg-navy/60 p-5 transition-colors hover:border-gold/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
          >
            <div className="text-lg font-medium text-white">{p.title}</div>
            <div className="mt-1.5">
              <Meta p={p} />
            </div>
          </Link>
        ))}
      </div>
    </Shell>
  );
}

/* ===== /careers/:slug ===================================================== */

export function CareerPostingPage() {
  const { slug = '' } = useParams();
  const [search] = useSearchParams();
  const q = useQuery({
    queryKey: ['careers', 'posting', slug],
    queryFn: () => getCareerPosting(slug),
    // A 404 is an answer — the job closed — not a blip to retry.
    retry: (n, err) => !(err instanceof ApiError && err.status === 404) && n < 2,
  });
  const posting = q.data ?? null;
  const missing = q.error instanceof ApiError && q.error.status === 404;
  const loadError =
    q.error && !missing ? (q.error instanceof ApiError ? q.error.message : 'Could not load this job.') : null;

  useEffect(() => {
    if (posting) document.title = `${posting.title} — Jobs at Alto`;
  }, [posting]);

  return (
    <Shell>
      <Link to="/careers" className="mb-6 inline-flex items-center gap-1.5 text-sm text-silver hover:text-white">
        <ArrowLeft className="h-4 w-4" />
        All jobs
      </Link>

      {missing ? (
        <div className="rounded-lg border border-navy-secondary bg-navy/60 p-6">
          <h1 className="text-xl text-white">This job isn't open anymore</h1>
          <p className="mt-2 text-silver">
            It may have been filled. <Link to="/careers" className="text-gold hover:underline">See the jobs that are open</Link>.
          </p>
        </div>
      ) : loadError ? (
        <ErrorBanner>{loadError}</ErrorBanner>
      ) : !posting ? (
        <div>
          <Skeleton className="h-8 w-2/3 mb-3" />
          <Skeleton className="h-4 w-1/3 mb-8" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : (
        <>
          <h1 className="font-display text-3xl md:text-4xl text-white">{posting.title}</h1>
          <div className="mt-3">
            <Meta p={posting} />
          </div>
          <div className="mt-6 whitespace-pre-wrap leading-relaxed text-silver">{posting.description}</div>
          <ApplyForm slug={posting.slug} title={posting.title} source={search.get('source')} />
          <JobPostingStructuredData posting={posting} />
        </>
      )}
    </Shell>
  );
}

/**
 * Google for Jobs: schema.org JobPosting markup on the posting page puts
 * the job in Google's job search — no feed, no account. Only fields the
 * posting really has are given; a guessed salary unit or location would
 * get the listing flagged.
 */
function JobPostingStructuredData({ posting }: { posting: CareerPosting }) {
  const loc = (posting.location ?? '').trim();
  const m = loc.match(/^(.+?),\s*([A-Za-z]{2})(?:\s+(\d{5}(?:-\d{4})?))?$/);
  const address = m
    ? { addressLocality: m[1]!.trim(), addressRegion: m[2]!.toUpperCase(), ...(m[3] ? { postalCode: m[3] } : {}) }
    : loc
      ? { addressLocality: loc }
      : null;
  const lo = posting.minSalary ? Number(posting.minSalary) : null;
  const hi = posting.maxSalary ? Number(posting.maxSalary) : null;
  const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const data = {
    '@context': 'https://schema.org/',
    '@type': 'JobPosting',
    title: posting.title,
    description: posting.description
      .trim()
      .split(/\n{2,}/)
      .map((p) => `<p>${escape(p).replace(/\n/g, '<br>')}</p>`)
      .join(''),
    ...(posting.openedAt ? { datePosted: posting.openedAt.slice(0, 10) } : {}),
    ...(posting.schedule ? { employmentType: posting.schedule === 'SEASONAL' ? 'TEMPORARY' : posting.schedule } : {}),
    hiringOrganization: { '@type': 'Organization', name: posting.orgName, sameAs: window.location.origin },
    identifier: { '@type': 'PropertyValue', name: posting.orgName, value: posting.slug },
    directApply: true,
    ...(address
      ? { jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', addressCountry: 'US', ...address } } }
      : {}),
    ...(posting.payUnit && (lo !== null || hi !== null)
      ? {
          baseSalary: {
            '@type': 'MonetaryAmount',
            currency: posting.currency || 'USD',
            value: {
              '@type': 'QuantitativeValue',
              ...(lo !== null ? { minValue: lo } : {}),
              ...(hi !== null ? { maxValue: hi } : {}),
              unitText: posting.payUnit,
            },
          },
        }
      : {}),
  };
  // `<` is escaped so text in the posting can never close the script tag.
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: json }} />;
}

function ApplyForm({ slug, title, source }: { slug: string; title: string; source: string | null }) {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [resumeUrl, setResumeUrl] = useState('');
  const [notes, setNotes] = useState('');
  // Honeypot — hidden from people, filled by bots; the server drops those.
  const [website, setWebsite] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ alreadyApplied: boolean } | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await applyToPosting(slug, {
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        email: email.trim(),
        phone: phone.trim() || null,
        resumeUrl: resumeUrl.trim() || null,
        notes: notes.trim() || null,
        source: source || null,
        website: website || null,
      });
      setDone({ alreadyApplied: res.alreadyApplied });
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.status === 429
            ? 'Too many applications from here in a short time. Please try again in an hour.'
            : err.message
          : 'Your application did not go through. Check your connection and try again.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  if (done) {
    return (
      <div role="status" className="mt-10 rounded-lg border border-success/40 bg-success/10 p-6">
        <div className="flex items-center gap-2 text-lg text-white">
          <CheckCircle2 className="h-5 w-5 text-success" aria-hidden="true" />
          {done.alreadyApplied ? 'We have your application' : 'Application sent'}
        </div>
        <p className="mt-2 text-silver">
          {done.alreadyApplied
            ? `You're already on file with us, so we've added ${title} to your application — no need to apply again.`
            : `Thanks, ${firstName.trim()}. A recruiter will review it and contact you about next steps.`}{' '}
          We sent a confirmation to <span className="text-white">{email.trim()}</span>.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="mt-10 rounded-lg border border-navy-secondary bg-navy/60 p-5 md:p-6 space-y-4">
      <h2 className="text-xl text-white">Apply for this job</h2>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="First name" required>
          {(p) => <Input {...p} autoComplete="given-name" value={firstName} onChange={(e) => setFirstName(e.target.value)} maxLength={100} />}
        </Field>
        <Field label="Last name" required>
          {(p) => <Input {...p} autoComplete="family-name" value={lastName} onChange={(e) => setLastName(e.target.value)} maxLength={100} />}
        </Field>
        <Field label="Email" required>
          {(p) => <Input {...p} type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />}
        </Field>
        <Field label="Phone" hint="So a recruiter can call or text you.">
          {(p) => <Input {...p} type="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={40} />}
        </Field>
      </div>
      <Field label="Link to your résumé" hint="Optional — a Google Drive, Dropbox or LinkedIn link works.">
        {(p) => (
          <Input {...p} type="url" inputMode="url" placeholder="https://" value={resumeUrl} onChange={(e) => setResumeUrl(e.target.value)} />
        )}
      </Field>
      <Field label="Anything we should know?" hint="Optional — availability, which store you'd prefer, how you'll get to work.">
        {(p) => <Textarea {...p} rows={3} maxLength={4000} value={notes} onChange={(e) => setNotes(e.target.value)} />}
      </Field>
      <div aria-hidden="true" className="absolute -left-[10000px] h-px w-px overflow-hidden">
        <label>
          Website
          <input tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} />
        </label>
      </div>
      {error && <ErrorBanner>{error}</ErrorBanner>}
      <Button type="submit" className="w-full sm:w-auto" loading={submitting} disabled={submitting || !firstName.trim() || !lastName.trim() || !email.trim()}>
        Send application
      </Button>
    </form>
  );
}
