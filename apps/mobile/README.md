# Alto People — native apps (iOS and Android)

The phone apps for associates, drivers and field leads. One Capacitor shell
around the web app, plus what only a native app can do:

| | |
|---|---|
| **Every page** | The shell loads the live web app (`server.url`), so every screen, cookie, photo and PDF works as in the browser, and a web deploy updates the app at once. |
| **Push** | APNs (iOS) and FCM (Android). The phone registers on sign-in (`POST /devices`); the server sends through the same funnel as web push, after quiet hours and digest choices. We explain before the system prompt and never ask cold. |
| **Badge tap** | NFC: a worker taps their badge at a kiosk running in the app; HR writes badges from Kiosk → a person → Badge. |
| **Wallet** | An Apple Wallet / Google Wallet worker badge (Me → My credentials). Its QR is the same credential an NFC badge carries. |
| **Face ID lock** | Settings → Phones with the app → "Require Face ID to open the app". Locks on launch and after a minute away. Never replaces signing in. |
| **Stays signed in** | A device credential in the Keychain / Keystore (device-only, never backed up) re-opens a session the web view lost. It's revoked by sign-out, a password change, removing the phone, or its expiry (30 days, or the organization's session limit if shorter). |
| **Offline** | A branded offline page on first launch without a connection; after that the web app's own offline cache and queues (kiosk punches, checklist ticks, approvals) replay the moment the network returns or the app comes back to the front. |
| **SSO and passkeys** | Open in the system browser, then return to the app with a two-minute, single-use code (`/native-handoff` → `altopeople://auth/complete`). |

Code: this folder (shell, native projects, assets), `apps/web/src/lib/native/*`
and `components/native/*` (the bridge), `apps/api/src/routes/nativeApp.ts`,
`lib/nativePush.ts`, `lib/appleWallet.ts`, `lib/googleWallet.ts`,
`lib/badgeToken.ts`.

---

## Prerequisites

- Node 22+ and the repo's dependencies (`npm install` at the repo root).
- **iOS:** macOS, Xcode 16+, an Apple Developer account. The project uses
  Swift Package Manager — no CocoaPods.
- **Android:** Android Studio (Ladybug or newer), JDK 21, Android SDK 35.

## Environments

`capacitor.config.ts` picks the app id, name and the host it loads from
`APP_ENV`:

| `APP_ENV` | App id | Name | Loads |
|---|---|---|---|
| `production` (default) | `com.altohr.people` | Alto People | `APP_URL` or `https://app.altohr.com` |
| `staging` | `com.altohr.people.staging` | Alto People (Staging) | `APP_URL` or `https://staging.altohr.com` |
| `dev` | `com.altohr.people.dev` | Alto People (Dev) | `APP_DEV_URL` (e.g. `http://192.168.1.20:5173` — your machine on the LAN) |

```bash
cd apps/mobile
APP_ENV=staging npm run sync        # copies config + plugins into ios/ and android/
```

On iOS also set the bundle id and display name per scheme in Xcode (or with
a build configuration); on Android pass `APP_ID` and `APP_LINK_HOST` to Gradle
(see below).

## Run on a device

```bash
cd apps/mobile
npm run sync
npm run open:ios        # Xcode → pick your team under Signing & Capabilities → Run
npm run open:android    # Android Studio → Run
```

For a local web app: start `npm run dev` at the repo root, find your LAN IP,
then `APP_ENV=dev APP_DEV_URL=http://<ip>:5173 npm run sync`.

## Icons and splash

All sizes are generated from `resources/` (made from the brand emblem by
`scripts/brand-assets.mjs`):

```bash
node scripts/brand-assets.mjs   # only when the logo changes
npm run assets                  # every iOS / Android icon and splash size
```

## Push notifications

**iOS (APNs)** — developer.apple.com → Keys → new key with *Apple Push
Notifications service* → download the `.p8`. In Xcode add the *Push
Notifications* capability (the entitlements file already asks for it).
Server environment:

```
APNS_KEY_ID=…  APNS_TEAM_ID=…  APNS_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n…"
APNS_BUNDLE_ID=com.altohr.people   APNS_ENV=production   # sandbox for Xcode debug builds
```

