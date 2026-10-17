import { apiFetch } from './api';

/** Marketing: the careers funnel, the employer brand, referral campaigns and bonuses. */

export interface SourceFunnelRow {
  source: string | null;
  views: number;
  applicants: number;
  interviewed: number;
  hires: number;
  viewToApplyPct: number | null;
  applyToHirePct: number | null;
  spend: number | null;
  costPerHire: number | null;
  retained90Pct: number | null;
}

export interface MarketingOverview {
  range: { from: string; to: string };
  funnel: { views: number; applicants: number; interviewed: number; hires: number };
  bySource: SourceFunnelRow[];
  byPosting: Array<{ slug: string; title: string; status: string; views: number; applicants: number; hires: number }>;
  weekly: Array<{ weekStart: string; views: number; applicants: number; hires: number }>;
  campaigns: { active: number; referrals: number; referralHires: number; bonusesProposed: number; bonusesApproved: number };
}

export const getMarketingOverview = (range: { from: string; to: string }) =>
  apiFetch<MarketingOverview>(`/marketing/overview?from=${range.from}&to=${range.to}`);

export interface EmployerBrand {
  headline: string | null;
  intro: string | null;
  values: Array<{ title: string; body: string }>;
  perks: string[];
  ctaText: string | null;
  photos: Array<{ id: string; alt: string; url: string }>;
  updatedAt: string | null;
}

export const getEmployerBrand = () => apiFetch<EmployerBrand>('/marketing/brand');

export const saveEmployerBrand = (input: Partial<Omit<EmployerBrand, 'photos' | 'updatedAt'>>) =>
  apiFetch<EmployerBrand>('/marketing/brand', { method: 'PUT', body: input });

/** Photos go up as multipart — apiFetch JSON-encodes bodies, so this uses fetch directly. */
export async function uploadBrandPhoto(file: File, alt: string): Promise<{ id: string; alt: string; url: string }> {
  const form = new FormData();
  form.append('file', file);
  form.append('alt', alt);
  const res = await fetch('/api/marketing/brand/photos', { method: 'POST', body: form, credentials: 'include' });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message ?? `Upload failed (${res.status})`);
  }
  return (await res.json()) as { id: string; alt: string; url: string };
}

export const removeBrandPhoto = (id: string) => apiFetch<void>(`/marketing/brand/photos/${id}`, { method: 'DELETE' });

export interface ReferralCampaign {
  id: string;
  name: string;
  description: string | null;
  bonusAmount: number;
  currency: string;
  payAfterDays: number;
  startsOn: string;
  endsOn: string | null;
  positions: string[];
  status: 'DRAFT' | 'ACTIVE' | 'CLOSED';
  referrals: number;
  payouts: number;
  createdAt: string;
}

export interface CampaignInput {
  name: string;
  description?: string | null;
  bonusAmount: number;
  payAfterDays?: number;
  startsOn: string;
  endsOn?: string | null;
  positions?: string[];
}

export const listCampaigns = () => apiFetch<{ campaigns: ReferralCampaign[] }>('/marketing/campaigns');
export const createCampaign = (input: CampaignInput) => apiFetch<ReferralCampaign>('/marketing/campaigns', { method: 'POST', body: input });
export const updateCampaign = (id: string, input: Partial<CampaignInput>) =>
  apiFetch<ReferralCampaign>(`/marketing/campaigns/${id}`, { method: 'PATCH', body: input });
export const setCampaignStatus = (id: string, status: 'ACTIVE' | 'CLOSED') =>
  apiFetch<ReferralCampaign>(`/marketing/campaigns/${id}/status`, { method: 'POST', body: { status } });

export interface CampaignReferral {
  id: string;
  referrerName: string;
  referrerHasPayroll: boolean;
  candidateId: string | null;
  candidateName: string;
  position: string | null;
  status: 'OPEN' | 'INTERVIEWING' | 'HIRED' | 'REJECTED';
  candidateStage: string | null;
  hiredAt: string | null;
  campaign: { id: string; name: string; bonusAmount: number } | null;
  bonusAmount: number | null;
  eligibleOn: string | null;
  eligible: boolean;
  payout: { id: string; status: 'PROPOSED' | 'APPROVED' | 'DECLINED'; amount: number; decidedAt: string | null; attached: boolean } | null;
  createdAt: string;
}

export const listCampaignReferrals = (campaignId?: string) =>
  apiFetch<{ referrals: CampaignReferral[] }>(`/marketing/referrals${campaignId ? `?campaignId=${campaignId}` : ''}`);

export const proposeReferralBonus = (referralId: string, force = false) =>
  apiFetch<{ payoutId: string; created: boolean }>(`/marketing/referrals/${referralId}/propose-bonus`, { method: 'POST', body: { force } });

export interface BonusPayout {
  id: string;
  status: 'PROPOSED' | 'APPROVED' | 'DECLINED';
  amount: number;
  currency: string;
  referrerName: string;
  referrerEmail: string;
  candidateName: string;
  campaignName: string | null;
  note: string | null;
  decisionNote: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  payrollRunId: string | null;
  createdAt: string;
}

export interface DraftRun {
  id: string;
  periodStart: string;
  periodEnd: string;
  kind: string;
}

export const listBonusPayouts = (status?: BonusPayout['status']) =>
  apiFetch<{ payouts: BonusPayout[]; draftRuns: DraftRun[] }>(`/marketing/bonus-payouts${status ? `?status=${status}` : ''}`);

export const decideBonusPayout = (id: string, input: { decision: 'APPROVE' | 'DECLINE'; note?: string | null; payrollRunId?: string | null }) =>
  apiFetch<BonusPayout>(`/marketing/bonus-payouts/${id}/decide`, { method: 'POST', body: input });

export const attachBonusPayout = (id: string, payrollRunId: string) =>
  apiFetch<BonusPayout>(`/marketing/bonus-payouts/${id}/attach`, { method: 'POST', body: { payrollRunId } });
