import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(async () => ({ statusPageUrl: null, contact: { email: 'info@altohr.com', phone: '(850) 805-3774', hours: 'Mon–Fri, 8 AM – 5 PM Central' } })),
}));
import { AccessibilityPage, languagesSentence } from '@/pages/trust/AccessibilityPage';

/** The accessibility statement (F500 G5): a direct line anyone can use, and the languages from the one list. */
describe('the accessibility statement', () => {
  it('names the languages the app ships, from LANGS', () => {
    expect(languagesSentence()).toBe(
      'The screens a frontline worker uses are available in English, Spanish, Turkish, Haitian Creole, Portuguese and Ukrainian.',
    );
  });

  it('gives a direct email and phone with hours — not only "the Help menu or your account team"', async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <AccessibilityPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const line = await screen.findByTestId('a11y-contact-line');
    expect(within(line).getByRole('link', { name: 'info@altohr.com' })).toHaveAttribute('href', 'mailto:info@altohr.com?subject=Accessibility');
    expect(within(line).getByRole('link', { name: /805-3774/ })).toHaveAttribute('href', expect.stringMatching(/^tel:/));
    expect(line).toHaveTextContent('Mon–Fri, 8 AM – 5 PM Central');
    expect(screen.getByText(/Statement dated Oct 15, 2026/)).toBeInTheDocument();
  });
});
