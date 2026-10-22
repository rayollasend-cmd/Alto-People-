import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { renderAs } from './hrPack/harness';
import { ApiError } from '@/lib/api';

vi.mock('@/lib/trustApi', () => ({ getTrust: vi.fn() }));
vi.mock('@/lib/accessCertificationsApi', () => ({
  certificationExportUrl: vi.fn(),
  closeCertification: vi.fn(),
  decideCertificationItem: vi.fn(),
  getCertification: vi.fn(),
  listCertifications: vi.fn(),
  openCertification: vi.fn(),
}));
vi.mock('@/lib/onboardingApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/onboardingApi')>()),
  listEsignAgreements: vi.fn(),
  signEsignAgreement: vi.fn(),
  getApplication: vi.fn(() => new Promise(() => {})),
}));

import { getTrust } from '@/lib/trustApi';
import { getCertification } from '@/lib/accessCertificationsApi';
import { listEsignAgreements } from '@/lib/onboardingApi';
import { TrustCenterPage } from '@/pages/trust/TrustCenterPage';
import { AccessCertificationPage } from '@/pages/admin/AccessCertifications';
import { EsignTask } from '@/pages/onboarding/tasks/EsignTask';

/**
 * Loading or failed, a page keeps its header — its name on the page and in
 * the top bar — and says what went wrong in plain words with a way to try
 * again (F500 G1/G4: an error banner alone, the bar reading "Alto People";
 * "Request failed (500)" above skeletons that kept pulsing).
 */

describe('a page that cannot load keeps its header', () => {
  it('Trust Center: the title stays over the error, and no server text', async () => {
    vi.mocked(getTrust).mockRejectedValue(new ApiError(500, 'internal', 'Request failed (500)'));
    renderAs('HR_ADMINISTRATOR', <TrustCenterPage />, '/trust');
    expect(screen.getByRole('heading', { level: 1, name: 'Trust Center' })).toBeInTheDocument();
    expect(await screen.findByText(/Something went wrong on our side/)).toBeInTheDocument();
    expect(screen.queryByText(/Request failed/)).not.toBeInTheDocument();
  });

  it('Trust Center while loading: the title is there before the numbers', () => {
    vi.mocked(getTrust).mockReturnValue(new Promise(() => {}));
    renderAs('HR_ADMINISTRATOR', <TrustCenterPage />, '/trust');
    expect(screen.getByRole('heading', { level: 1, name: 'Trust Center' })).toBeInTheDocument();
  });

  it('an access certification: a header while it loads, the plain error when it fails', async () => {
    vi.mocked(getCertification).mockRejectedValue(new ApiError(404, 'not_found', 'Certification not found'));
    renderAs(
      'HR_ADMINISTRATOR',
      <Routes>
        <Route path="/admin/access-certifications/:id" element={<AccessCertificationPage />} />
      </Routes>,
      '/admin/access-certifications/c1',
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Access certification' })).toBeInTheDocument();
    expect(await screen.findByText(/Couldn’t find this certification/)).toBeInTheDocument();
  });

  it('e-sign: a failed load says so with Retry, and the skeletons stop', async () => {
    vi.mocked(listEsignAgreements).mockRejectedValue(new ApiError(500, 'internal', 'Request failed (500)'));
    renderAs(
      'ASSOCIATE',
      <Routes>
        <Route path="/onboarding/me/:applicationId/tasks/e_sign" element={<EsignTask />} />
      </Routes>,
      '/onboarding/me/a1/tasks/e_sign',
    );
    const retry = await screen.findByRole('button', { name: 'Retry' });
    expect(screen.queryByText(/Request failed/)).not.toBeInTheDocument();
    expect(document.querySelector('[aria-busy="true"], .animate-pulse')).toBeNull();
    vi.mocked(listEsignAgreements).mockResolvedValue({ agreements: [] } as never);
    await userEvent.click(retry);
    await waitFor(() => expect(listEsignAgreements).toHaveBeenCalledTimes(2));
  });
});
