import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderAs } from '../hrPack/harness';

vi.mock('@/lib/docTemplatesApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/docTemplatesApi')>()),
  listTemplates: vi.fn(),
  createTemplate: vi.fn(),
  saveVersion: vi.fn(),
  listVersions: vi.fn().mockResolvedValue({ versions: [] }),
}));

import { createTemplate, listTemplates, saveVersion } from '@/lib/docTemplatesApi';
import { STARTER_TEMPLATES, TemplatesHome } from '@/pages/templates/TemplatesHome';

/**
 * F500 G4 · /templates: "New template" is the header's action (not a row
 * under it), and an empty page offers starters — each becomes a draft
 * that opens in the editor.
 */
beforeEach(() => {
  vi.mocked(listTemplates).mockReset().mockResolvedValue({ templates: [] });
  vi.mocked(createTemplate).mockReset().mockResolvedValue({ id: 't1' });
  vi.mocked(saveVersion).mockReset().mockResolvedValue({ id: 'v1', version: 1 });
});

describe('Document templates', () => {
  it('puts New template in the header', async () => {
    renderAs('HR_ADMINISTRATOR', <TemplatesHome />, '/templates');
    const actions = await screen.findByTestId('page-actions');
    expect(within(actions).getByRole('button', { name: /New template/ })).toBeInTheDocument();
  });

  it('an empty page offers starters; one becomes a draft and opens in the editor', async () => {
    renderAs('HR_ADMINISTRATOR', <TemplatesHome />, '/templates');
    expect(await screen.findByText('No templates yet')).toBeInTheDocument();
    for (const s of STARTER_TEMPLATES) expect(screen.getByRole('button', { name: new RegExp(s.name) })).toBeInTheDocument();
    vi.mocked(listTemplates).mockResolvedValue({
      templates: [{ id: 't1', name: 'Offer letter', kind: 'OFFER_LETTER', currentVersion: null, versionCount: 1, renderCount: 0 } as never],
    });
    await userEvent.click(screen.getByRole('button', { name: /Offer letter/ }));
    await waitFor(() => expect(createTemplate).toHaveBeenCalledWith({ name: 'Offer letter', kind: 'OFFER_LETTER' }));
    const [id, version] = vi.mocked(saveVersion).mock.calls[0]!;
    expect(id).toBe('t1');
    expect(version.body).toContain('{{ associate.firstName }}');
    // Only tokens a render can fill: associate fields, nothing else in braces.
    for (const s of STARTER_TEMPLATES) {
      const tokens = [...`${s.subject}\n${s.body}`.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].map((m) => m[1]);
      expect(tokens.every((tk) => tk!.startsWith('associate.')), s.key).toBe(true);
    }
    // The editor opens on the new draft.
    expect(await screen.findByText('Editor')).toBeInTheDocument();
  });
});
