import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Apple, Smartphone, Share, MoreVertical, Plus, Download, ChevronRight, ShieldCheck } from 'lucide-react';

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
          <h1 className="text-2xl font-medium text-white mb-2">You're all set</h1>
          <p className="text-silver mb-6">Alto People is already installed on this device.</p>
          <Link
            to="/"
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-md bg-gold text-navy hover:bg-gold-bright transition font-medium"
          >
            Open the app <ChevronRight className="h-4 w-4" />
          </Link>
        </div>
      </Page>
    );
  }

  return (
    <Page>
      <header className="text-center mb-8">
        <div className="inline-flex h-16 w-16 items-center justify-center rounded-2xl bg-navy border border-gold/40 mb-4">
          <span className="font-serif text-3xl text-gold tracking-tight">AP</span>
        </div>
        <h1 className="text-2xl sm:text-3xl font-medium text-white mb-2">
          Install Alto People
        </h1>
        <p className="text-silver text-sm sm:text-base max-w-md mx-auto">
          Add Alto People to your home screen for one-tap access — your schedule,
          pay stubs, time off, and onboarding tasks, always a tap away.
        </p>
      </header>

      {platform === 'ios' && <IosInstructions />}
      {platform === 'android' && <AndroidInstructions />}
      {platform === 'desktop' && <DesktopInstructions />}

      <div className="mt-10 pt-6 border-t border-navy-secondary text-center">
        <p className="text-xs text-silver mb-3">Already have an account?</p>
        <Link
          to="/login"
          className="inline-flex items-center gap-1.5 text-gold hover:underline text-sm"
        >
          Sign in <ChevronRight className="h-3.5 w-3.5" />
        </Link>
      </div>
    </Page>
  );
}

function IosInstructions() {
  return (
    <Section icon={Apple} title="On your iPhone or iPad">
      <Step
        n={1}
        title="Open this page in Safari"
        body="Other browsers can't add to the home screen on iOS. If you opened this in Chrome or another app, tap the address bar and pick Open in Safari."
      />
      <Step
        n={2}
        title={<>Tap the <Share className="inline h-4 w-4 mx-1 align-text-bottom" /> Share button</>}
        body="It's at the bottom of the screen on iPhone, top-right on iPad."
      />
      <Step
        n={3}
        title="Scroll down and tap Add to Home Screen"
        body="It's in the second group of options, alongside Print, Find on Page, etc."
      />
      <Step
        n={4}
        title="Tap Add"
        body="The Alto People icon appears on your home screen. Tap it to launch."
      />
    </Section>
  );
}

function AndroidInstructions() {
  return (
    <Section icon={Smartphone} title="On your Android phone">
      <Step
        n={1}
        title="Open this page in Chrome"
        body="Chrome handles installs best on Android. Other browsers may work, but instructions vary."
      />
      <Step
        n={2}
        title={<>Tap the <MoreVertical className="inline h-4 w-4 mx-1 align-text-bottom" /> menu (three dots, top-right)</>}
        body="You may instead see a banner near the bottom that says 'Install app' — tap it directly."
      />
      <Step
        n={3}
        title={<>Tap <Plus className="inline h-4 w-4 mx-1 align-text-bottom" /> Install app or Add to Home screen</>}
        body="The label depends on your Chrome version. Both end up the same way."
      />
      <Step
        n={4}
        title="Confirm"
        body="The Alto People icon appears on your home screen and in your app drawer."
      />
    </Section>
  );
}

function DesktopInstructions() {
  return (
    <Section icon={Download} title="On a desktop browser">
      <p className="text-silver text-sm mb-4">
        You're on a desktop browser. The install instructions above are for
        phones — open this page on your iPhone or Android phone to add the app
        to your home screen.
      </p>
      <p className="text-silver text-sm">
        On Chrome / Edge / Brave on desktop, you can also click the install
        icon (a small monitor with a down arrow) in the address bar to install
        Alto People as a desktop app.
      </p>
    </Section>
  );
}

function Page({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-start sm:items-center justify-center px-4 py-10 bg-login-aurora">
      <div className="w-full max-w-xl bg-navy/80 backdrop-blur border border-navy-secondary rounded-2xl shadow-xl p-6 sm:p-8">
        {children}
      </div>
    </div>
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
      <div className="flex items-center gap-2 mb-4">
        <Icon className="h-5 w-5 text-gold" />
        <h2 className="text-white font-medium">{title}</h2>
      </div>
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