**Android (FCM)** — Firebase console → add an Android app with the package
id → download `google-services.json` into `android/app/` (not committed).
Project settings → Service accounts → generate a key. Server environment:

```
FCM_PROJECT_ID=…  FCM_CLIENT_EMAIL=…  FCM_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n…"
```

Without these the server simply doesn't send to phones; web push is unaffected.

## Wallet passes

**Apple Wallet** — developer.apple.com → Identifiers → *Pass Type IDs* →
create `pass.com.altohr.people.badge` → create its certificate → export the
certificate and key as PEM. Download Apple's *WWDR G4* intermediate.

```
PASS_TYPE_ID=pass.com.altohr.people.badge  PASS_TEAM_ID=…
PASS_CERT_PEM="…"  PASS_KEY_PEM="…"  PASS_KEY_PASSPHRASE=…  PASS_WWDR_PEM="…"
```

**Google Wallet** — pay.google.com/business/console → Wallet API → note the
issuer id; Google Cloud → service account with the *Wallet Object Issuer*
role → JSON key.

```
GOOGLE_WALLET_ISSUER_ID=…  GOOGLE_WALLET_CLIENT_EMAIL=…  GOOGLE_WALLET_PRIVATE_KEY="…"
```

Until configured, "Add to Wallet" is hidden and the badge shows as an on-screen
QR (which the kiosk reads all the same).

## Universal links / app links

```bash
APPLE_TEAM_ID=… ANDROID_SHA256=… npm run well-known
```

writes `apps/web/public/.well-known/apple-app-site-association` and
`assetlinks.json`. Deploy the web app; both must be served from the app host
over HTTPS with `Content-Type: application/json` and no redirects. Then links
to `/rides`, `/me`, `/shifts`, `/track/…`, `/w/…`, `/candidate/…`, `/nps/…`
and `/inbox` open in the app when it's installed.

## Release builds

**iOS** — Xcode → set version and build number → Product → Archive →
Distribute App → App Store Connect. Make sure `aps-environment` resolves to
`production` (Xcode does this for distribution signing).

**Android**

```bash
cd android
APP_ID=com.altohr.people APP_LINK_HOST=app.altohr.com \
APP_VERSION_NAME=1.0.0 APP_VERSION_CODE=1 \
./gradlew bundleRelease
```

Sign with your upload key (Android Studio → Build → Generate Signed App
Bundle, or a `signingConfigs` block fed from CI secrets) and upload the
`.aab` to the Play Console.

## Store submission checklist

- [ ] App icons and splash generated (`npm run assets`) and checked on a notched iPhone and a gesture-nav Android.
- [ ] Push keys set on the server; a test notification reaches both platforms (Settings → Phones with the app shows "notifications on").
- [ ] `.well-known` files deployed and verified (Apple's AASA validator; `adb shell pm get-app-links com.altohr.people`).
- [ ] NFC: a badge written from Kiosk → Badge clocks in on a kiosk tablet running the app (iPhone 7+ / any NFC Android).
- [ ] Wallet: "Add to Apple Wallet" adds the pass from Safari; "Save to Google Wallet" opens the save page.
- [ ] Face ID lock on and off; the lock appears after a minute in the background.
- [ ] SSO tenant: "Sign in with your company" goes to the system browser and lands back in the app signed in.
- [ ] Privacy: App Store "App Privacy" answers (contact info, identifiers, precise location for drivers, photos for kiosk) and Google Play Data safety form match `apps/web` privacy policy.
- [ ] iOS usage strings reviewed (Face ID, NFC, camera, location) — they are in `ios/App/App/Info.plist`.
- [ ] Android target SDK meets the Play requirement; `POST_NOTIFICATIONS` only requested after our explanation sheet.
- [ ] Review notes for Apple: a demo associate account and a demo kiosk device token, and a note that the app is for employees of client organizations (Guideline 3.2 — business apps).
- [ ] Version and build numbers bumped on both platforms.

## What lives where

```
apps/mobile/
  capacitor.config.ts     the shell (per-environment id / name / host)
  www/                    offline.html — the only bundled page
  resources/              icon + splash sources (generated from the brand)
  scripts/                brand-assets.mjs, well-known.mjs
  ios/                    Xcode project (SPM)
  android/                Gradle project
```
