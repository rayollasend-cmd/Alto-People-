import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CaptureResult, PostHog } from 'posthog-js';

let native = false;
vi.mock('@/lib/native/platform', () => ({
  isNative: () => native,
  nativePlatform: () => (native ? 'ios' : null),
}));
vi.mock('posthog-js/dist/posthog-recorder', () => ({}));

type Analytics = typeof import('@/lib/analytics');
let a: Analytics;

beforeEach(async () => {
  native = false;
  vi.resetModules();
  window.history.replaceState(null, '', '/');
  a = await import('@/lib/analytics');
});

function fakeClient() {
  let recording = false;
  return {
    register: vi.fn(),
    identify: vi.fn(),
    reset: vi.fn(),
    set_config: vi.fn(),
    setPersonProperties: vi.fn(),
    sessionRecordingStarted: vi.fn(() => recording),
    startSessionRecording: vi.fn(() => {
      recording = true;
    }),
    stopSessionRecording: vi.fn(() => {
      recording = false;
    }),
  };
}

const staff = { id: 'u-1', role: 'OPERATIONS_MANAGER' as const, tenantId: 't-1' };
const associate = { id: 'u-2', role: 'ASSOCIATE' as const, tenantId: 't-1' };

function event(props: Record<string, unknown>, extra: Partial<CaptureResult> = {}): CaptureResult {
  return { uuid: 'e', event: '$pageview', properties: props, ...extra } as CaptureResult;
}

describe('what is tracked and recorded', () => {
  it('never tracks the hotline or the kiosk', () => {
    expect(a.isUntrackedPath('/hotline')).toBe(true);
    expect(a.isUntrackedPath('/hotline/acme')).toBe(true);
    expect(a.isUntrackedPath('/kiosk')).toBe(true);
    expect(a.isUntrackedPath('/time-attendance/kiosk')).toBe(true);
    expect(a.isUntrackedPath('/hotline-admin')).toBe(false);
    expect(a.isUntrackedPath('/people')).toBe(false);
  });

  it('never records pay, tax, bank, ID, document, case or message pages', () => {
    for (const p of [
      '/payroll',
      '/payroll/runs/r1/summary',
      '/compensation',
      '/books/bank/b1',
      '/me/pay-notices/n1',
      '/onboarding/me/app-1/tasks/direct_deposit',
      '/onboarding/applications/app-1',
      '/people/a-1',
      '/documents',
      '/hr-cases',
      '/messages/m1',
      '/hotline-admin',
      '/offer/tok123',
      '/admin/billing',
    ]) {
      expect(a.isPrivatePath(p), p).toBe(true);
    }
    for (const p of ['/', '/people', '/scheduling', '/clients/c1', '/onboarding', '/recruiting']) {
      expect(a.isPrivatePath(p), p).toBe(false);
    }
  });

  it('records office roles only, and never in the phone app', () => {
    expect(a.canRecord('OPERATIONS_MANAGER', false)).toBe(true);
    expect(a.canRecord('INTERNAL_RECRUITER', false)).toBe(true);
    expect(a.canRecord('OPERATIONS_MANAGER', true)).toBe(false);
    expect(a.canRecord('ASSOCIATE', false)).toBe(false);
    expect(a.canRecord('DRIVER', false)).toBe(false);
    expect(a.canRecord('CLIENT_PORTAL', false)).toBe(false);
  });
});

