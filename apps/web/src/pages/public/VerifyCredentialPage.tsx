import { useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Check, CircleAlert, CircleHelp, Clock, FileJson, Lock, ShieldCheck, ShieldX, X, type LucideIcon } from '@/components/ui/icons';
import { ApiError } from '@/lib/api';
import { calendarDay, fmtDate } from '@/lib/format';
import { verifyCredential, type VerifyResult } from '@/lib/credentialsApi';
import { cn } from '@/lib/cn';
import { Logo } from '@/components/Logo';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { PageHeader } from '@/components/ui/PageHeader';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { Textarea } from '@/components/ui/Input';

/**
 * Check a credential — the page an outside employer, a client's HR or a
 * program sponsor lands on with a file a worker gave them. No login, and
 * nothing is kept: the credential is checked (format, issuer, signature,
 * revocation, dates) and the answer shown in plain words.
 */

const VERDICT: Record<VerifyResult['verdict'], { title: string; body: string; icon: LucideIcon; tone: 'good' | 'bad' | 'warn' | 'neutral' }> = {
  valid: { title: 'Valid credential', body: 'Signed by the issuer, unchanged since, not revoked and in date.', icon: ShieldCheck, tone: 'good' },
  revoked: { title: 'Revoked', body: 'The issuer has withdrawn this credential. Don’t rely on it.', icon: ShieldX, tone: 'bad' },
  expired: { title: 'Expired', body: 'It was valid, but its end date has passed. Ask the holder for a current one.', icon: Clock, tone: 'warn' },
  not_yet_valid: { title: 'Not valid yet', body: 'Its start date is still to come.', icon: Clock, tone: 'warn' },
  invalid: { title: 'Can’t be trusted', body: 'It was altered, isn’t a credential, or wasn’t signed by the issuer it names.', icon: ShieldX, tone: 'bad' },
  unknown_issuer: { title: 'Issued elsewhere', body: 'This page checks credentials issued here. Use the issuer’s own verifier for this one.', icon: CircleHelp, tone: 'neutral' },
};

const TONE = {
  good: 'border-success/40 bg-success/10 text-success',
  bad: 'border-alert/40 bg-alert/10 text-alert',
  warn: 'border-warning/40 bg-warning/10 text-warning',
  neutral: 'border-line bg-surface-raised text-ink-muted',
} as const;

const CHECK_ICON = { pass: Check, fail: X, warn: CircleAlert } as const;
const CHECK_TONE = { pass: 'bg-success/15 text-success', fail: 'bg-alert/15 text-alert', warn: 'bg-warning/15 text-warning' } as const;
const CHECK_WORD = { pass: 'Passed', fail: 'Failed', warn: 'Note' } as const;

