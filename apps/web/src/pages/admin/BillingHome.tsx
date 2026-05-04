import { useEffect, useState } from 'react';
import { BadgeDollarSign, CreditCard, FileText, Users as UsersIcon } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { getOrgBranding } from '@/lib/brandingApi';
import { listAdminUsers } from '@/lib/usersAdminApi';
import { Button } from '@/components/ui/Button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { PageHeader } from '@/components/ui/PageHeader';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * HR-only billing scaffold. The org runs on a manual contract today —
 * Stripe integration is deferred until plan tiers are decided. This page
 * exists so HR has one place to see the surface area (plan, seats,
 * payment method, invoices) and so the "self-serve everything" sidebar
 * has a billing entry. Every interactive control is intentionally a stub.
 */
export function BillingHome() {
  const [supportEmail, setSupportEmail] = useState<string | null>(null);
  const [activeSeats, setActiveSeats] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getOrgBranding(), listAdminUsers({ status: 'ACTIVE' })])
      .then(([branding, users]) => {
        if (cancelled) return;
        setSupportEmail(branding.supportEmail);
        setActiveSeats(users.users.length);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : 'Could not load billing info.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const supportLine = supportEmail ?? 'your account manager';

  return (
    <div>
      <PageHeader
        title="Billing"
        subtitle="Plan, seats, payment method, and invoice history. Self-serve billing is on the roadmap — for now, contracts are managed manually."
        breadcrumbs={[
          { label: 'Home', to: '/' },
          { label: 'Billing' },
        ]}
      />

      <div className="mb-6 rounded-lg border border-gold/40 bg-gold/10 px-4 py-3 text-sm text-white">
        Billing is managed manually today. To upgrade, downgrade, or update
        billing details, email{' '}
        {supportEmail ? (
          <a
            href={`mailto:${supportEmail}`}
            className="text-gold underline underline-offset-2 hover:text-gold-soft"
          >
            {supportEmail}
          </a>
        ) : (
          <span className="text-silver">{supportLine}</span>
        )}
        .
      </div>

      {error ? (
        <ErrorBanner>{error}</ErrorBanner>
      ) : (
        <div className="grid gap-6 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <BadgeDollarSign className="h-4 w-4 text-gold" />
                Plan
              </CardTitle>
              <CardDescription>
                Custom contract negotiated with sales. Tiered self-serve plans
                are on the roadmap.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
                <div>
                  <dt className="text-silver/70 text-xs uppercase tracking-wide">
                    Plan
                  </dt>
                  <dd className="text-white mt-1">Custom</dd>
                </div>
                <div>
                  <dt className="text-silver/70 text-xs uppercase tracking-wide">
                    Billing cycle
                  </dt>
                  <dd className="text-silver mt-1">—</dd>
                </div>
                <div>
                  <dt className="text-silver/70 text-xs uppercase tracking-wide">
                    Status
                  </dt>
                  <dd className="text-white mt-1">
                    <span className="inline-flex items-center gap-1.5">
                      <span className="h-2 w-2 rounded-full bg-emerald-400" />
                      Active
                    </span>
                  </dd>
                </div>
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <UsersIcon className="h-4 w-4 text-gold" />
                Seats
              </CardTitle>
              <CardDescription>
                Active user accounts counted toward billing. Disabled and
                invited-but-not-accepted accounts don't count.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {loading ? (
                <Skeleton className="h-10 w-24" />
              ) : (
                <div className="flex items-baseline gap-2">
                  <span className="font-display text-4xl text-white">
                    {activeSeats ?? '—'}
                  </span>
                  <span className="text-silver text-sm">
                    {activeSeats === 1 ? 'active seat' : 'active seats'}
                  </span>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <CreditCard className="h-4 w-4 text-gold" />
                Payment method
              </CardTitle>
              <CardDescription>
                Cards and ACH details will live here once Stripe is wired up.
                Today, payment is handled out-of-band with your account
                manager.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <EmptyState
                icon={CreditCard}
                title="No payment method on file"
                description="Stripe integration coming soon."
                action={
                  <Button variant="outline" disabled>
                    Add payment method
                  </Button>
                }
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FileText className="h-4 w-4 text-gold" />
                Invoice history
              </CardTitle>
              <CardDescription>
                Receipts and downloadable PDFs will appear here once invoices
                are issued through the platform.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <EmptyState
                icon={FileText}
                title="No invoices yet"
                description={
                  <>
                    Past invoices were sent by email — check with{' '}
                    {supportEmail ?? 'your account manager'} for copies.
                  </>
                }
              />
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

export default BillingHome;