describe('scrubbing', () => {
  it('drops query strings except campaign tags, drops the hash, masks secret links', () => {
    expect(a.scrubUrl('https://people.altohr.com/people?q=Jane%20Doe#top')).toBe('https://people.altohr.com/people');
    expect(a.scrubUrl('https://people.altohr.com/careers?utm_source=indeed&email=a@b.c')).toBe(
      'https://people.altohr.com/careers?utm_source=indeed',
    );
    expect(a.scrubUrl('https://people.altohr.com/offer/abc123secret')).toBe('https://people.altohr.com/offer/:token');
    expect(a.scrubUrl('not a url')).toBe('not a url');
  });

  it("drops an untracked page's events entirely", () => {
    expect(a.scrubEvent(event({ $current_url: 'https://people.altohr.com/hotline/acme' }))).toBeNull();
    expect(a.scrubEvent(event({ $pathname: '/kiosk' }))).toBeNull();
  });

  it('forgets that the previous page was the hotline', () => {
    const out = a.scrubEvent(
      event({
        $current_url: 'https://people.altohr.com/careers',
        $prev_pageview_pathname: '/hotline/acme',
        $prev_pageview_duration: 42,
        $referrer: 'https://people.altohr.com/hotline/acme',
      }),
    )!;
    const p = out.properties as Record<string, unknown>;
    expect(p.$current_url).toBe('https://people.altohr.com/careers');
    expect(p.$prev_pageview_pathname).toBeUndefined();
    expect(p.$prev_pageview_duration).toBeUndefined();
    expect(p.$referrer).toBeNull();
  });

  it('scrubs every URL an event carries and drops the page title', () => {
    const out = a.scrubEvent(
      event(
        {
          $current_url: 'https://people.altohr.com/people?search=Jane',
          $pathname: '/reset-password/s3cret',
          title: 'Jane Doe · Alto',
          $referrer: 'https://people.altohr.com/people?search=Jane',
          $heatmap_data: { 'https://people.altohr.com/people?search=Jane': [{ x: 1 }] },
          $web_vitals_LCP_event: { $current_url: 'https://people.altohr.com/people?search=Jane' },
        },
        { $set_once: { $initial_current_url: 'https://people.altohr.com/login?next=%2Fpeople%3Fq%3DJane' } },
      ),
    )!;
    const p = out.properties as Record<string, unknown>;
    expect(p.$current_url).toBe('https://people.altohr.com/people');
    expect(p.$pathname).toBe('/reset-password/:token');
    expect(p.title).toBeUndefined();
    expect(p.$referrer).toBe('https://people.altohr.com/people');
    expect(Object.keys(p.$heatmap_data as object)).toEqual(['https://people.altohr.com/people']);
    expect((p.$web_vitals_LCP_event as Record<string, unknown>).$current_url).toBe('https://people.altohr.com/people');
    expect(out.$set_once?.$initial_current_url).toBe('https://people.altohr.com/login');
  });

  it('is wired into the config, with the relay and the masking switched on', () => {
    expect(a.POSTHOG_CONFIG.before_send).toBe(a.scrubEvent);
    expect(a.POSTHOG_CONFIG.api_host).toBe('/api/ux');
    expect(a.POSTHOG_CONFIG.disable_external_dependency_loading).toBe(true);
    expect(a.POSTHOG_CONFIG.persistence).toBe('memory');
    expect(a.POSTHOG_CONFIG.mask_all_text).toBe(true);
    expect(a.POSTHOG_CONFIG.mask_all_element_attributes).toBe(true);
    expect(a.POSTHOG_CONFIG.disable_session_recording).toBe(true);
    expect(a.POSTHOG_CONFIG.session_recording).toMatchObject({ maskAllInputs: true, maskTextSelector: '*' });
  });
});

describe('the client', () => {
  it('identifies by id, role and company only, and remembers the browser only once signed in', () => {
    const c = fakeClient();
    a.attachAnalyticsClient(c as unknown as PostHog);
    a.setAnalyticsUser(staff);

    expect(c.set_config).toHaveBeenCalledWith({ persistence: 'localStorage' });
    expect(c.identify).toHaveBeenCalledWith('u-1', { role: 'OPERATIONS_MANAGER', tenant_id: 't-1' });

    a.setAnalyticsUser(null);
    expect(c.reset).toHaveBeenCalled();
    expect(c.set_config).toHaveBeenLastCalledWith({ persistence: 'memory' });
  });

  it('updates the role when the same person switches hats', () => {
    const c = fakeClient();
    a.attachAnalyticsClient(c as unknown as PostHog);
    a.setAnalyticsUser(staff);
    a.setAnalyticsUser({ ...staff, role: 'DRIVER' });

    expect(c.identify).toHaveBeenCalledTimes(1);
    expect(c.setPersonProperties).toHaveBeenCalledWith({ role: 'DRIVER', tenant_id: 't-1' });
  });

  it('records office staff, and stops on a private page', async () => {
    const c = fakeClient();
    a.attachAnalyticsClient(c as unknown as PostHog);
    a.setAnalyticsUser(staff);
    await vi.waitFor(() => expect(c.startSessionRecording).toHaveBeenCalledTimes(1));

    a.setAnalyticsPath('/payroll/runs/r1');
    expect(c.stopSessionRecording).toHaveBeenCalledTimes(1);

    a.setAnalyticsPath('/scheduling');
    await vi.waitFor(() => expect(c.startSessionRecording).toHaveBeenCalledTimes(2));
  });

  it('stops a recording that was asked for but had not begun when a private page opens', async () => {
    const c = fakeClient();
    // PostHog is still waiting on the project's settings: asked, not started.
    c.startSessionRecording.mockImplementation(() => {});
    a.attachAnalyticsClient(c as unknown as PostHog);
    a.setAnalyticsUser(staff);
    await vi.waitFor(() => expect(c.startSessionRecording).toHaveBeenCalled());

    a.setAnalyticsPath('/people/a-1');
    expect(c.stopSessionRecording).toHaveBeenCalledTimes(1);
  });

  it('never records an associate, or anyone in the phone app', async () => {
    const c = fakeClient();
    a.attachAnalyticsClient(c as unknown as PostHog);
    a.setAnalyticsUser(associate);
    native = true;
    a.setAnalyticsUser({ ...staff, id: 'u-3' });
    a.setAnalyticsPath('/scheduling');
    await new Promise((r) => setTimeout(r, 20));

    expect(c.startSessionRecording).not.toHaveBeenCalled();
    expect(c.register).toHaveBeenCalledWith({ platform: 'web' });
  });

  it('does nothing without a key', () => {
    const add = vi.spyOn(window, 'addEventListener');
    a.initAnalytics();
    expect(add).not.toHaveBeenCalledWith('load', expect.anything(), expect.anything());
  });
});
