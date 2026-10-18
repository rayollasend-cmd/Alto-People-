import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Alto People — the native shell (iOS + Android).
 *
 * The app loads the real web app from its own origin (`server.url`), so
 * every page, cookie, photo and PDF works exactly as in the browser, and a
 * web deploy updates the app at once. The bundled `www/` holds only the
 * branded offline page shown when the network is down on first launch
 * (`server.errorPath`); after that the web app's own offline cache and
 * queue carry on.
 *
 * One config, three environments — pick with APP_ENV when syncing:
 *   APP_ENV=production npx cap sync    (default)
 *   APP_ENV=staging    npx cap sync
 *   APP_ENV=dev        APP_DEV_URL=http://192.168.1.20:5173 npx cap sync
 */

type Env = 'production' | 'staging' | 'dev';
const env = ((process.env.APP_ENV as Env | undefined) ?? 'production') as Env;

const ENVIRONMENTS: Record<Env, { appId: string; appName: string; url: string }> = {
  production: {
    appId: 'com.altohr.people',
    appName: 'Alto People',
    url: process.env.APP_URL ?? 'https://app.altohr.com',
  },
  staging: {
    appId: 'com.altohr.people.staging',
    appName: 'Alto People (Staging)',
    url: process.env.APP_URL ?? 'https://staging.altohr.com',
  },
  dev: {
    appId: 'com.altohr.people.dev',
    appName: 'Alto People (Dev)',
    url: process.env.APP_DEV_URL ?? 'http://localhost:5173',
  },
};

const current = ENVIRONMENTS[env];
const host = new URL(current.url).host;

const config: CapacitorConfig = {
  appId: current.appId,
  appName: current.appName,
  webDir: 'www',
  server: {
    url: current.url,
    // A dev server on the LAN is plain http; production never is.
    cleartext: env === 'dev',
    // The bundled offline page when the first load can't reach the server.
    errorPath: 'offline.html',
    // Only our own host loads inside the app; anything else (an IdP, a
    // help article, a Wallet link) opens in the system browser.
    allowNavigation: [host],
    androidScheme: 'https',
  },
  ios: {
    // Service workers (the web app's offline cache) need app-bound domains.
    limitsNavigationsToAppBoundDomains: true,
    contentInset: 'never',
    scheme: 'Alto People',
    backgroundColor: '#0f1827',
  },
  android: {
    backgroundColor: '#0f1827',
    allowMixedContent: env === 'dev',
  },
  plugins: {
    SplashScreen: {
      // Held until the web app knows who's signed in (NativeBridge hides it).
      launchAutoHide: false,
      backgroundColor: '#0f1827',
      showSpinner: false,
      androidScaleType: 'CENTER_CROP',
      splashFullScreen: true,
      splashImmersive: false,
    },
    StatusBar: {
      overlaysWebView: true,
      style: 'DARK',
    },
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
    CapacitorNfc: {},
  },
};

export default config;