export function VerifyCredentialPage() {
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const check = useMutation({ mutationFn: (raw: string) => verifyCredential(raw) });
  const result = check.data;
  const v = result ? VERDICT[result.verdict] : null;

  const openFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 512_000) {
      setFileName(null);
      check.reset();
      return;
    }
    const body = await file.text();
    setText(body);
    setFileName(file.name);
    check.mutate(body);
  };

  return (
    <div className="min-h-screen bg-sunken text-ink">
      <main className="mx-auto w-full max-w-2xl px-4 pb-16 pt-8 sm:pt-14">
        <div className="flex items-center gap-3">
          <Logo size="sm" />
          <span className="text-xs font-medium uppercase tracking-[0.14em] text-ink-muted">Credential check</span>
        </div>

        <div className="mt-8">
          <PageHeader title="Check a credential" />
          <p className="mt-3 max-w-xl text-base text-ink-muted">
            Paste the credential someone gave you, or open its file. We check that the issuer signed it, that nothing in it has changed, that it hasn’t been revoked, and its dates.
          </p>
        </div>

        <Card className="mt-6">
          <CardContent className="space-y-3 p-4 sm:p-5">
            <label htmlFor="credential" className="text-sm font-medium text-ink">
              The credential
            </label>
            <Textarea
              id="credential"
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setFileName(null);
              }}
              rows={7}
              spellCheck={false}
              placeholder='{"@context": ["https://www.w3.org/ns/credentials/v2", …], "type": ["VerifiableCredential", …], …}'
              className="font-mono text-xs"
              aria-describedby="credential-hint"
            />
            <p id="credential-hint" className="text-xs text-ink-muted">
              {fileName ? `Opened ${fileName}.` : 'A .json file, or the text inside it.'}
            </p>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Button className="w-full sm:w-auto" onClick={() => check.mutate(text)} disabled={!text.trim()} loading={check.isPending}>
                <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                Check it
              </Button>
              <Button variant="outline" className="w-full sm:w-auto" onClick={() => fileRef.current?.click()}>
                <FileJson className="h-4 w-4" aria-hidden="true" />
                Open a file
              </Button>
              <input
                ref={fileRef}
                type="file"
                accept=".json,application/json,application/ld+json,application/vc+ld+json"
                className="sr-only"
                tabIndex={-1}
                aria-hidden="true"
                onChange={(e) => void openFile(e.target.files?.[0])}
              />
            </div>
          </CardContent>
        </Card>

        {check.isError && (
          <ErrorBanner className="mt-5" action={<Button size="sm" variant="outline" onClick={() => check.mutate(text)}>Try again</Button>}>
            {check.error instanceof ApiError && check.error.status === 429 ? 'Too many checks from this connection. Wait a few minutes and try again.' : 'The check couldn’t run just now. Try again in a moment.'}
          </ErrorBanner>
        )}

        {result && v && (
          <section aria-live="polite" aria-label="Result" className="mt-6 space-y-4">
            <div className={cn('flex items-start gap-4 rounded-xl border p-4 sm:p-5', TONE[v.tone])}>
              <v.icon className="mt-0.5 h-8 w-8 shrink-0" aria-hidden="true" />
              <div className="min-w-0 flex-1 [&_h2]:text-current">
                <SectionTitle title={v.title} display />
                <p className="mt-1 text-sm text-ink">{v.body}</p>
              </div>
            </div>

            {result.credential && (result.credential.title || result.credential.holder) && (
              <Card>
                <CardContent className="p-4 sm:p-5">
                  <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
                    {result.credential.title && <Item label="Credential" value={result.credential.title} />}
                    {result.credential.holder && <Item label="Held by" value={result.credential.holder} />}
                    {result.credential.issuer && <Item label="Issued by" value={result.credential.issuer} />}
                    {result.credential.kind && <Item label="Type" value={result.credential.kind === 'Course' ? 'Completed training' : 'Certification'} />}
                    {result.credential.issuedAt && <Item label="Valid from" value={fmtDate(calendarDay(result.credential.issuedAt))} />}
                    <Item label="Valid until" value={result.credential.expiresAt ? fmtDate(calendarDay(result.credential.expiresAt)) : 'No end date'} />
                  </dl>
                </CardContent>
              </Card>
            )}

            <Card>
              <CardContent className="p-4 sm:p-5">
                <SectionTitle title="What was checked" as="h3" />
                <ul className="mt-3 space-y-2.5">
                  {result.checks.map((c) => {
                    const Icon = CHECK_ICON[c.state];
                    return (
                      <li key={c.key} className="flex items-start gap-3 text-sm">
                        <span className={cn('mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full', CHECK_TONE[c.state])}>
                          <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                          <span className="sr-only">{CHECK_WORD[c.state]}:</span>
                        </span>
                        <span className="text-ink">{c.label}</span>
                      </li>
                    );
                  })}
                </ul>
              </CardContent>
            </Card>
          </section>
        )}

        <div className="mt-10 flex items-start gap-3 text-xs text-ink-muted">
          <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <p>
            Nothing you paste is stored. Credentials here follow the W3C Verifiable Credentials 2.0 and Open Badges 3.0 standards, signed with Ed25519 (Data Integrity, eddsa-jcs-2022). The issuer’s public key is published at{' '}
            <Link to="/.well-known/did.json" reloadDocument className="underline underline-offset-2 hover:text-ink">
              /.well-known/did.json
            </Link>
            , so any compatible verifier can check them too.
          </p>
        </div>
      </main>
    </div>
  );
}

function Item({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd className="mt-0.5 text-ink">{value}</dd>
    </div>
  );
}
