import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { defaultTenantProfile, termsIn } from '@alto-people/shared';
import { I18nProvider, termVarsFrom, useI18n } from '@/lib/i18n';

/** {org} is the tenant's display name (F500 G5): another staffing company's clients never read "Alto". */
function Probe({ org }: { org?: string }) {
  const { t, setTermVars } = useI18n();
  useEffect(() => setTermVars(termVarsFrom(termsIn(defaultTenantProfile('WORKFORCE_PROVIDER'), 'en'), { org })), [org, setTermVars]);
  return (
    <>
      <p>{t('portal.leadTitle')}</p>
      <p>{t('region.openRequests')}</p>
      <p>{t('portal.subtitle')}</p>
    </>
  );
}

describe('{org}', () => {
  it('is the tenant’s display name in client-facing copy', async () => {
    render(
      <I18nProvider>
        <Probe org="Gulf Coast Staffing" />
      </I18nProvider>,
    );
    expect(await screen.findByText('Your Gulf Coast Staffing lead')).toBeInTheDocument();
    expect(screen.getByText('Open with Gulf Coast Staffing')).toBeInTheDocument();
    expect(screen.getByText('Your Gulf Coast Staffing workforce, live.')).toBeInTheDocument();
  });

  it('falls back to the default branding name before a session names one', () => {
    expect(termVarsFrom(termsIn(defaultTenantProfile('WORKFORCE_PROVIDER'), 'en')).org).toBe('Alto HR');
    expect(termVarsFrom(termsIn(defaultTenantProfile('WORKFORCE_PROVIDER'), 'en'), { org: '  ' }).org).toBe('Alto HR');
  });
});
