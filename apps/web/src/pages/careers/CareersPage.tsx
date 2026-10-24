import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Briefcase, CheckCircle2, MapPin, Search } from '@/components/ui/icons';
import { ApiError, apiFetch } from '@/lib/api';
import { useUrlParam } from '@/lib/useUrlState';
import { FilterChip } from '@/components/ui/FilterBar';
import {
  applyToPosting,
  getCareerPosting,
  getCareersBrand,
  listCareerPostings,
  recordCareersView,
  type CareerPosting,
  type CareerPostingSummary,
  type CareersBrand,
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
        <Link to="/careers" className="mb-8 flex items-center justify-center" aria-label="All open jobs">
          <Logo size="lg" alt="Company logo" />
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

/**
 * What marketing wrote about working here (the employer brand page):
 * photos, the values, the perks — above the jobs. Nothing of it set means
 * the page reads as it always did.
 */
function BrandBlock({ brand }: { brand: CareersBrand | null }) {
  if (!brand) return null;
  const hasAny = brand.photos.length > 0 || brand.values.length > 0 || brand.perks.length > 0;
  if (!hasAny) return null;
  return (
    <div className="mt-8 space-y-6">
      {brand.photos.length > 0 && (
        <ul className={`grid gap-2 ${brand.photos.length === 1 ? 'grid-cols-1' : 'grid-cols-2 md:grid-cols-3'}`} aria-label="Photos of working here">
          {brand.photos.slice(0, 6).map((p) => (
            <li key={p.id} className="overflow-hidden rounded-lg border border-navy-secondary">
              <img src={p.url} alt={p.alt} loading="lazy" className="aspect-[4/3] w-full object-cover" />
            </li>
          ))}
        </ul>
      )}
      {brand.values.length > 0 && (
        <ul className="grid gap-3 sm:grid-cols-2">
          {brand.values.map((v) => (
            <li key={v.title} className="rounded-lg border border-navy-secondary bg-navy/40 p-4">
              <div className="font-medium">{v.title}</div>
              {v.body && <div className="mt-1 text-sm text-silver">{v.body}</div>}
            </li>
          ))}
        </ul>
      )}
      {brand.perks.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label="Perks">
          {brand.perks.map((perk) => (
            <li key={perk} className="rounded-md border border-gold/40 bg-gold/10 px-2.5 py-1 text-sm text-gold">
              {perk}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ===== /careers =========================================================== */

export function CareersListPage() {
  const [search] = useSearchParams();
  const source = search.get('source');
  const q = useQuery({ queryKey: ['careers', 'postings'], queryFn: listCareerPostings });
  const brandQuery = useQuery({ queryKey: ['careers', 'brand'], queryFn: getCareersBrand, retry: false });
  // An empty board still gives a way to reach a recruiter: the organization's published address.
  const contactQ = useQuery({
    queryKey: ['support', 'config'],
    queryFn: () => apiFetch<{ contact?: { email: string } }>('/support/config'),
    retry: false,
    staleTime: 60 * 60_000,
  });
  const brand = brandQuery.data ?? null;
  const postings = q.data?.postings ?? null;
  const orgName = q.data?.orgName ?? null;
  const error = q.error ? (q.error instanceof ApiError ? q.error.message : 'Could not load open jobs.') : null;
  // Search and the Location / Schedule chips live in the URL, so a filtered list can be shared (F500 G5).
  const [text, setText] = useUrlParam<string>('q', '');
  const [where, setWhere] = useUrlParam<string>('location', '');
  const [schedule, setSchedule] = useUrlParam<string>('schedule', '');

  useEffect(() => {
    document.title = 'Open jobs';
  }, []);
  // One view, by the source the link carried — marketing's top of funnel.
  useEffect(() => {
    recordCareersView(null, source);
  }, [source]);

  const locations = useMemo(
    () => [...new Set((postings ?? []).map((p) => p.location?.trim()).filter((l): l is string => !!l))].sort((a, b) => a.localeCompare(b)),
    [postings],
  );
  const schedules = useMemo(
    () => (Object.keys(SCHEDULE_WORD) as Array<keyof typeof SCHEDULE_WORD>).filter((k) => (postings ?? []).some((p) => p.schedule === k)),
    [postings],
  );
  const shown = useMemo(() => {
    const needle = text.trim().toLowerCase();
    return (postings ?? [])
      .filter((p) => !where || p.location?.trim() === where)
      .filter((p) => !schedule || p.schedule === schedule)
      .filter((p) => !needle || [p.title, p.location, p.clientName].some((v) => v?.toLowerCase().includes(needle)))
      // Newest first (the API's order, said here so a filter can't shuffle it).
      .sort((a, b) => (b.openedAt ?? '').localeCompare(a.openedAt ?? ''));
  }, [postings, text, where, schedule]);
  const filtering = !!(text.trim() || where || schedule);
  const contactEmail = contactQ.data?.contact?.email ?? null;

  return (
    <Shell>
      <h1 className="font-display text-3xl md:text-4xl text-white">{brand?.headline || 'Work with us'}</h1>
      <p className="mt-2 text-silver">
        {brand?.intro ||
          `Open jobs${orgName ? ` at ${orgName}` : ''}. Apply in a couple of minutes — a recruiter will get back to you.`}
      </p>
      <BrandBlock brand={brand} />

      {/* While the jobs load, the search box and count line hold their place:
          they arrived with the jobs and pushed the list down (CLS 0.14 on a phone). */}
      {postings === null && !error && (
        <div className="mt-8 space-y-3" aria-hidden="true">
          <Skeleton className="h-10 w-full rounded-md coarse:h-11" />
          <Skeleton className="h-5 w-24" />
        </div>
      )}
      {postings && postings.length > 0 && (
        <div className="mt-8 space-y-3" data-testid="careers-filters">
          <label className="relative block">
            <span className="sr-only">Search jobs</span>
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-silver/70" aria-hidden="true" />
            <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Search by job, place or company" className="pl-9" />
          </label>
          {(locations.length > 1 || schedules.length > 1) && (
            <div className="flex flex-wrap gap-1.5">
              {locations.length > 1 &&
                locations.map((l) => (
                  <FilterChip key={l} active={where === l} onClick={() => setWhere(where === l ? '' : l)}>
                    {l}
                  </FilterChip>
                ))}
              {schedules.length > 1 &&
                schedules.map((k) => (
                  <FilterChip key={k} active={schedule === k} onClick={() => setSchedule(schedule === k ? '' : k)}>
                    {SCHEDULE_WORD[k]}
                  </FilterChip>
                ))}
            </div>
          )}
          <p className="text-sm text-silver" data-testid="careers-count">
            {shown.length === 1 ? '1 open job' : `${shown.length} open jobs`}
            {filtering && (
              <>
                {' · '}
                <button
                  type="button"
                  className="text-gold underline underline-offset-2 hover:text-gold-bright"
                  onClick={() => {
                    setText('');
                    setWhere('');
                    setSchedule('');
                  }}
                >
                  Show all
                </button>
              </>
            )}
          </p>
        </div>
      )}

      <div className="mt-4 space-y-3">
        {error && <ErrorBanner>{error}</ErrorBanner>}
        {postings === null && !error &&
          Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="rounded-lg border border-navy-secondary bg-navy/60 p-5">
              <Skeleton className="h-5 w-1/2 mb-3" />
              <Skeleton className="h-3 w-1/3" />
            </div>
          ))}
        {postings?.length === 0 && (
          // Not a dead end: who to write to while nothing is open.
          <div className="rounded-lg border border-navy-secondary bg-navy/60 p-6 text-center text-silver" data-testid="careers-empty">
            <p className="text-ink">There are no open jobs right now.</p>
            {contactEmail ? (
              <p className="mt-2 text-sm">
                Write to{' '}
                <a href={`mailto:${contactEmail}?subject=${encodeURIComponent('Looking for work')}`} className="text-gold underline underline-offset-2">
                  {contactEmail}
                </a>{' '}
                with the kind of work and the places you’re after, and a recruiter will keep you in mind. New jobs are posted here first.
              </p>
            ) : (
              <p className="mt-2 text-sm">New jobs are posted here first — check back soon.</p>
            )}
          </div>
        )}
        {postings && postings.length > 0 && shown.length === 0 && (
          <div className="rounded-lg border border-navy-secondary bg-navy/60 p-6 text-center text-silver">No open job matches that. Try another search or show all.</div>
        )}
        {shown.map((p) => (
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
  const applyRef = useRef<HTMLDivElement>(null);
  const missing = q.error instanceof ApiError && q.error.status === 404;
  const loadError =
    q.error && !missing ? (q.error instanceof ApiError ? q.error.message : 'Could not load this job.') : null;

  useEffect(() => {
    if (posting) document.title = `${posting.title} — Jobs at ${posting.orgName}`;
  }, [posting]);
  const source = search.get('source');
  useEffect(() => {
    if (slug) recordCareersView(slug, source);
  }, [slug, source]);

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
          <div ref={applyRef} className="scroll-mt-6">
            <ApplyForm slug={posting.slug} title={posting.title} source={source} />
          </div>
          {/* On a phone the form is far below the description: one tap takes you there (F500 G5). */}
          <div className="sticky bottom-0 -mx-4 mt-6 border-t border-navy-secondary bg-navy/95 px-4 py-3 backdrop-blur sm:hidden" data-testid="careers-sticky-apply">
            <Button className="w-full" onClick={() => applyRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
              Apply for this job
            </Button>
          </div>
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
