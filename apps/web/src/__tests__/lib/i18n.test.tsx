import { describe, expect, it, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { I18nProvider, useI18n } from '@/lib/i18n';

function Probe() {
  const { lang, setLang, t } = useI18n();
  return (
    <div>
      <span data-testid="lang">{lang}</span>
      <span data-testid="greeting">{t('dash.greeting', { name: 'Maria' })}</span>
      <span data-testid="tab">{t('tabs.schedule')}</span>
      <button onClick={() => setLang('es')}>es</button>
    </div>
  );
}

beforeEach(() => {
  localStorage.clear();
});

describe('i18n', () => {
  it('defaults to English and interpolates {name}', () => {
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>
    );
    expect(screen.getByTestId('lang').textContent).toBe('en');
    expect(screen.getByTestId('greeting').textContent).toBe('Hey Maria 👋');
    expect(screen.getByTestId('tab').textContent).toBe('Schedule');
  });

  it('switches to Spanish, persists the choice, and translates', () => {
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>
    );
    fireEvent.click(screen.getByText('es'));
    expect(screen.getByTestId('greeting').textContent).toBe('Hola Maria 👋');
    expect(screen.getByTestId('tab').textContent).toBe('Horario');
    expect(localStorage.getItem('alto.lang')).toBe('es');
  });

  it('restores the stored language on mount', () => {
    localStorage.setItem('alto.lang', 'es');
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>
    );
    expect(screen.getByTestId('lang').textContent).toBe('es');
  });

  it('works without a provider (English fallback)', () => {
    render(<Probe />);
    expect(screen.getByTestId('greeting').textContent).toBe('Hey Maria 👋');
  });
});
