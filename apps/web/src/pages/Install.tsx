import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Apple, Smartphone, Share, MoreVertical, Plus, Download, ChevronRight, ShieldCheck } from '@/components/ui/icons';
import { AuthCardTitle, AuthShell } from '@/components/ui/AuthHeading';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { QR_COLORS } from '@/lib/qrColors';
import { useI18n } from '@/lib/i18n';
import '@/lib/i18n/en/install';

/** "Tap the {icon} Share button": a sentence with an icon in it, in any word order. */
function withIcon(text: string, icon: React.ReactNode): React.ReactNode {
  const [before, after] = text.split('{icon}');
  return (
    <>
      {before}
      {icon}
      {after}
    </>
  );
}

type Platform = 'ios' | 'android' | 'desktop';

function detectPlatform(): Platform {
  if (typeof window === 'undefined') return 'desktop';
  const ua = navigator.userAgent || navigator.vendor || '';
  // iPad on iPadOS 13+ pretends to be macOS — check for touch points to catch it.
  const isIPadOS =
    /Macintosh/.test(ua) && typeof navigator.maxTouchPoints === 'number' && navigator.maxTouchPoints > 1;
  if (/iPhone|iPad|iPod/i.test(ua) || isIPadOS) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  return 'desktop';
}

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    // iOS Safari sets navigator.standalone when the app is launched from
    // the home screen.
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export function Install() {
  const { t } = useI18n();
  const [platform, setPlatform] = useState<Platform>('desktop');
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    setPlatform(detectPlatform());
    setInstalled(isStandalone());
  }, []);

  if (installed) {
    return (
      <Page>
        <div className="text-center">
          <ShieldCheck className="mx-auto h-12 w-12 text-success mb-4" />
          <AuthCardTitle size="md">{t('install.page.allSet')}</AuthCardTitle>
          <p className="text-silver mb-6">{t('install.page.already')}</p>
          <Link
            to="/"
            className="btn-gold inline-flex items-center gap-2 px-4 py-2.5 rounded-md text-navy font-medium"
          >
            {t('install.page.openApp')} <ChevronRight className="h-4 w-4" />
          </Link>
        </div>
      </Page>
    );
  }

  return (
    <Page>
      <header className="text-center mb-8">
        <AuthCardTitle>{t('install.page.title')}</AuthCardTitle>
        <p className="text-silver text-sm sm:text-base max-w-md mx-auto">
          {t('install.page.intro')}
        </p>
      </header>

      {platform === 'ios' && <IosInstructions />}
      {platform === 'android' && <AndroidInstructions />}
      {platform === 'desktop' && <DesktopInstructions />}

      <div className="mt-10 pt-6 border-t border-navy-secondary text-center">
        <p className="text-xs text-silver mb-3">{t('install.page.haveAccount')}</p>
        <Link
          to="/login"
          className="inline-flex items-center gap-1.5 text-gold hover:underline text-sm"
        >
          {t('login.signIn')} <ChevronRight className="h-3.5 w-3.5" />
        </Link>
      </div>
    </Page>
  );
}

function IosInstructions() {
  const { t } = useI18n();
  return (
    <Section icon={Apple} title={t('install.page.ios')}>
      <Step n={1} title={t('install.page.ios1')} body={t('install.page.ios1Body')} />
      <Step
        n={2}
        title={withIcon(t('install.page.ios2'), <Share className="inline h-4 w-4 mx-1 align-text-bottom" />)}
        body={t('install.page.ios2Body')}
      />
      <Step n={3} title={t('install.page.ios3')} body={t('install.page.ios3Body')} />
      <Step n={4} title={t('install.page.ios4')} body={t('install.page.ios4Body')} />
    </Section>
  );
}

function AndroidInstructions() {
  const { t } = useI18n();
  return (
    <Section icon={Smartphone} title={t('install.page.android')}>
      <Step n={1} title={t('install.page.and1')} body={t('install.page.and1Body')} />
      <Step
        n={2}
        title={withIcon(t('install.page.and2'), <MoreVertical className="inline h-4 w-4 mx-1 align-text-bottom" />)}
        body={t('install.page.and2Body')}
      />
      <Step
        n={3}
        title={withIcon(t('install.page.and3'), <Plus className="inline h-4 w-4 mx-1 align-text-bottom" />)}
        body={t('install.page.and3Body')}
      />
      <Step n={4} title={t('install.page.and4')} body={t('install.page.and4Body')} />
    </Section>
  );
}

/** The page's own address as a QR code, so a desktop visitor can open it on their phone. */
function useQrDataUrl(value: string): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    // The app's QR encoder (the same one the badge and the wallet use), loaded only here.
    void import('qrcode')
      .then(({ default: QRCode }) => QRCode.toDataURL(value, { margin: 1, width: 200, errorCorrectionLevel: 'M', color: QR_COLORS }))
      .then((u) => {
        if (live) setUrl(u);
      })
      .catch(() => {
        if (live) setUrl(null);
      });
    return () => {
      live = false;
    };
  }, [value]);
  return url;
}

function DesktopInstructions() {
  // On a desktop nothing is "above": say what to do, and give the phone a way here (F500 G5).
  const pageUrl = typeof window !== 'undefined' ? `${window.location.origin}/install` : '/install';
  const qr = useQrDataUrl(pageUrl);
  const { t } = useI18n();
  const [goBefore, goAfter] = t('install.page.deskGo').split('{url}');
  return (
    <Section icon={Download} title={t('install.page.desktop')}>
      <li className="flex list-none flex-col items-center gap-4 sm:flex-row sm:items-start">
        <div className="grid h-[136px] w-[136px] shrink-0 place-items-center rounded-lg bg-white p-2" data-testid="install-qr">
          {qr ? <img src={qr} alt={t('install.page.qrAlt', { url: pageUrl })} className="h-full w-full" /> : null}
        </div>
        <div>
          <p className="text-ink text-sm font-medium mb-1">{t('install.page.deskOpen')}</p>
          <p className="text-silver text-sm mb-3">
            {goBefore}<span className="text-ink">{pageUrl.replace(/^https?:\/\//, '')}</span>{goAfter}
          </p>
          <p className="text-silver text-xs">{t('install.page.deskBrowser')}</p>
        </div>
      </li>
    </Section>
  );
}

/** The signed-out lockup every auth page wears, around the install guide's wider card. */
function Page({ children }: { children: React.ReactNode }) {
  return (
    <AuthShell wide>
      <div className="bg-navy/80 backdrop-blur border border-navy-secondary rounded-2xl elev-2 p-6 sm:p-8">{children}</div>
    </AuthShell>
  );
}

function Section({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof Apple;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-navy-secondary bg-navy-secondary/20 p-5">
      <SectionTitle icon={Icon} title={title} className="mb-4" />
      <ol className="space-y-4">{children}</ol>
    </section>
  );
}

function Step({ n, title, body }: { n: number; title: React.ReactNode; body: string }) {
  return (
    <li className="flex gap-3">
      <span className="flex-shrink-0 inline-flex h-6 w-6 items-center justify-center rounded-full bg-gold text-navy text-xs font-semibold">
        {n}
      </span>
      <div>
        <div className="text-white text-sm font-medium leading-tight mb-1">{title}</div>
        <p className="text-silver text-xs leading-relaxed">{body}</p>
      </div>
    </li>
  );
}

export default Install;
