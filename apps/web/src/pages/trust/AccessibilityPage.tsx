import { PRODUCT_NAME } from '@alto-people/shared';
import { Card, CardContent } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { PublicShell } from '@/components/trust/PublicShell';

/**
 * The accessibility statement (beside the Trust Center): the standard we
 * build to, what is covered, how it is checked, and where to write when
 * something is in the way. A procurement review asks for this page by
 * name; a person using a screen reader needs the contact line.
 */
const STATEMENT_DATE = '2026-10-15';

const COVERED: Array<{ title: string; body: string }> = [
  { title: 'Keyboard', body: 'Every action can be reached and operated from the keyboard, with a visible focus ring. Dialogs and drawers trap focus while open and return it when closed.' },
  { title: 'Screen readers', body: 'Pages use landmarks, headings in order, labelled controls and live regions for what changes. Status is never conveyed by colour alone.' },
  { title: 'Contrast and themes', body: 'Text and controls meet WCAG AA contrast in both the dark and the light theme; the pairs are tested in the build.' },
  { title: 'Phones and touch', body: 'Touch targets are at least 44 pixels, text can be enlarged to 200 percent, and the layout holds at phone width without sideways scrolling.' },
  { title: 'Motion', body: 'Animation respects the system’s reduced-motion setting.' },
  { title: 'Languages', body: 'The screens a frontline worker uses are available in English, Spanish and Turkish.' },
];

export function AccessibilityPage() {
  return (
    <PublicShell eyebrow="Accessibility">
      <div>
        <div className="mb-1 text-2xs uppercase tracking-[0.18em] text-ink-muted">Accessibility</div>
        <PageHeader
          title="Accessibility statement"
          subtitle={`${PRODUCT_NAME} is built to be usable by everyone who works with it, from the stockroom to the boardroom. This statement says what we build to and how it is checked.`}
        />
      </div>
      <Card className="border-accent/30">
        <CardContent className="p-6">
          <div className="text-2xs uppercase tracking-[0.18em] text-ink-muted">Standard</div>
          <p className="mt-1 text-xl font-medium text-ink">WCAG 2.2, level AA</p>
          <p className="mt-2 max-w-prose text-sm text-ink-muted">
            The signed-in app, the kiosk, the client portal and these public pages are built to the Web Content Accessibility Guidelines 2.2 at level AA. Every build runs an automated audit against the pages each role uses, on desktop and phone, in both themes; a failure stops the release.
          </p>
        </CardContent>
      </Card>
      <section aria-labelledby="a11y-covered">
        <SectionTitle id="a11y-covered" title="What is covered" />
        <Card>
          <CardContent className="divide-y divide-line p-0">
            {COVERED.map((c) => (
              <div key={c.title} className="px-4 py-3">
                <div className="font-medium text-ink">{c.title}</div>
                <p className="mt-0.5 max-w-prose text-sm text-ink-muted">{c.body}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      </section>
      <section aria-labelledby="a11y-limits">
        <SectionTitle id="a11y-limits" title="Known limits" />
        <Card>
          <CardContent className="p-5">
            <p className="max-w-prose text-sm text-ink-muted">
              Documents uploaded by an organization (a scanned form, a policy PDF) are shown as they were uploaded and may not be tagged for a screen reader. Charts carry a table twin with the same numbers. Where a third-party page is linked, its accessibility is its publisher’s.
            </p>
          </CardContent>
        </Card>
      </section>
      <section aria-labelledby="a11y-contact" className="rounded-lg border border-line bg-surface p-5">
        <SectionTitle id="a11y-contact" title="Something in the way?" className="mb-0" />
        <p className="mt-1 max-w-prose text-sm text-ink-muted">
          Tell us from the Help menu inside the app, or through your account team if you do not have an account yet. We answer within two business days and fix what blocks a task first.
        </p>
        <p className="mt-3 text-xs2 text-ink-muted">Statement dated {STATEMENT_DATE}. Reviewed with each release.</p>
      </section>
    </PublicShell>
  );
}
