import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, CheckCircle2, Circle } from 'lucide-react';
import {
  getYearEndClose,
  type YearEndCloseResponse,
} from '@/lib/payrollApi';
import { ApiError } from '@/lib/api';
import { PageHeader } from '@/components/ui/PageHeader';
import { Card, CardContent } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/Skeleton';
import { ErrorBanner } from '@/components/ui/ErrorBanner';

export function PayrollYearEndClose() {
  const lastYear = new Date().getUTCFullYear() - 1;
  const [year, setYear] = useState(lastYear);
  const [data, setData] = useState<YearEndCloseResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    getYearEndClose(year)
      .then((d) => !cancelled && setData(d))
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof ApiError ? e.message : "Couldn't load year-end status.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [year]);

  const allReady = data?.readyToClose ?? false;

  return (
    <div className="mx-auto">
      <PageHeader
        title={`Year-end close — ${year}`}
        subtitle="Single checklist that confirms the tax year is fully wrapped: runs disbursed, forms generated, forms filed, recipient copies sent."
        breadcrumbs={[{ label: 'Payroll', to: '/payroll' }, { label: 'Year-end close' }]}
        primaryAction={
          <Input
            type="number"
            min={2020}
            max={lastYear}
            value={year}
            onChange={(e) => setYear(Number(e.target.value) || lastYear)}
            className="w-24"
            aria-label="Tax year"
          />
        }
      />

      {error && <ErrorBanner className="mb-3">{error}</ErrorBanner>}

      {!data && !error && (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-20" />
          ))}
        </div>
      )}

      {data && (
        <>
          {/* Headline banner: a tinted background gives the status card
              structure on top of the page so the readiness state reads
              at-a-glance, and the saturated text/icon punches off the
              tint instead of competing with a solid 2px border. */}
          <Card
            className={`mb-4 border ${
              allReady
                ? 'border-success/40 bg-success/10'
                : 'border-warning/40 bg-warning/10'
            }`}
          >
            <CardContent className="py-4 text-sm">
              {allReady ? (
                <div className="flex items-center gap-2 text-success">
                  <CheckCircle2 className="h-5 w-5" />
                  <span className="font-medium">
                    Tax year {year} is ready to close.
                  </span>
                </div>
              ) : (
                <div className="flex items-center gap-2 text-warning">
                  <Circle className="h-5 w-5" />
                  <span className="font-medium">
                    {data.checks.filter((c) => !c.done).length} item(s) still open before {year} can
                    close.
                  </span>
                </div>
              )}
            </CardContent>
          </Card>

          <ul className="space-y-2">
            {data.checks.map((c) => (
              <li key={c.key}>
                {/* Done rows get a subtle success ring on the left so the
                    list reads as a graded checklist: tinted-+-saturated
                    rows on top of plain-card open rows. Otherwise every
                    row was navy/silver and the only signal was the
                    icon. */}
                <Card
                  className={
                    c.done
                      ? 'border-success/30 bg-success/[0.04]'
                      : 'border-navy-secondary'
                  }
                >
                  <CardContent className="flex items-start gap-3 py-3 text-sm">
                    {c.done ? (
                      <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-success" />
                    ) : (
                      <Circle className="mt-0.5 h-5 w-5 shrink-0 text-silver/70" />
                    )}
                    <div className="flex-1">
                      <div
                        className={`font-medium ${c.done ? 'text-success' : 'text-white'}`}
                      >
                        {c.label}
                      </div>
                      <div className="text-xs text-silver mt-0.5">{c.detail}</div>
                    </div>
                    {!c.done && (
                      <Link
                        to={c.href}
                        className="shrink-0 inline-flex items-center gap-1 text-xs text-gold hover:underline"
                      >
                        Resolve <ArrowRight className="h-3 w-3" />
                      </Link>
                    )}
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
