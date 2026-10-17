import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import { ASSISTANT_NAME_PROMPT, type OrgBranding } from '@alto-people/shared';
import { DEFAULT_TENANT } from '@/lib/auth';
import { renderAsAdmin } from './orgAdminHarness';

vi.mock('@/lib/brandingApi', () => ({ getOrgBranding: vi.fn(), patchOrgBranding: vi.fn(), uploadOrgLogo: vi.fn(), deleteOrgLogo: vi.fn() }));
vi.mock('@/lib/confirm', () => ({ useConfirm: () => vi.fn().mockResolvedValue(true), usePrompt: () => vi.fn() }));

import { getOrgBranding } from '@/lib/brandingApi';
import { BrandingHome } from '@/pages/admin/BrandingHome';

const branding = (assistantName: string): OrgBranding => ({
  orgName: 'Coastal Resort',
  assistantName,
  activeWindowDays: 14,
  weekStartsOn: 6,
  timezone: 'America/New_York',
  senderName: null,
  supportEmail: null,
  primaryColor: null,
  logoUrl: null,
  logoUpdatedAt: null,
  mfaRequirement: 'OFF',
  financeMailbox: null,
  unverifiedPayoutPolicy: 'PREVIOUS_VERIFIED',
  updatedAt: new Date(0).toISOString(),
});

beforeEach(() => {
  vi.mocked(getOrgBranding).mockReset();
});

describe('Branding: the assistant\'s name', () => {
  it('the field carries each tenant\'s own name, and the prompt never names a fixed one', async () => {
    vi.mocked(getOrgBranding).mockResolvedValue(branding('Coco'));
    renderAsAdmin(<BrandingHome />, '/', { ...DEFAULT_TENANT, assistantName: 'Coco' });
    const coco = (await screen.findByLabelText(ASSISTANT_NAME_PROMPT)) as HTMLInputElement;
    await waitFor(() => expect(coco.value).toBe('Coco'));
    expect(screen.getByText(/I'm the AI assistant in Alto People\./)).toBeInTheDocument();
    expect(screen.queryByText(/Hugo/)).toBeNull();
    cleanup();

    vi.mocked(getOrgBranding).mockResolvedValue(branding('Max'));
    renderAsAdmin(<BrandingHome />, '/', { ...DEFAULT_TENANT, assistantName: 'Max' });
    const max = (await screen.findByLabelText(ASSISTANT_NAME_PROMPT)) as HTMLInputElement;
    await waitFor(() => expect(max.value).toBe('Max'));
    expect(screen.queryByText(/Hugo/)).toBeNull();
  });
});
