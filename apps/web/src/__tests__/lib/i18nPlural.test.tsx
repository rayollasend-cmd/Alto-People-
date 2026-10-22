import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { I18nProvider, useI18n } from '@/lib/i18n';

/**
 * Plurals (F500 SH-2): t(key, { count }) picks `<key>_one` when the
 * language says one, `<key>_zero` for 0 when it exists, and the base key
 * otherwise — so "1 stores", "1 requests past their reply-by" and
 * "1 drafts to finalize" read right in English and Spanish, and a key with
 * no variants is unchanged.
 */

function Probe({ count }: { count: number }) {
  const { t, setLang } = useI18n();
  return (
    <div>
      <span data-testid="sub">{t('region.subtitle', { count })}</span>
      <span data-testid="overdue">{t('region.attnOverdue', { count })}</span>
      <span data-testid="drafts">{t('fin.arDrafts', { count })}</span>
      <span data-testid="safety">{t('portal.safetyInRange', { count })}</span>
      {/* No variants: unchanged. */}
      <span data-testid="plain">{t('portal.openCount', { count })}</span>
      <button onClick={() => setLang('es')}>es</button>
    </div>
  );
}

beforeEach(() => localStorage.clear());

describe('t() plurals', () => {
  it('reads the singular at one, in English', () => {
    render(
      <I18nProvider>
        <Probe count={1} />
      </I18nProvider>,
    );
    expect(screen.getByTestId('sub').textContent).toBe('1 store · the same numbers its manager sees');
    expect(screen.getByTestId('overdue').textContent).toBe('1 request past its reply-by');
    expect(screen.getByTestId('drafts').textContent).toBe('1 draft to finalize');
    expect(screen.getByTestId('safety').textContent).toBe('incident in the period');
    expect(screen.getByTestId('plain').textContent).toBe('1 open');
  });

  it('reads the plural otherwise, including zero when there is no _zero form', () => {
    render(
      <I18nProvider>
        <Probe count={3} />
      </I18nProvider>,
    );
    expect(screen.getByTestId('sub').textContent).toBe('3 stores · the same numbers each store manager sees');
    expect(screen.getByTestId('overdue').textContent).toBe('3 requests past their reply-by');
    expect(screen.getByTestId('drafts').textContent).toBe('3 drafts to finalize');
  });

  it('and in Spanish', () => {
    render(
      <I18nProvider>
        <Probe count={1} />
      </I18nProvider>,
    );
    fireEvent.click(screen.getByText('es'));
    expect(screen.getByTestId('overdue').textContent).toBe('1 solicitud vencida');
    expect(screen.getByTestId('drafts').textContent).toBe('1 borrador por finalizar');
    expect(screen.getByTestId('safety').textContent).toBe('incidente en el período');
  });

  it('works without a provider (the English fallback)', () => {
    render(<Probe count={1} />);
    expect(screen.getByTestId('drafts').textContent).toBe('1 draft to finalize');
  });

  it('a count that is not a number (a preformatted string) leaves the base key', () => {
    function P() {
      const { t } = useI18n();
      return <span data-testid="s">{t('fin.arDrafts', { count: '1' })}</span>;
    }
    render(<P />);
    expect(screen.getByTestId('s').textContent).toBe('1 drafts to finalize');
  });
});
