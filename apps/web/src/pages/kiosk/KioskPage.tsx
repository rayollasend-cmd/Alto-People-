import { useEffect, useRef, useState } from 'react';
import { KIOSK_PIN_LENGTH } from '@alto-people/shared';
import { useQuery } from '@tanstack/react-query';
import { ApiError, apiFetch } from '@/lib/api';
import { useConfirm } from '@/lib/confirm';
import { hapticConfirm, hapticError, hapticSuccess } from '@/lib/haptics';
import { BadgeReader } from './BadgeReader';
import {
  kioskAttachFace,
  kioskConfig,
  kioskFaceConsent,
  kioskPunch,
  kioskVerifyPin,
  kioskSubmitSop,
  type FaceConsentStatus,
  type KioskPunchAction,
  type KioskPunchSummary,
  type KioskSopBlock,
} from '@/lib/kiosk99Api';
import {
  extractDescriptor,
  loadFaceModels,
  getFaceModelsState,
  onFaceModelsStateChange,
  type FaceModelsState,
} from '@/lib/faceMatch';
import { Logo } from '@/components/Logo';
import { AlertTriangle, Check, ClipboardList, Delete, Timer } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Input';
import {
  clearDroppedCount,
  drainQueue,
  droppedCount,
  enqueuePunch,
  newIdempotencyKey,
  queueSize,
} from '@/lib/kioskQueue';
import { cachedConsent, rememberConsent } from '@/lib/kioskConsentCache';
import { useKioskAppManifest } from '@/lib/kioskInstall';
import { KioskInstallButton } from './KioskInstallButton';
import { fmtDate } from '@/lib/format';

/**
 * Phase 99 — Public kiosk page. No auth, no Layout — full-screen UI a
 * shared tablet can sit on all day. Flow:
 *
 *   setup (first run) → idle → pin entry → selfie capture → result → idle
 *
 * The device token is paste-once into localStorage. Reset by clearing
 * site data on the kiosk's browser.
 */

const TOKEN_STORAGE_KEY = 'alto.kiosk.deviceToken';

// A kiosk is bolted to a wall — its position doesn't change during a
// session, so we cache one coarse fix and reuse it across the preflight
// and the punch rather than waking the GPS radio twice per clock-in.
// Refreshed if older than this, purely as a belt-and-suspenders against
// a device that somehow gets relocated without a reload.
const LOCATION_TTL_MS = 5 * 60 * 1000;

// 'consent' — one-time face-verification consent, shown after the first
// successful PIN entry when the associate has never been asked.
// 'confirmOut' — the punch would clock this associate OUT: ask whether
// they're leaving or just taking a break, so a forgotten break toggle
// doesn't split the shift in two.
// 'submitting' — brief interstitial for the PIN-only path (declined
// consent), which skips the camera and goes straight to the punch.
type Stage =
  | 'setup'
  | 'idle'
  | 'pin'
  | 'consent'
  | 'confirmOut'
  // Where the state requires breaks: "did you get your meal break?" before clocking out.
  | 'breakQ'
  | 'selfie'
  | 'submitting'
  | 'result'
  | 'error'
  // Neutral outcome screen (e.g. "not on today's schedule — supervisor
  // notified"): informational, not a failure, so it must not wear the
  // red alert dress.
  | 'notice'
  // "Maria L. — Clock in?": the name on screen before the punch, so a
  // mistyped number that landed on a coworker's is caught (3s auto-confirm).
  | 'confirmWho'
  // A supervisor's clock-out held by their open shift SOP: submit it here.
  | 'sopBlock';

interface PunchResult {
  action: 'CLOCK_IN' | 'CLOCK_OUT' | 'BREAK_START' | 'BREAK_END';
  associateName: string;
  at: string;
  /** True when the punch was queued offline rather than sent live. */
  queued?: boolean;
  /** Queued offline after a preflight that knew who and what: name it. */
  queuedKnown?: boolean;
  summary?: KioskPunchSummary | null;
}

type Intent = 'BREAK' | null;

// ----- Associate-facing strings (EN/ES) -----------------------------------
// A plain dictionary, not an i18n library — the kiosk has ~40 strings and
// exactly one consumer. Spanish first because the workforce skews
// hospitality/J-1; translations are workable but flagged for native review.
// Admin-facing screens (setup/pairing) stay English on purpose. Server
// error messages for rare hard failures also surface in English; the
// common rejections (wrong PIN, throttle, break-without-clock-in) are
// client-side strings and fully translated.
type Lang = 'en' | 'es';
const LANG_STORAGE_KEY = 'alto.kiosk.lang';

interface KioskStrings {
  locale: string;
  tapToClock: string;
  preparingFace: string;
  faceUnavailable: string;
  enterPin: string;
  enterPinBreak: string;
  onBreak: string;
  goingOnBreak: string;
  cancel: string;
  tryAgain: string;
  wrongPin: string;
  badgeNotRecognized: string;
  tapBadge: string;
  scanBadge: string;
  badgeHold: string;
  badgeHoldCamera: string;
  badgeReading: string;
  badgeRead: string;
  nfcOff: string;
  badgeTimeout: string;
  notABadge: string;
  cameraBlocked: string;
  orTypeNumber: string;
  oneAtATime: string;
  notClockedIn: string;
  notOnScheduleTitle: string;
  notOnScheduleBody: string;
  inactiveBadge: string;
  consentTitle: string;
  consentBody1: string;
  consentBody2: string;
  consentYes: string;
  consentNo: string;
  oneMoment: string;
  verifying: string;
  smile: string;
  notYou: string;
  /** A shift left open from a past day (the worker fixes it from their phone). */
  missedOut: (date: string) => string;
  centerFace: string;
  privacy: string;
  cameraUnavailable: string;
  continueWithoutSelfie: string;
  /** A required photo the camera can't take: punch anyway, flagged for a supervisor. */
  punchWithoutPhoto: string;
  confirmOutTitle: string;
  confirmOutBreak: string;
  confirmOutLeave: string;
  breakMeal: string;
  breakRest: string;
  breakWhy: string;
  yes: string;
  no: string;
  breakSkipped: string;
  greet: Record<KioskPunchAction, string>;
  resultPrefix: Record<KioskPunchAction, string>;
  resultVerb: Record<KioskPunchAction, string>;
  punchSaved: string;
  savedOffline: string;
  syncWhenBack: string;
  tapToDismiss: string;
  queuedOne: string;
  queuedMany: string;
  droppedOne: string;
  droppedMany: string;
  cameraNoStart: string;
  langToggleLabel: string;
  /** Who-is-this confirm, before every punch that isn't a clock-out (that one asks "done for the day?"). */
  confirmWhoIsThis: string;
  confirmQuestion: Record<KioskPunchAction, string>;
  confirmYes: string;
  confirmNotMe: string;
  confirmAuto: (seconds: number) => string;
  notMeRetype: string;
  /** The clock-out SOP gate, at the tablet. */
  sopTitle: string;
  sopBody: (label: string, done: number, total: number) => string;
  sopBodyDone: (label: string) => string;
  sopWhy: string;
  sopReasons: string[];
  sopOther: string;
  sopOtherPlaceholder: string;
  sopNoteLabel: string;
  sopNotePlaceholder: string;
  sopSubmitOut: string;
  sopInApp: string;
  sopFailed: string;
  /** Result screen: what the punch means for today and the week. */
  shiftWindow: (from: string, to: string) => string;
  onTime: string;
  minLate: (n: number) => string;
  minEarly: (n: number) => string;
  mealDue: (time: string) => string;
  thisWeek: string;
  hoursShort: (h: string) => string;
  willSend: string;
}

const STRINGS: Record<Lang, KioskStrings> = {
  en: {
    locale: 'en-US',
    tapToClock: 'Tap to clock in / out',
    preparingFace: 'Preparing face match…',
    faceUnavailable: 'Face match unavailable — clock-in number only.',
    enterPin: 'Enter your 4-digit clock-in number',
    enterPinBreak: 'Break — enter your 4-digit clock-in number',
    onBreak: '☕ On break',
    goingOnBreak: 'Going on break?',
    cancel: 'Cancel',
    tryAgain: 'Try again',
    wrongPin: 'Wrong clock-in number. Try again.',
    badgeNotRecognized: 'This badge isn’t recognized here — it may have been replaced. Type your clock-in number instead.',
    tapBadge: 'Tap badge',
    scanBadge: 'Scan badge',
    badgeHold: 'Hold your badge to the top of the tablet',
    badgeHoldCamera: 'Hold the code on your badge or phone up to the camera',
    badgeReading: 'Reading your badge…',
    badgeRead: 'Badge read',
    nfcOff: 'Badge tap is turned off on this tablet. Type your clock-in number instead.',
    badgeTimeout: 'We didn’t feel a badge. Try again, or type your number.',
    notABadge: 'That card isn’t an Alto badge. Type your clock-in number instead.',
    cameraBlocked: 'The camera isn’t available. Type your clock-in number instead.',
    orTypeNumber: 'or type your number',
    oneAtATime: 'One at a time — wait a second, then tap Try again.',
    notClockedIn: "You're not clocked in — turn off break to clock in.",
    notOnScheduleTitle: "You're not on today's schedule",
    notOnScheduleBody:
      'Your supervisor was just notified. Once they approve, you are clocked in from right now — no need to punch again.',
    inactiveBadge:
      'This badge is not active right now. Please see your supervisor.',
    consentTitle: 'Quick question,',
    consentBody1:
      "This kiosk can take a quick photo at each punch to confirm it's really you (it stops anyone else clocking in with your number).",
    consentBody2:
      'Photos are used only to verify your punches and are deleted after 90 days. To recognize you, the system also stores a numeric face template (a string of numbers, not a photo); it’s deleted when you stop working with us, after a year without punches, or any time you withdraw consent through your manager. If you’d rather not, you can clock in with just your number — no photo, no face template, ever.',
    consentYes: 'OK — use photo verification',
    consentNo: 'No thanks — number only',
    oneMoment: 'One moment…',
    verifying: 'Verifying…',
    smile: 'Smile for the camera',
    notYou: 'Not you? Tap Cancel below.',
    missedOut: (date) => `You didn’t clock out on ${date}. Tell us when you left in the app’s Time tab.`,
    centerFace: 'Center your face in the oval',
    privacy: 'Your photo is used only to verify this time punch.',
    cameraUnavailable: 'Camera unavailable',
    continueWithoutSelfie: 'Continue without selfie',
    punchWithoutPhoto: 'Punch without a photo — a supervisor will confirm',
    confirmOutTitle: 'Done for the day,',
    confirmOutBreak: '☕ Just taking a break',
    confirmOutLeave: 'Leaving — clock me out',
    breakMeal: 'Did you get your meal break today?',
    breakRest: 'Did you get your rest breaks?',
    breakWhy: 'The law here requires breaks. If you missed one, say so — it’s put right on your pay.',
    yes: 'Yes',
    no: 'No',
    breakSkipped: 'I chose to skip it',
    greet: {
      CLOCK_IN: 'Clocking you in',
      CLOCK_OUT: 'Clocking you out',
      BREAK_START: 'Starting your break',
      BREAK_END: 'Ending your break',
    },
    resultPrefix: {
      CLOCK_IN: 'Welcome',
      CLOCK_OUT: 'See you later',
      BREAK_START: 'Enjoy your break',
      BREAK_END: 'Welcome back',
    },
    resultVerb: {
      CLOCK_IN: 'Clocked in',
      CLOCK_OUT: 'Clocked out',
      BREAK_START: 'On break',
      BREAK_END: 'Back from break',
    },
    punchSaved: 'Punch saved',
    savedOffline: 'Saved offline',
    syncWhenBack: "We'll sync when the network comes back.",
    tapToDismiss: 'Tap anywhere to dismiss',
    queuedOne: 'punch waiting to sync',
    queuedMany: 'punches waiting to sync',
    droppedOne: 'punch could not be recorded — tell HR',
    droppedMany: 'punches could not be recorded — tell HR',
    cameraNoStart: 'The camera did not start. You can clock in without a photo.',
    langToggleLabel: 'Español',
    confirmWhoIsThis: 'Is this you?',
    confirmQuestion: {
      CLOCK_IN: 'Clock in?',
      CLOCK_OUT: 'Clock out?',
      BREAK_START: 'Start your break?',
      BREAK_END: 'End your break?',
    },
    confirmYes: 'Yes, that’s me',
    confirmNotMe: 'Not me',
    confirmAuto: (n) => `Continuing in ${n}…`,
    notMeRetype: 'Type your own clock-in number.',
    sopTitle: 'Your SOP is still open',
    sopBody: (label, done, total) => `Your ${label} isn’t submitted — ${done} of ${total} done. Submit it before you clock out.`,
    sopBodyDone: (label) => `Your ${label} is done but not submitted. Submit it before you clock out.`,
    sopWhy: 'Why is it incomplete?',
    sopReasons: ['Short-staffed — no time to finish', 'Family emergency — leaving early', 'Equipment or supplies problem', 'Busy floor — guests came first'],
    sopOther: 'Something else',
    sopOtherPlaceholder: 'Say why in a few words',
    sopNoteLabel: 'Note for the next shift (optional)',
    sopNotePlaceholder: 'Cooler 2 running warm, maintenance called',
    sopSubmitOut: 'Submit and clock out',
    sopInApp: 'Or finish it in the Alto app first, then clock out.',
    sopFailed: 'Couldn’t submit it. Try again, or finish it in the Alto app.',
    shiftWindow: (from, to) => `Shift ${from} – ${to}`,
    onTime: 'On time',
    minLate: (n) => `${n} min late`,
    minEarly: (n) => `${n} min early`,
    mealDue: (time) => `Meal break by ${time}`,
    thisWeek: 'this week',
    hoursShort: (h) => `${h} h`,
    willSend: 'will send',
  },
  es: {
    locale: 'es-US',
    tapToClock: 'Toca para marcar entrada / salida',
    preparingFace: 'Preparando verificación facial…',
    faceUnavailable: 'Verificación facial no disponible — solo número para marcar.',
    enterPin: 'Ingresa tu número para marcar de 4 dígitos',
    enterPinBreak: 'Descanso — ingresa tu número para marcar de 4 dígitos',
    onBreak: '☕ En descanso',
    goingOnBreak: '¿Vas a tomar descanso?',
    cancel: 'Cancelar',
    tryAgain: 'Reintentar',
    wrongPin: 'Número para marcar incorrecto. Intenta de nuevo.',
    badgeNotRecognized: 'Esta credencial no se reconoce aquí; puede que la hayan reemplazado. Escribe tu número para marcar.',
    tapBadge: 'Acercar credencial',
    scanBadge: 'Escanear credencial',
    badgeHold: 'Acerca tu credencial a la parte de arriba de la tableta',
    badgeHoldCamera: 'Acerca a la cámara el código de tu credencial o teléfono',
    badgeReading: 'Leyendo tu credencial…',
    badgeRead: 'Credencial leída',
    nfcOff: 'La lectura de credenciales está desactivada en esta tableta. Escribe tu número para marcar.',
    badgeTimeout: 'No detectamos ninguna credencial. Inténtalo de nuevo o escribe tu número.',
    notABadge: 'Esa tarjeta no es una credencial de Alto. Escribe tu número para marcar.',
    cameraBlocked: 'La cámara no está disponible. Escribe tu número para marcar.',
    orTypeNumber: 'o escribe tu número',
    oneAtATime: 'Uno a la vez — espera un segundo y toca Reintentar.',
    notClockedIn: 'No has marcado entrada — desactiva el descanso para entrar.',
    notOnScheduleTitle: 'No estás en el horario de hoy',
    notOnScheduleBody:
      'Tu supervisor acaba de ser notificado. Cuando apruebe, quedas marcado desde este momento — no necesitas marcar de nuevo.',
    inactiveBadge:
      'Tu credencial no está activa en este momento. Por favor habla con tu supervisor.',
    consentTitle: 'Una pregunta rápida,',
    consentBody1:
      'Este quiosco puede tomar una foto rápida en cada marcación para confirmar que realmente eres tú (evita que otra persona marque con tu número).',
    consentBody2:
      'Las fotos se usan solo para verificar tus marcaciones y se eliminan a los 90 días. Para reconocerte, el sistema también guarda una plantilla facial numérica (una serie de números, no una foto); se elimina cuando dejas de trabajar con nosotros, tras un año sin marcaciones, o cuando retires tu consentimiento con tu supervisor. Si prefieres no usarla, puedes marcar solo con tu número — sin foto ni plantilla facial, nunca.',
    consentYes: 'Sí — usar verificación con foto',
    consentNo: 'No, gracias — solo número',
    oneMoment: 'Un momento…',
    verifying: 'Verificando…',
    smile: 'Sonríe para la cámara',
    notYou: '¿No eres tú? Toca Cancelar abajo.',
    missedOut: (date) => `No marcaste la salida el ${date}. Dinos cuándo saliste en la pestaña Tiempo de la app.`,
    centerFace: 'Centra tu cara en el óvalo',
    privacy: 'Tu foto se usa solo para verificar esta marcación.',
    cameraUnavailable: 'Cámara no disponible',
    continueWithoutSelfie: 'Continuar sin foto',
    punchWithoutPhoto: 'Marcar sin foto — un supervisor lo confirmará',
    confirmOutTitle: '¿Terminaste por hoy,',
    confirmOutBreak: '☕ Solo voy a descansar',
    confirmOutLeave: 'Me voy — marcar salida',
    breakMeal: '¿Tuviste tu descanso para comer hoy?',
    breakRest: '¿Tuviste tus descansos cortos?',
    breakWhy: 'Aquí la ley exige descansos. Si te faltó uno, dilo — se corrige en tu pago.',
    yes: 'Sí',
    no: 'No',
    breakSkipped: 'Decidí no tomarlo',
    greet: {
      CLOCK_IN: 'Marcando tu entrada',
      CLOCK_OUT: 'Marcando tu salida',
      BREAK_START: 'Iniciando tu descanso',
      BREAK_END: 'Terminando tu descanso',
    },
    resultPrefix: {
      CLOCK_IN: 'Hola',
      CLOCK_OUT: 'Hasta luego',
      BREAK_START: 'Disfruta tu descanso',
      BREAK_END: 'Hola de nuevo',
    },
    resultVerb: {
      CLOCK_IN: 'Entrada marcada',
      CLOCK_OUT: 'Salida marcada',
      BREAK_START: 'En descanso',
      BREAK_END: 'De vuelta del descanso',
    },
    punchSaved: 'Marcación guardada',
    savedOffline: 'Guardado sin conexión',
    syncWhenBack: 'Se sincronizará cuando vuelva la conexión.',
    tapToDismiss: 'Toca en cualquier lugar para cerrar',
    queuedOne: 'marcación por sincronizar',
    queuedMany: 'marcaciones por sincronizar',
    droppedOne: 'marcación no pudo registrarse — avisa a RR. HH.',
    droppedMany: 'marcaciones no pudieron registrarse — avisa a RR. HH.',
    cameraNoStart: 'La cámara no inició. Puedes marcar sin foto.',
    langToggleLabel: 'English',
    confirmWhoIsThis: '¿Eres tú?',
    confirmQuestion: {
      CLOCK_IN: '¿Marcar entrada?',
      CLOCK_OUT: '¿Marcar salida?',
      BREAK_START: '¿Iniciar tu descanso?',
      BREAK_END: '¿Terminar tu descanso?',
    },
    confirmYes: 'Sí, soy yo',
    confirmNotMe: 'No soy yo',
    confirmAuto: (n) => `Continúa en ${n}…`,
    notMeRetype: 'Escribe tu propio número para marcar.',
    sopTitle: 'Tu SOP sigue abierto',
    sopBody: (label, done, total) => `Tu ${label} no está enviado — ${done} de ${total} hechos. Envíalo antes de marcar salida.`,
    sopBodyDone: (label) => `Tu ${label} está hecho pero no enviado. Envíalo antes de marcar salida.`,
    sopWhy: '¿Por qué está incompleto?',
    sopReasons: ['Faltó personal — no hubo tiempo', 'Emergencia familiar — me voy temprano', 'Problema con equipo o suministros', 'Mucho trabajo en piso — los clientes primero'],
    sopOther: 'Otra razón',
    sopOtherPlaceholder: 'Di por qué en pocas palabras',
    sopNoteLabel: 'Nota para el siguiente turno (opcional)',
    sopNotePlaceholder: 'El refrigerador 2 está caliente, ya se llamó a mantenimiento',
    sopSubmitOut: 'Enviar y marcar salida',
    sopInApp: 'O termínalo primero en la app de Alto y luego marca salida.',
    sopFailed: 'No se pudo enviar. Inténtalo de nuevo o termínalo en la app de Alto.',
    shiftWindow: (from, to) => `Turno ${from} – ${to}`,
    onTime: 'A tiempo',
    minLate: (n) => `${n} min tarde`,
    minEarly: (n) => `${n} min antes`,
    mealDue: (time) => `Descanso para comer antes de las ${time}`,
    thisWeek: 'esta semana',
    hoursShort: (h) => `${h} h`,
    willSend: 'se enviará',
  },
};

function readStoredLang(): Lang {
  try {
    return window.localStorage.getItem(LANG_STORAGE_KEY) === 'es' ? 'es' : 'en';
  } catch {
    return 'en';
  }
}

export function KioskPage() {
  // Swap in the kiosk web-app manifest so "Add to Home Screen" installs a
  // standalone kiosk app (launches at /kiosk), distinct from the main app.
  useKioskAppManifest();
  const [stage, setStage] = useState<Stage>('idle');
  const [token, setToken] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  // A badge credential (NFC tap or Wallet QR) used instead of the number,
  // for this one punch. A ref: the reader sets it and runs the preflight in
  // the same tick, before React re-renders.
  const badgeRef = useRef<string | null>(null);
  const [intent, setIntent] = useState<Intent>(null);
  const [result, setResult] = useState<PunchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Inline wrong-PIN feedback. Shown beneath the dots on the PIN screen
  // and triggers a shake. Distinct from `error` (which is for hard
  // failures like an expired device token that bounce to a full-page
  // error). Cleared the moment the user touches the keypad again.
  const [pinError, setPinError] = useState<string | null>(null);
  // True while a PIN is being verified over the network. Freezes the keypad
  // on this shared device so a second person can't start typing over an
  // in-flight punch.
  const [verifying, setVerifying] = useState(false);
  // What the preflight learned: who this is and what the punch will do.
  // Drives the camera-screen greeting ("Clocking you in, Maria"). Null
  // when the preflight couldn't reach the server (offline flow) — the
  // camera screen falls back to a generic prompt.
  const [preflight, setPreflight] = useState<{
    firstName: string;
    lastInitial?: string | null;
    predictedAction: KioskPunchAction;
    faceConsent: FaceConsentStatus | null;
    missedClockOutAt?: string | null;
    breakQuestions?: { meal: boolean; rest: boolean } | null;
    /** A photo must be taken at this punch — no skipping, consent or not. */
    photoRequired?: boolean;
    photoNotice?: string | null;
  } | null>(null);
  // Read synchronously by routeByConsent and submit, which run in the same
  // tick the preflight lands (before its state re-renders).
  const photoRequiredRef = useRef(false);
  // The break answer, carried into the clock-out punch (lib/timeCorrections on the API).
  const breakAnswerRef = useRef<{ meal: 'YES' | 'NO' | 'WAIVED'; rest?: 'YES' | 'NO' | null } | null>(null);
  const [breakMealAnswer, setBreakMealAnswer] = useState<'YES' | 'NO' | 'WAIVED' | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [queued, setQueued] = useState<number>(() => queueSize());
  // Punches the server permanently refused during a drain. Anything >0
  // means someone's worked time did NOT record and only HR can fix it —
  // surfaced on the idle screen instead of vanishing with the queue badge.
  const [dropped, setDropped] = useState<number>(() => droppedCount());
  // Associate-facing language. Persisted per device — a site whose crew
  // prefers Spanish sets it once and the tablet stays Spanish.
  const [lang, setLang] = useState<Lang>(() => readStoredLang());
  // The worker's own saved language, for this punch only (verify-pin returns
  // it): one person's Spanish no longer carries over to the next in line,
  // and the tablet's own setting comes back at idle.
  const [punchLang, setPunchLang] = useState<Lang | null>(null);
  const t = STRINGS[punchLang ?? lang];
  // The clock-out SOP gate's details (409 sop_open), for its screen.
  const [sopBlock, setSopBlock] = useState<KioskSopBlock | null>(null);
  const [sopBusy, setSopBusy] = useState(false);
  const [sopError, setSopError] = useState<string | null>(null);
  // Typing on the SOP screen counts as activity for the abandoned-screen timer.
  const [sopTyping, setSopTyping] = useState(0);
  const toggleLang = () => {
    const next: Lang = lang === 'en' ? 'es' : 'en';
    setLang(next);
    try {
      window.localStorage.setItem(LANG_STORAGE_KEY, next);
    } catch {
      /* private mode — toggle still works for this session */
    }
  };
  // Whether this device has a geofence — tri-state on purpose. Boot config
  // resolves it to 'yes'/'no'; until then (or if config failed, e.g. the
  // tablet booted offline) it stays 'unknown'. We only SKIP geolocation
  // when we positively know it's 'no'. The fence is advisory server-side
  // (missing/out-of-fence coords flag for review, never block), so coords
  // are purely a fraud signal — 'unknown' still attempts a coarse,
  // best-effort fix to keep that signal flowing. The latency win holds:
  // config resolves on boot well before anyone walks up to punch.
  const geofenceModeRef = useRef<'unknown' | 'yes' | 'no'>('unknown');
  // Learn whether this kiosk has a geofence so we can skip GPS entirely
  // when it doesn't. Best-effort — on failure the ref stays 'unknown', we
  // keep attempting coarse fixes, and the server treats the fence as
  // advisory regardless. Fetched once per device token for the life of
  // the tab (a wall tablet keeps this open for weeks; the fence doesn't
  // move).
  const configQuery = useQuery({
    queryKey: ['kiosk', 'config', token],
    queryFn: () => kioskConfig(token!),
    enabled: !!token,
    retry: false,
    staleTime: Infinity,
    gcTime: Infinity,
  });
  useEffect(() => {
    if (!configQuery.data) return;
    geofenceModeRef.current = configQuery.data.geofenceRequired ? 'yes' : 'no';
  }, [configQuery.data]);
  // Session-cached coarse location, shared by preflight + punch.
  const cachedLocationRef = useRef<{ lat: number; lng: number; at: number } | null>(
    null,
  );

  // Boot: read token from localStorage, otherwise show setup.
  // Also kick off face-api model preload here so by the time someone
  // actually punches, the ~6.5MB of model weights are already cached.
  // Used to fire on the first tap into PIN entry, which only gave the
  // models ~5 seconds before the camera opened — too tight on slow
  // tablets / poor Wi-Fi.
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(TOKEN_STORAGE_KEY);
      if (stored) {
        setToken(stored);
        setStage('idle');
      } else {
        setStage('setup');
      }
    } catch {
      setStage('setup');
    }
    // eslint-disable-next-line no-restricted-syntax -- boots the on-device face models once per tablet session; not a cacheable read
    void loadFaceModels().catch(() => {
      /* ignore — face match becomes optional if the CDN is down */
    });
  }, []);

  // Self-update. A wall tablet keeps this tab open for weeks and the page
  // deliberately blocks pull-to-refresh — so without this, every deploy
  // (including bug fixes to THIS page) only arrives when someone walks
  // over and hard-refreshes. Poll the build version every 5 minutes;
  // when it changes, reload — but only from the idle screen, never
  // mid-punch. stageRef mirrors stage so the poll callback sees the
  // current value without re-arming the interval on every stage change.
  const stageRef = useRef<Stage>(stage);
  useEffect(() => {
    stageRef.current = stage;
  }, [stage]);

  // Live clock for the idle screen. Gated on stage: only the idle screen
  // renders `now`, and the ungated version re-rendered this entire page —
  // camera preview and face-match included — once per second on low-power
  // wall tablets, all the way through a punch.
  useEffect(() => {
    const t = setInterval(() => {
      if (stageRef.current !== 'idle') return;
      setNow(new Date());
    }, 1000);
    return () => clearInterval(t);
  }, []);
  const knownVersionRef = useRef<string | null>(null);
  const pendingReloadRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        // eslint-disable-next-line no-restricted-syntax -- build-version poll that reloads the tablet; compared, never rendered or cached
        const r = await apiFetch<{ version: string }>('/health/version', {
          timeoutMs: 8_000,
        });
        if (cancelled) return;
        if (knownVersionRef.current === null) {
          knownVersionRef.current = r.version;
        } else if (knownVersionRef.current !== r.version) {
          if (stageRef.current === 'idle') {
            window.location.reload();
          } else {
            pendingReloadRef.current = true;
          }
        }
      } catch {
        /* offline / waking — try again next tick */
      }
    };
    void check();
    const timer = window.setInterval(check, 5 * 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);
  // A new version that landed mid-punch applies on the next return to idle.
  useEffect(() => {
    if (stage === 'idle' && pendingReloadRef.current) {
      window.location.reload();
    }
  }, [stage]);

  // Keep the screen awake. A wall kiosk that dims or locks between
  // punches greets every associate with a black rectangle. The Screen
  // Wake Lock API is best-effort (Safari/old WebViews may lack it) and
  // the browser silently releases the lock whenever the tab is hidden —
  // re-acquire on visibility. OS-level kiosk mode remains the real
  // backstop; this just covers stock-browser installs.
  useEffect(() => {
    type WakeLockSentinel = { release: () => Promise<void> } | null;
    let lock: WakeLockSentinel = null;
    const acquire = async () => {
      try {
        const wl = (navigator as Navigator & {
          wakeLock?: { request: (type: 'screen') => Promise<NonNullable<WakeLockSentinel>> };
        }).wakeLock;
        if (!wl) return;
        lock = await wl.request('screen');
      } catch {
        /* denied / unsupported — kiosk still works, screen may sleep */
      }
    };
    void acquire();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void acquire();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      void lock?.release().catch(() => {});
    };
  }, []);

  // Lock down the document while the kiosk is mounted. iOS Safari
  // evaluates pull-to-refresh on `body`'s overscroll-behavior, not on
  // the nested fixed div — so setting `overscrollBehavior: 'contain'`
  // on the page root isn't enough; a downward swipe at the top of the
  // viewport still triggers the browser's refresh gesture mid-punch.
  // We set body to `overscroll-behavior: none` and `overflow: hidden`
  // for the lifetime of the kiosk, restoring on unmount so when an
  // admin closes the tab the rest of the SPA isn't permanently
  // affected. touchAction at the body level kills double-tap zoom on
  // any element a finger lands on before bubbling to the kiosk root.
  useEffect(() => {
    const body = document.body;
    const html = document.documentElement;
    const prev = {
      bodyOverscroll: body.style.overscrollBehavior,
      bodyOverflow: body.style.overflow,
      bodyTouchAction: body.style.touchAction,
      htmlOverscroll: html.style.overscrollBehavior,
    };
    body.style.overscrollBehavior = 'none';
    body.style.overflow = 'hidden';
    body.style.touchAction = 'manipulation';
    html.style.overscrollBehavior = 'none';
    return () => {
      body.style.overscrollBehavior = prev.bodyOverscroll;
      body.style.overflow = prev.bodyOverflow;
      body.style.touchAction = prev.bodyTouchAction;
      html.style.overscrollBehavior = prev.htmlOverscroll;
    };
  }, []);

  // Current token, readable from the long-lived drain callback below
  // without re-arming its interval on every token change.
  const tokenRef = useRef<string | null>(token);
  useEffect(() => {
    tokenRef.current = token;
  }, [token]);

  // Phase 102 — drain the queue: on first idle, on browser online event,
  // and on a 30s timer (handles flaky networks where 'online' doesn't
  // fire because the radio thinks it's connected to a captive portal).
  // The drain replays with the CURRENT token, not the token frozen into
  // each queued item — items queued before a token rotation/expiry would
  // otherwise 401 forever (see drainQueue for the full story).
  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      void drainQueue(tokenRef.current)
        .then((r) => {
          if (cancelled) return;
          setQueued(r.remaining);
          if (r.errors > 0) setDropped(droppedCount());
        })
        .catch(() => {
          /* swallow — next tick retries */
        });
    };
    tick();
    const onOnline = () => tick();
    window.addEventListener('online', onOnline);
    const t = window.setInterval(tick, 30_000);
    return () => {
      cancelled = true;
      window.removeEventListener('online', onOnline);
      window.clearInterval(t);
    };
  }, []);

  // Auto-return-to-idle timer for the result/error screens. Tracked in a
  // ref so a tap-to-dismiss can cancel it — otherwise a stale timer fires
  // mid-way through the NEXT person's PIN entry and wipes their input.
  const resetTimerRef = useRef<number | null>(null);
  const reset = () => {
    if (resetTimerRef.current !== null) {
      window.clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    }
    setPin('');
    badgeRef.current = null;
    breakAnswerRef.current = null;
    setBreakMealAnswer(null);
    setIntent(null);
    setResult(null);
    setError(null);
    setPinError(null);
    setPreflight(null);
    setPunchLang(null);
    setSopBlock(null);
    setSopBusy(false);
    setSopError(null);
    photoRequiredRef.current = false;
    setStage('idle');
  };
  const scheduleReset = (ms: number) => {
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
    resetTimerRef.current = window.setTimeout(reset, ms);
  };
  // Hard errors auto-dismiss after long enough to actually read them —
  // ~60ms/char (slow reading speed under stress), floored at 6s. A flat
  // 3s used to cut off "registered to a different site…" mid-sentence.
  const errorDwellMs = (msg: string) => Math.max(6_000, msg.length * 60);

  // Abandoned-screen timeout. A half-typed PIN left behind shouldn't
  // greet the next associate — and an unanswered CONSENT prompt is
  // worse: the next person could answer a legally-recorded biometric
  // question for someone else. 60s of inactivity on either screen
  // returns to idle (any keypad activity restarts the clock via the
  // pin/intent deps). Result/error screens have their own dwell
  // timers; the selfie screen self-advances in ~1s.
  const ABANDONED_AFTER_MS = 60_000;
  useEffect(() => {
    if (stage !== 'pin' && stage !== 'consent' && stage !== 'confirmOut' && stage !== 'breakQ' && stage !== 'sopBlock') return;
    const t = window.setTimeout(reset, ABANDONED_AFTER_MS);
    return () => window.clearTimeout(t);
    // touches stable setters; pin/intent/sopTyping are deliberate "activity" deps.
  }, [stage, pin, intent, sopTyping]);

  // Best-effort geolocation, tuned for a stationary wall-mounted tablet:
  //
  //  - Skipped entirely unless this kiosk actually has a geofence — most
  //    don't, and waking the GPS radio for coords the server ignores was
  //    several wasted seconds per clock-in.
  //  - `enableHighAccuracy: false` — coarse Wi-Fi/cell positioning is
  //    plenty for a geofence radius and resolves near-instantly instead of
  //    spinning up GPS hardware for a first fix.
  //  - Cached for the session and reused across the preflight and the
  //    punch, so a single clock-in never fetches twice.
  //
  // On denial/timeout we resolve null. The geofence is advisory
  // server-side, so missing coords never block — the punch just carries
  // no distance for the review queue.
  const tryGetLocation = (): Promise<{ lat: number; lng: number } | null> => {
    if (geofenceModeRef.current === 'no') return Promise.resolve(null);
    const cached = cachedLocationRef.current;
    if (cached && Date.now() - cached.at < LOCATION_TTL_MS) {
      return Promise.resolve({ lat: cached.lat, lng: cached.lng });
    }
    return new Promise((resolve) => {
      if (!('geolocation' in navigator)) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const loc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          cachedLocationRef.current = { ...loc, at: Date.now() };
          resolve(loc);
        },
        () => resolve(null),
        { enableHighAccuracy: false, timeout: 5000, maximumAge: 300_000 },
      );
    });
  };

  // Upload the deferred selfie + face descriptor off the punch's critical
  // path. The selfie is the biggest payload in the flow (~50-200KB base64),
  // so keeping it out of the punch request is what makes a clock-in feel
  // instant on slow Wi-Fi; descriptor extraction is CPU-heavy on top. Both
  // are audit/flag-only on the server (a mismatch still reaches the review
  // queue, just a beat later), so this whole thing is best-effort — the
  // associate is already on the result screen.
  const attachSelfieAndFace = async (
    selfieData: string,
    punchId: string,
    deviceToken: string,
  ) => {
    let faceDescriptor: number[] | null = null;
    try {
      await loadFaceModels();
      const img = new Image();
      img.src = selfieData;
      await img.decode();
      faceDescriptor = await extractDescriptor(img);
    } catch {
      /* face match is optional — still upload the selfie below */
    }
    try {
      await kioskAttachFace({ deviceToken, punchId, selfie: selfieData, faceDescriptor });
    } catch {
      /* best-effort — the punch already succeeded */
    }
  };

  // One punch submission at a time. Without this, a double-tap on
  // "Continue without selfie" fired TWO submits: the first clocked the
  // associate in, the second hit the server's 1/sec device throttle,
  // got a 429, and — because 429s are deliberately queueable (drain
  // collisions) — was saved offline under a FRESH idempotency key. The
  // drain replayed it ≤30s later against the now-open entry and silently
  // clocked the associate straight back OUT. They walked to the floor
  // believing they were clocked in; their entry showed a sub-second
  // shift.
  // Preflight the typed number — or the badge that was just tapped or
  // scanned — before opening the camera (the keypad's onSubmit).
  const runPreflight = async () => {
    // Preflight the PIN before opening the camera. A made-up
    // code stops here instead of showing the user themselves
    // on a selfie countdown. Network failure falls through so
    // the regular offline-queue flow still works.
    if (!token || verifying) return;
    setVerifying(true);
    try {
    const verify = (loc: { lat: number; lng: number } | null) =>
      kioskVerifyPin({
        deviceToken: token,
        // A badge (NFC tap / Wallet QR) stands in for the typed number.
        ...(badgeRef.current ? { badgeToken: badgeRef.current } : { pin }),
        latitude: loc?.lat ?? null,
        longitude: loc?.lng ?? null,
        intent,
      });
    try {
      // Coords are best-effort. The geofence is advisory
      // server-side — out-of-fence (or coordinate-less) punches
      // succeed and get flagged for HR review — so a denied
      // location permission never blocks a clock-in.
      const loc = await tryGetLocation();
      const v = await verify(loc);
      // Carry who this is + what the punch will do into the
      // camera screen ("Clocking you in, Maria"). Also the
      // associate's chance to catch a typo'd PIN that landed on
      // someone ELSE's valid code — a wrong name on screen is
      // the only tell.
      setPreflight({
        firstName: v.associateFirstName,
        lastInitial: v.associateLastInitial ?? null,
        predictedAction: v.predictedAction,
        faceConsent: v.faceConsent,
        missedClockOutAt: v.missedClockOut?.clockInAt ?? null,
        breakQuestions: v.breakQuestions ?? null,
        photoRequired: !!v.photoRequired,
        photoNotice: v.photoNotice ?? null,
      });
      photoRequiredRef.current = !!v.photoRequired;
      // Remember this PIN's consent so a later OFFLINE punch can
      // decide camera-or-not without the server. null clears the
      // cache entry — an admin RESET must not leave a stale
      // GRANTED opening the camera.
      void rememberConsent(badgeRef.current ?? pin, v.faceConsent);
      // A punch that would clock them OUT gets one question
      // first: leaving, or just on break? Most mid-shift
      // clock-outs are a forgotten break toggle, and answering
      // here keeps the shift in one piece.
      // Their own language for the rest of this punch (the tablet has en/es).
      if (v.language === 'es' || v.language === 'en') setPunchLang(v.language);
      // Every punch shows who it's for before it happens: a clock-out
      // asks "done for the day, Maria?"; anything else gets "Maria L. —
      // Clock in?" (auto-confirms in 3s). A number typed one digit off
      // that lands on a coworker's is caught here, photo or not.
      if (v.predictedAction === 'CLOCK_OUT') {
        setStage('confirmOut');
      } else {
        setStage('confirmWho');
      }
    } catch (err) {
      if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
        if (err.code === 'device_token_expired' || err.code === 'invalid_device') {
          window.localStorage.removeItem(TOKEN_STORAGE_KEY);
          setToken(null);
          setError(err.message);
          setStage('setup');
          return;
        }
        // Wrong PIN: stay on the keypad with an inline message
        // + shake. The associate retypes without losing place
        // or having to wait out a full-page error timeout.
        if (err.code === 'invalid_pin') {
          setPin('');
          setPinError(t.wrongPin);
          return;
        }
        // A badge the kiosk doesn't recognise (reissued, another
        // site's): back to the keypad, the number still works.
        if (err.code === 'invalid_badge') {
          badgeRef.current = null;
          hapticError();
          setPinError(t.badgeNotRecognized);
          return;
        }
        // Break toggle while not clocked in — caught at the
        // keypad now (predictPunchAction), not after a selfie.
        // Keep the PIN; turning the toggle off clears this.
        if (err.code === 'not_clocked_in') {
          setPinError(t.notClockedIn);
          return;
        }
        // Throttle collision — e.g. the previous associate's
        // preflight landed under a second ago, or a queue drain
        // stamped the bucket. The typed PIN is fine; keep it —
        // the PinPad shows a "Try again" button for this case.
        if (err.status === 429) {
          setPinError(t.oneAtATime);
          return;
        }
        // Schedule gate caught at the keypad — before the selfie.
        if (err.code === 'not_on_schedule') {
          setStage('notice');
          scheduleReset(12_000);
          return;
        }
        // Their shift SOP holds the clock-out: its own screen, with the
        // way out (submit it incomplete with a reason) right here.
        if (err.code === 'sop_open' && isSopBlock(err.details)) {
          setSopBlock(err.details);
          setSopError(null);
          setStage('sopBlock');
          return;
        }
        // Deactivated/separated badge — localized, no server English.
        if (err.code === 'inactive_associate') {
          setError(t.inactiveBadge);
          setStage('error');
          scheduleReset(errorDwellMs(t.inactiveBadge));
          return;
        }
        setError(err.message);
        setStage('error');
        scheduleReset(errorDwellMs(err.message));
        return;
      }
      // Network failure / kiosk timeout → assume offline; the
      // punch will land in the offline queue. Consent can't be
      // asked of the server here, so fall back to the last
      // consent this PIN answered while online — and if we've
      // never seen one, DON'T open the camera. Capturing a photo
      // is the consent-relevant act; the old "everyone gets the
      // camera offline" default photographed associates who had
      // never been shown the consent screen at all.
      const known = await cachedConsent(badgeRef.current ?? pin);
      if (known === 'GRANTED') {
        setStage('selfie');
      } else {
        setStage('submitting');
        void submit(null);
      }
    }
    } finally {
      setVerifying(false);
    }
  };

  const submitInFlightRef = useRef(false);

  // `intentOverride` exists for same-tick callers (the confirmOut screen
  // routes straight into a PIN-only submit before React has re-rendered
  // with the new `intent` state); everyone else relies on state.
  const submit = async (selfieData: string | null, intentOverride?: Intent, cameraDown = false) => {
    if (submitInFlightRef.current) return;
    submitInFlightRef.current = true;
    try {
      await submitInner(selfieData, intentOverride, cameraDown);
    } finally {
      submitInFlightRef.current = false;
    }
  };

  const submitInner = async (selfieData: string | null, intentOverride?: Intent, cameraDown = false) => {
    if (!token) {
      setStage('setup');
      return;
    }
    const effIntent = intentOverride === undefined ? intent : intentOverride;
    const idempotencyKey = newIdempotencyKey();
    const capturedAt = new Date().toISOString();
    const loc = await tryGetLocation();
    const payload = {
      deviceToken: token,
      ...(badgeRef.current ? { badgeToken: badgeRef.current } : { pin }),
      // Deferred to the background attach (see attachSelfieAndFace) so the
      // large selfie upload + CPU-heavy descriptor extraction don't sit in
      // front of the result screen. Kept tiny, the punch returns fast even
      // on a slow uplink. A REQUIRED photo goes with the punch instead: the
      // server refuses the punch without it.
      selfie: photoRequiredRef.current ? selfieData : null,
      photoPolicyAware: true,
      photoUnavailable: photoRequiredRef.current && cameraDown,
      latitude: loc?.lat ?? null,
      longitude: loc?.lng ?? null,
      faceDescriptor: null,
      idempotencyKey,
      clientPunchedAt: capturedAt,
      intent: effIntent,
      breakAttestation: effIntent === 'BREAK' ? null : breakAnswerRef.current,
    };
    try {
      const r = await kioskPunch(payload);
      setResult({
        action: r.action,
        associateName: r.associateName,
        at: r.at,
        summary: r.summary ?? null,
      });
      hapticSuccess();
      setStage('result');
      // A little longer when there's a summary to read (shift, week).
      scheduleReset(r.summary ? 6000 : 4000);
      // Fire-and-forget: upload the selfie + attach the descriptor now that
      // the associate is already clocked in.
      if (selfieData) void attachSelfieAndFace(selfieData, r.punchId, token);
      photoRequiredRef.current = false;
    } catch (err) {
      // Server rejected (4xx) → real error, show it. Network failure →
      // queue and tell the user "saved offline". 429 (throttle collision,
      // e.g. an offline-queue drain stamped the bucket a beat before this
      // live punch) is NOT fatal: fall through to the queue — the punch
      // carries an idempotencyKey and clientPunchedAt, so the next drain
      // records it with the original timestamp.
      if (
        err instanceof ApiError &&
        err.status >= 400 &&
        err.status < 500 &&
        err.status !== 429
      ) {
        // Device-token expired or revoked: self-heal by clearing the
        // local copy so the next render lands on the setup screen.
        // HR pastes a freshly-rotated token from the admin page.
        if (err.code === 'device_token_expired' || err.code === 'invalid_device') {
          window.localStorage.removeItem(TOKEN_STORAGE_KEY);
          setToken(null);
          setError(
            err.code === 'device_token_expired'
              ? 'This kiosk\'s token expired. Get a fresh one from the admin page.'
              : err.message,
          );
          setStage('setup');
          return;
        }
        // Wrong-PIN at the punch step (race: PIN rotated between
        // preflight and submit). Drop the user back at the keypad with
        // an inline message instead of a full-page red error so they
        // can retype immediately. Same UX as the preflight rejection.
        if (err.code === 'invalid_pin') {
          setPin('');
          setPinError(t.wrongPin);
          setStage('pin');
          return;
        }
        if (err.code === 'invalid_badge') {
          badgeRef.current = null;
          hapticError();
          setPinError(t.badgeNotRecognized);
          setStage('pin');
          return;
        }
        // Schedule gate: the punch filed a supervisor request — a normal
        // outcome for the associate, shown calm and localized, never as a
        // red failure in server English.
        if (err.code === 'not_on_schedule') {
          setStage('notice');
          scheduleReset(12_000);
          return;
        }
        if (err.code === 'sop_open' && isSopBlock(err.details)) {
          setSopBlock(err.details);
          setSopError(null);
          setStage('sopBlock');
          return;
        }
        // Deactivated/separated badge — localized, no server English.
        if (err.code === 'inactive_associate') {
          setError(t.inactiveBadge);
          setStage('error');
          scheduleReset(errorDwellMs(t.inactiveBadge));
          return;
        }
        setError(err.message);
        setStage('error');
        scheduleReset(errorDwellMs(err.message));
        return;
      }
      enqueuePunch({
        idempotencyKey,
        deviceToken: token,
        pin: badgeRef.current ? '' : pin,
        badgeToken: badgeRef.current,
        selfie: selfieData,
        photoUnavailable: photoRequiredRef.current && cameraDown,
        // Offline punches skip face capture — it's a best-effort fraud
        // signal and the selfie image is still queued for HR review.
        faceDescriptor: null,
        latitude: loc?.lat ?? null,
        longitude: loc?.lng ?? null,
        capturedAt,
        intent: effIntent,
      });
      setQueued(queueSize());
      // When the preflight reached the server (the network dropped between
      // it and the punch), we know who and what: "Maria — Clocked in 1:58
      // PM (will send)". Otherwise a neutral "saved offline" — never a guess.
      const known = preflight;
      setResult({
        action: known
          ? effIntent === 'BREAK' && known.predictedAction === 'CLOCK_OUT'
            ? 'BREAK_START'
            : known.predictedAction
          : 'CLOCK_IN',
        associateName: known ? known.firstName : 'Saved',
        at: capturedAt,
        queued: true,
        queuedKnown: !!known,
      });
      hapticSuccess();
      setStage('result');
      scheduleReset(4000);
    }
  };

  // Route by consent: never asked → one-time consent screen; declined →
  // PIN-only, no camera; granted → selfie as usual. `intentOverride`
  // rides along for the PIN-only path, which submits in this same tick
  // (before a setIntent has re-rendered).
  const routeByConsent = (
    consent: FaceConsentStatus | null,
    intentOverride?: Intent,
  ) => {
    // A required photo (lib/punchPhotoPolicy on the API): straight to the
    // camera whatever the face-matching answer — the photo isn't face
    // matching, and the screen says it's required. Consent can be asked
    // another time.
    if (photoRequiredRef.current) {
      setStage('selfie');
      return;
    }
    if (consent === null) {
      setStage('consent');
    } else if (consent === 'DECLINED') {
      setStage('submitting');
      void submit(null, intentOverride);
    } else {
      setStage('selfie');
    }
  };

  if (stage === 'setup') {
    return <SetupScreen onSaved={(t) => { setToken(t); setStage('idle'); }} />;
  }

  return (
    <div
      className="fixed inset-0 bg-midnight text-white flex flex-col items-center justify-center select-none"
      style={{
        // Tablet hardening: no pinch-to-zoom, no double-tap-zoom (the
        // PIN pad would otherwise zoom on a rapid double-tap), no
        // pull-to-refresh on iOS/Android Chrome which would dismiss
        // mid-punch. Selection is already blocked via select-none.
        touchAction: 'manipulation',
        // `none` (not `contain`) — `contain` only blocks scroll
        // chaining; `none` also kills the browser refresh gesture if
        // the body-level lock above somehow doesn't apply (older WebViews).
        overscrollBehavior: 'none',
        WebkitUserSelect: 'none',
        WebkitTouchCallout: 'none',
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* Brand anchor — a thin gold bar across the top of the kiosk
          says "this is the Alto system" without competing with the
          gold tap-to-clock-in surface. Sits below any safe-area inset
          so an iPad notch doesn't clip it. */}
      <div
        className="fixed left-0 right-0 z-50 h-1 bg-gradient-to-r from-transparent via-gold to-transparent opacity-80"
        style={{ top: 'env(safe-area-inset-top)' }}
        aria-hidden="true"
      />
      {stage === 'idle' && (
        <IdleScreen
          now={now}
          t={t}
          onTap={() => {
            // Models were pre-warmed on mount — just open the pad.
            setStage('pin');
          }}
        />
      )}
      {/* Language toggle — idle screen only so it never competes with a
          punch in progress. Persisted per device. */}
      {stage === 'idle' && (
        <button
          type="button"
          onClick={toggleLang}
          className="fixed bottom-4 right-4 min-h-[44px] px-4 py-2 rounded-full border border-navy-secondary bg-navy-secondary/40 text-silver text-sm hover:text-white transition-colors"
        >
          {t.langToggleLabel}
        </button>
      )}
      {stage === 'pin' && (
        <PinPad
          t={t}
          pin={pin}
          onChange={(p) => {
            setPin(p);
            // Any keypad activity dismisses the inline error so the
            // next attempt starts clean.
            if (pinError) setPinError(null);
          }}
          intent={intent}
          onIntent={(i) => {
            setIntent(i);
            // Toggling break is "keypad activity" too — clear any stale
            // inline error (e.g. not_clocked_in tells them to do exactly
            // this, so the message shouldn't linger once they have).
            if (pinError) setPinError(null);
          }}
          error={pinError}
          submitting={verifying}
          onSubmit={runPreflight}
          onCancel={reset}
        />
      )}
      {/* Or a badge: an NFC tap (in the native app) or the badge QR at the camera. */}
      {stage === 'pin' && (
        <BadgeReader
          t={t}
          disabled={verifying}
          onBadge={(badge) => {
            badgeRef.current = badge;
            setPinError(null);
            void runPreflight();
          }}
        />
      )}
      {stage === 'consent' && preflight && (
        <ConsentScreen
          t={t}
          firstName={preflight.firstName}
          onChoice={(agree) => {
            // Record best-effort: a network failure must not block this
            // punch — the decision just stays unrecorded and the kiosk
            // asks again next time.
            if (token) {
              void kioskFaceConsent({
                deviceToken: token,
                ...(badgeRef.current ? { badgeToken: badgeRef.current } : { pin }),
                consent: agree,
              }).catch(() => {});
            }
            // Mirror the answer into the offline consent cache so a
            // network drop right after this choice still routes the
            // camera correctly.
            void rememberConsent(badgeRef.current ?? pin, agree ? 'GRANTED' : 'DECLINED');
            if (agree) {
              setStage('selfie');
            } else {
              setStage('submitting');
              void submit(null);
            }
          }}
          onCancel={reset}
        />
      )}
      {stage === 'confirmWho' && preflight && (
        <ConfirmWho
          t={t}
          name={`${preflight.firstName}${preflight.lastInitial ? ` ${preflight.lastInitial}.` : ''}`}
          action={preflight.predictedAction}
          missedClockOutAt={preflight.missedClockOutAt ?? null}
          onConfirm={() => routeByConsent(preflight.faceConsent)}
          onNotMe={() => {
            // Wrong person: back to the keypad, number cleared, nothing punched.
            setPin('');
            badgeRef.current = null;
            setPreflight(null);
            setPunchLang(null);
            photoRequiredRef.current = false;
            setPinError(t.notMeRetype);
            setStage('pin');
          }}
        />
      )}
      {stage === 'sopBlock' && sopBlock && (
        <SopBlockScreen
          t={t}
          info={sopBlock}
          busy={sopBusy}
          error={sopError}
          onActivity={() => setSopTyping((n) => n + 1)}
          onSubmit={async ({ reason, note }) => {
            if (!token || sopBusy) return;
            setSopBusy(true);
            setSopError(null);
            try {
              await kioskSubmitSop({
                deviceToken: token,
                ...(badgeRef.current ? { badgeToken: badgeRef.current } : { pin }),
                reason: reason || null,
                handoverNote: note || null,
              });
              setSopBlock(null);
              setSopBusy(false);
              // Submitted: carry on to the clock-out as if nothing had held
              // it. Back on the keypad with the same number kept, the pad's
              // auto-advance runs the preflight again ("Done for the day?");
              // a badge has no typed number, so it's re-run here.
              setStage('pin');
              if (badgeRef.current) void runPreflight();
            } catch (err) {
              setSopBusy(false);
              setSopError(err instanceof ApiError && err.status < 500 ? err.message : t.sopFailed);
            }
          }}
          onCancel={reset}
        />
      )}
      {stage === 'confirmOut' && preflight && (
        <div className="flex flex-col items-center max-w-lg px-6 text-center">
          <div className="text-3xl text-white mb-8">
            {t.confirmOutTitle}{' '}
            <span className="text-gold-bright">
              {preflight.firstName}
              {preflight.lastInitial ? ` ${preflight.lastInitial}.` : ''}
            </span>?
          </div>
          <Button
            onClick={() => {
              // "Just a break" — same outcome as the break toggle they
              // forgot: the punch carries intent=BREAK and the entry
              // stays open. Greeting flips to match.
              setIntent('BREAK');
              setPreflight((p) =>
                p ? { ...p, predictedAction: 'BREAK_START' } : p,
              );
              routeByConsent(preflight.faceConsent, 'BREAK');
            }}
            size="lg"
            className="w-full min-h-[56px] rounded-xl py-4 text-xl font-medium"
          >
            {t.confirmOutBreak}
          </Button>
          <button
            onClick={() => {
              if (preflight.breakQuestions && (preflight.breakQuestions.meal || preflight.breakQuestions.rest)) {
                breakAnswerRef.current = null;
                setBreakMealAnswer(null);
                setStage('breakQ');
              } else routeByConsent(preflight.faceConsent, null);
            }}
            className="w-full min-h-[56px] mt-3 bg-navy-secondary hover:bg-navy-secondary/70 text-white rounded-xl py-4 text-xl transition-colors"
          >
            {t.confirmOutLeave}
          </button>
          <button
            onClick={reset}
            className="mt-6 min-h-[44px] px-6 text-silver text-base hover:text-white transition"
          >
            {t.cancel}
          </button>
        </div>
      )}
      {stage === 'breakQ' && preflight?.breakQuestions && (
        <div className="flex flex-col items-center max-w-lg px-6 text-center">
          {(() => {
            const q = preflight.breakQuestions!;
            const askingRest = !q.meal || breakMealAnswer !== null;
            const finish = (rest: 'YES' | 'NO' | null, meal: 'YES' | 'NO' | 'WAIVED' | null) => {
              breakAnswerRef.current = { meal: meal ?? 'YES', rest };
              routeByConsent(preflight.faceConsent, null);
            };
            if (!askingRest) {
              return (
                <>
                  <div className="text-3xl mb-3">{t.breakMeal}</div>
                  <p className="text-base text-silver mb-8">{t.breakWhy}</p>
                  {([['YES', t.yes], ['NO', t.no], ['WAIVED', t.breakSkipped]] as const).map(([v, label]) => (
                    <button
                      key={v}
                      onClick={() => {
                        if (q.rest) setBreakMealAnswer(v);
                        else finish(null, v);
                      }}
                      className="w-full min-h-[56px] mt-3 bg-navy-secondary hover:bg-navy-secondary/70 rounded-xl py-4 text-xl transition-colors"
                    >
                      {label}
                    </button>
                  ))}
                </>
              );
            }
            return (
              <>
                <div className="text-3xl mb-8">{t.breakRest}</div>
                {([['YES', t.yes], ['NO', t.no]] as const).map(([v, label]) => (
                  <button
                    key={v}
                    onClick={() => finish(v, breakMealAnswer)}
                    className="w-full min-h-[56px] mt-3 bg-navy-secondary hover:bg-navy-secondary/70 rounded-xl py-4 text-xl transition-colors"
                  >
                    {label}
                  </button>
                ))}
              </>
            );
          })()}
          <button onClick={reset} className="mt-6 min-h-[44px] px-6 text-silver text-base hover:underline transition">
            {t.cancel}
          </button>
        </div>
      )}
      {stage === 'selfie' && (
        <SelfieCapture
          t={t}
          preflight={preflight}
          onCaptured={(data) => void submit(data)}
          // Move to the submitting screen IMMEDIATELY: unmounting
          // SelfieCapture stops the camera stream and removes the skip
          // button so it can't be tapped twice (the in-flight guard in
          // submit is the second line of defence).
          onSkip={() => {
            setStage('submitting');
            // A required photo that can't be taken: the punch still counts,
            // flagged for a supervisor (the camera is reported as down).
            void submit(null, undefined, photoRequiredRef.current);
          }}
          photoRequired={!!preflight?.photoRequired}
          photoNotice={preflight?.photoNotice ?? null}
          onCancel={reset}
        />
      )}
      {stage === 'submitting' && (
        <div className="text-center">
          <div className="text-gold text-4xl animate-pulse mb-4">⋯</div>
          <div className="text-2xl text-silver">{t.oneMoment}</div>
        </div>
      )}
      {/* Result + error screens dismiss on tap-anywhere so the next
          person in line doesn't have to wait out the auto-reset timer. */}
      {stage === 'result' && result && (
        <button
          type="button"
          onClick={reset}
          aria-label="Done — return to clock"
          className="fixed inset-0 flex items-center justify-center focus:outline-none"
        >
          <ResultScreen result={result} t={t} />
        </button>
      )}
      {stage === 'error' && (
        <button
          type="button"
          onClick={reset}
          className="fixed inset-0 flex flex-col items-center justify-center text-center focus:outline-none"
        >
          <div className="mb-6 text-alert">
            <AlertTriangle className="h-16 w-16" strokeWidth={2} aria-hidden="true" />
          </div>
          <div role="alert" className="text-3xl text-alert max-w-2xl px-8">{error}</div>
          <div className="mt-8 text-base text-silver/80">{t.tapToDismiss}</div>
        </button>
      )}
      {/* Neutral outcome — the schedule gate filing a request is a normal
          result for the associate, not their mistake. Info tone, localized,
          calmer type than the alert screen. */}
      {stage === 'notice' && (
        <button
          type="button"
          onClick={reset}
          className="fixed inset-0 flex flex-col items-center justify-center text-center focus:outline-none"
        >
          <div className="mb-6 text-gold">
            <Timer className="h-16 w-16" strokeWidth={2} aria-hidden="true" />
          </div>
          <div role="status" className="max-w-2xl px-8">
            <div className="text-3xl text-white">{t.notOnScheduleTitle}</div>
            <div className="mt-4 text-xl text-silver">{t.notOnScheduleBody}</div>
          </div>
          <div className="mt-8 text-base text-silver/80">{t.tapToDismiss}</div>
        </button>
      )}
      {/* Phase 102 — queued punch indicator. Only shown when there's a
          backlog so the normal idle screen stays clean. */}
      {queued > 0 && (
        <div className="fixed top-4 left-4 px-3 py-1.5 bg-warning/20 border border-warning/40 rounded-full text-warning text-xs">
          {queued} {queued === 1 ? t.queuedOne : t.queuedMany}
        </div>
      )}
      {/* Punches the server permanently refused (too old, wrong PIN after a
          rotation, wrong site). Each one is worked time that did NOT record.
          Previously these vanished silently — the queue badge just counted
          down. Tap dismisses once HR has been told (long-press semantics
          would be nicer but a shared tablet needs the simplest gesture). */}
      {dropped > 0 && stage === 'idle' && (
        <button
          type="button"
          onClick={() => {
            clearDroppedCount();
            setDropped(0);
          }}
          className="fixed top-4 right-4 max-w-xs px-3 py-1.5 bg-alert/20 border border-alert/50 rounded-full text-alert text-xs text-left"
        >
          {dropped} {dropped === 1 ? t.droppedOne : t.droppedMany}
        </button>
      )}
      {/* Reset hidden affordance: triple-tap top-right corner unlocks setup. */}
      <ResetCorner
        onReset={() => {
          window.localStorage.removeItem(TOKEN_STORAGE_KEY);
          setToken(null);
          setStage('setup');
        }}
      />
    </div>
  );
}

function SetupScreen({ onSaved }: { onSaved: (token: string) => void }) {
  const [val, setVal] = useState('');
  const [error, setError] = useState<string | null>(null);
  const onSave = () => {
    const t = val.trim();
    if (!t.startsWith('altokiosk_')) {
      setError('Token should start with altokiosk_');
      return;
    }
    try {
      window.localStorage.setItem(TOKEN_STORAGE_KEY, t);
      onSaved(t);
    } catch {
      setError('Could not save token. Check browser storage settings.');
    }
  };
  return (
    <div className="fixed inset-0 bg-midnight text-white flex items-center justify-center p-6">
      <div className="max-w-md w-full bg-navy-secondary border border-navy-secondary rounded-2xl p-8 elev-3">
        <div className="text-gold text-sm uppercase tracking-widest mb-2">
          Alto Kiosk
        </div>
        <h1 className="text-3xl font-display mb-4">Pair this device</h1>
        <p className="text-silver text-sm mb-6">
          Paste the device token from your admin's kiosk settings page. The
          token starts with <code className="font-mono">altokiosk_</code>.
        </p>
        <Textarea
          className="h-32 font-mono text-xs"
          value={val}
          onChange={(e) => {
            setVal(e.target.value);
            if (error) setError(null);
          }}
          placeholder="altokiosk_..."
          autoFocus
        />
        {error && (
          <p
            role="alert"
            className="mt-3 text-sm text-alert px-3 py-2 rounded-md border border-alert/40 bg-alert/10"
          >
            {error}
          </p>
        )}
        <Button onClick={onSave} size="lg" className="mt-4 w-full">
          Pair device
        </Button>
        <KioskInstallButton />
      </div>
    </div>
  );
}

function IdleScreen({
  now,
  t,
  onTap,
}: {
  now: Date;
  t: KioskStrings;
  onTap: () => void;
}) {
  // The wall clock renders in the kiosk's own language toggle and the
  // tablet's local zone, not the signed-in user's locale — the shared
  // formatters have neither.
  // eslint-disable-next-line no-restricted-syntax
  const time = now.toLocaleTimeString(t.locale, {
    hour: 'numeric',
    minute: '2-digit',
  });
  // eslint-disable-next-line no-restricted-syntax
  const date = now.toLocaleDateString(t.locale, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
  // Surface face-model preload state so an associate landing while
  // the ~6.5MB weights are still downloading sees a status hint
  // instead of hitting an "unavailable" error mid-selfie. The actual
  // capture step also handles the not-ready case, this is just nicer
  // upfront feedback for the operator setting up a new tablet.
  const [faceState, setFaceState] = useState<FaceModelsState>(
    getFaceModelsState(),
  );
  useEffect(() => onFaceModelsStateChange(setFaceState), []);

  return (
    <button
      onClick={onTap}
      className="w-full h-full flex flex-col items-center justify-center"
    >
      <Logo size="xl" className="mb-6 rounded-xl" alt="Alto HR" />
      <div className="text-gold text-sm uppercase tracking-[0.25em] mb-4 inline-flex items-center gap-2">
        <span className="h-px w-6 bg-gold/60" aria-hidden="true" />
        Alto Kiosk
        <span className="h-px w-6 bg-gold/60" aria-hidden="true" />
      </div>
      {/* font-display (Cormorant), NOT font-serif — the latter used to
          fall through to Georgia on the largest type Alto renders.
          tabular-nums so the clock doesn't jitter on digit changes. */}
      <div className="text-9xl font-display font-light tracking-tight tabular-nums">{time}</div>
      <div className="text-2xl text-silver mt-3">{date}</div>
      {/* One slow expanding ring instead of a 24/7 blink — a wall device
          pulsing forever reads as nagging, not inviting. */}
      <div
        className="mt-16 px-12 py-6 bg-gold/15 border border-gold/60 text-gold rounded-full text-2xl font-medium"
        style={{ animation: 'kiosk-breathe 3.2s ease-in-out infinite' }}
      >
        {t.tapToClock}
      </div>
      {faceState === 'loading' && (
        <div className="mt-6 text-sm text-silver/80 inline-flex items-center gap-2">
          <span className="h-1.5 w-1.5 rounded-full bg-gold animate-pulse" />
          {t.preparingFace}
        </div>
      )}
      {faceState === 'failed' && (
        <div className="mt-6 text-sm text-warning">{t.faceUnavailable}</div>
      )}
    </button>
  );
}

function PinPad({
  t,
  pin,
  onChange,
  intent,
  onIntent,
  onSubmit,
  onCancel,
  error,
  submitting = false,
}: {
  t: KioskStrings;
  pin: string;
  onChange: (p: string) => void;
  intent: Intent;
  onIntent: (i: Intent) => void;
  onSubmit: () => void;
  onCancel: () => void;
  error?: string | null;
  submitting?: boolean;
}) {
  // Auto-advance once every digit is entered — but not while a previous
  // verify is still in flight, so we never fire two punches.
  //
  // Fired AT MOST ONCE per (pin, intent) combination, tracked in a ref.
  // Without the guard this effect re-arms on every parent render
  // (onSubmit is a fresh closure each time), and the error paths that
  // KEEP the typed PIN (429, not_clocked_in) re-rendered straight back
  // into it — an infinite verify loop hammering the server 1-2×/sec
  // until someone tapped Cancel. Retrying a kept PIN is now explicit
  // (the "Try again" button below) — except toggling the break pill,
  // which changes the key and deliberately re-fires: the not_clocked_in
  // message tells the associate to do exactly that, so the resubmit
  // should be automatic once they comply.
  const firedForRef = useRef<string | null>(null);
  const submitKey = `${pin}|${intent ?? ''}`;
  useEffect(() => {
    if (pin.length < KIOSK_PIN_LENGTH) {
      firedForRef.current = null;
      return;
    }
    if (submitting || firedForRef.current === submitKey) return;
    const t = window.setTimeout(() => {
      firedForRef.current = submitKey;
      onSubmit();
    }, 150);
    return () => clearTimeout(t);
  }, [pin, intent, submitKey, onSubmit, submitting]);

  // Shake the dots row whenever a new error arrives. Keyed on the
  // error string so two consecutive wrong PINs both re-trigger.
  const [shakeKey, setShakeKey] = useState(0);
  useEffect(() => {
    if (error) setShakeKey((k) => k + 1);
  }, [error]);

  // Every key ticks — the PIN pad is the most physical interaction in
  // the product and it was silent.
  const press = (d: string) => {
    if (submitting || pin.length >= 4) return;
    hapticConfirm();
    onChange(pin + d);
  };
  const back = () => {
    if (submitting) return;
    hapticConfirm();
    onChange(pin.slice(0, -1));
  };

  // A physical keyboard works the pad too (a USB keypad on the kiosk
  // stand, a screen reader user tabbing in): digits type, Backspace
  // deletes, Escape cancels, Enter is the explicit retry that the
  // "Try again" button offers once an error kept the typed PIN.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      if (/^[0-9]$/.test(e.key)) {
        e.preventDefault();
        press(e.key);
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        back();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      } else if (e.key === 'Enter' && error && pin.length === KIOSK_PIN_LENGTH && !submitting) {
        e.preventDefault();
        onSubmit();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="flex flex-col items-center w-full max-w-sm px-4">
      <style>{`@keyframes kiosk-shake {
        0%, 100% { transform: translateX(0); }
        20%, 60% { transform: translateX(-10px); }
        40%, 80% { transform: translateX(10px); }
      }`}</style>
      <div className="text-2xl text-silver mb-3">
        {intent === 'BREAK' ? t.enterPinBreak : t.enterPin}
      </div>
      {/* min-h 44px — this pill is the only path into the break flow,
          so it gets a full-size touch target, not a caption-sized one. */}
      <button
        type="button"
        onClick={() => onIntent(intent === 'BREAK' ? null : 'BREAK')}
        className={`mb-6 min-h-[44px] px-5 py-2.5 rounded-full text-base border transition-colors ${
          intent === 'BREAK'
            ? 'bg-warning/20 border-warning/60 text-warning'
            : 'bg-navy-secondary/40 border-navy-secondary text-silver hover:text-white'
        }`}
      >
        {intent === 'BREAK' ? t.onBreak : t.goingOnBreak}
      </button>
      <div
        key={shakeKey}
        className="flex gap-4 mb-3"
        style={
          error
            ? { animation: 'kiosk-shake 0.4s cubic-bezier(.36,.07,.19,.97) both' }
            : undefined
        }
      >
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className={`w-16 h-20 rounded-xl border-2 flex items-center justify-center text-4xl transition-colors ${
              pin.length > i
                ? intent === 'BREAK'
                  ? 'bg-warning border-warning text-navy-secondary'
                  : 'bg-gold border-gold-bright text-navy'
                : error
                  ? 'bg-navy-secondary/40 border-alert/60 text-silver'
                  : 'bg-navy-secondary/40 border-navy-secondary text-silver'
            }`}
          >
            {pin.length > i ? '•' : ''}
          </div>
        ))}
      </div>
      <div className="min-h-7 mb-4 flex flex-col items-center justify-center gap-2">
        {error ? (
          <span className="text-alert text-base font-medium" aria-live="polite">
            {error}
          </span>
        ) : null}
        {/* Errors that keep the typed PIN (throttle collision,
            not-clocked-in) need an explicit retry — auto-advance fires
            once per PIN on purpose, and there's no other submit
            affordance on the pad. */}
        {error && pin.length === KIOSK_PIN_LENGTH && !submitting ? (
          <Button onClick={onSubmit} size="lg" className="rounded-full">
            {t.tryAgain}
          </Button>
        ) : null}
      </div>
      <div
        className={`grid grid-cols-3 gap-3 w-full transition-opacity ${
          submitting ? 'opacity-40 pointer-events-none' : ''
        }`}
        aria-busy={submitting}
      >
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => press(d)}
            disabled={submitting}
            className="aspect-square bg-navy-secondary hover:bg-navy-secondary/70 rounded-2xl text-4xl font-light transition-transform active:scale-95"
          >
            {d}
          </button>
        ))}
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          className="aspect-square bg-navy-secondary/40 hover:bg-navy-secondary/70 rounded-2xl text-sm text-silver transition-transform active:scale-95"
        >
          {t.cancel}
        </button>
        <button
          type="button"
          onClick={() => press('0')}
          disabled={submitting}
          className="aspect-square bg-navy-secondary hover:bg-navy-secondary/70 rounded-2xl text-4xl font-light transition-transform active:scale-95"
        >
          0
        </button>
        <button
          type="button"
          onClick={back}
          disabled={submitting}
          // The only child is an aria-hidden icon, so without this the key
          // announces as an unnamed button — on the kiosk, which is the
          // surface most likely to be used with assistive tech.
          aria-label="Delete last digit"
          className="aspect-square bg-navy-secondary/40 hover:bg-navy-secondary/70 rounded-2xl text-2xl text-silver transition-transform active:scale-95"
        >
          <Delete className="mx-auto h-8 w-8" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

// One-time biometric consent. Shown after the first valid PIN entry for
// an associate who has never been asked (faceConsent === null). Both
// choices are first-class: declining means PIN-only punches forever
// (the camera never opens for them) until they change their mind via HR.
function ConsentScreen({
  t,
  firstName,
  onChoice,
  onCancel,
}: {
  t: KioskStrings;
  firstName: string;
  onChoice: (agree: boolean) => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex flex-col items-center max-w-lg px-6 text-center">
      <div className="text-3xl text-white mb-3">
        {t.consentTitle} <span className="text-gold-bright">{firstName}</span>
      </div>
      <p className="text-silver text-lg mb-2">{t.consentBody1}</p>
      <p className="text-silver/80 text-sm mb-8">{t.consentBody2}</p>
      <Button
        onClick={() => onChoice(true)}
        size="lg"
        className="w-full min-h-[56px] rounded-xl py-4 text-xl font-medium"
      >
        {t.consentYes}
      </Button>
      <button
        onClick={() => onChoice(false)}
        className="w-full min-h-[56px] mt-3 bg-navy-secondary hover:bg-navy-secondary/70 text-white rounded-xl py-4 text-xl transition-colors"
      >
        {t.consentNo}
      </button>
      <button
        onClick={onCancel}
        className="mt-6 min-h-[44px] px-6 text-silver text-base hover:text-white transition"
      >
        {t.cancel}
      </button>
    </div>
  );
}

// The camera screen greeting names WHAT the punch will do (and to WHOM)
// before the snap — the associate's only chance to catch two classes of
// mistake: a punch about to go the wrong direction, and a typo'd PIN
// that landed on someone else's valid code. Strings live in t.greet.
function SelfieCapture({
  t,
  preflight,
  onCaptured,
  onSkip,
  onCancel,
  photoRequired = false,
  photoNotice = null,
}: {
  t: KioskStrings;
  preflight: { firstName: string; predictedAction: KioskPunchAction; missedClockOutAt?: string | null } | null;
  onCaptured: (dataUrl: string) => void;
  /** No photo: skipped — or, when one is required, the camera couldn't take it. */
  onSkip: () => void;
  onCancel: () => void;
  /** A photo is required at this punch: no skip button while the camera works. */
  photoRequired?: boolean;
  photoNotice?: string | null;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [streamErr, setStreamErr] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);

  // Latch the callback in a ref so the countdown effect below doesn't
  // depend on it. The parent re-renders every second (its idle clock
  // ticks even while the selfie screen is up), which produces a new
  // onCaptured arrow on every render. Listing it as a dep made the
  // 1-second setTimeout get cleared + restarted before it could fire,
  // so the countdown sat at 2 forever and the capture never happened.
  const onCapturedRef = useRef(onCaptured);
  useEffect(() => {
    onCapturedRef.current = onCaptured;
  }, [onCaptured]);
  // Same latching for onSkip — the capture-retry path below calls it from
  // an effect that must not re-arm on the parent's every-second re-render.
  const onSkipRef = useRef(onSkip);
  useEffect(() => {
    onSkipRef.current = onSkip;
  }, [onSkip]);

  // getUserMedia doesn't only reject — it can HANG indefinitely: a
  // permission prompt nobody taps, another app holding the camera on a
  // shared tablet, a stalled driver. While it hung, streamErr stayed null,
  // so the error screen (the only place "Continue without selfie" lived)
  // never rendered, and the associate's only exit was Cancel — which
  // looped them back through PIN entry to the same hanging camera. For a
  // consent-GRANTED associate that was a permanent inability to clock in:
  // the live complaint. Race the acquisition against a deadline and treat
  // timeout exactly like rejection so the skip path appears.
  const CAMERA_ACQUIRE_TIMEOUT_MS = 6_000;

  useEffect(() => {
    let cancelled = false;
    let stream: MediaStream | null = null;
    // Kept outside the try so the catch can stop a LATE-arriving stream:
    // when the timeout wins the race, the real getUserMedia promise is
    // still pending and may resolve minutes later with a live camera that
    // nothing references — a leaked recording indicator on the tablet.
    let acquire: Promise<MediaStream> | null = null;
    (async () => {
      try {
        acquire = navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: 640, height: 480 },
          audio: false,
        });
        const timeout = new Promise<never>((_, reject) => {
          window.setTimeout(
            () => reject(new Error('camera_acquire_timeout')),
            CAMERA_ACQUIRE_TIMEOUT_MS,
          );
        });
        const s = await Promise.race([acquire, timeout]);
        if (cancelled) {
          s.getTracks().forEach((track) => track.stop());
          return;
        }
        stream = s;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        // Auto-snap after 1 second — enough to position without making a
        // clock-in feel slow. (Was 2s; the extra second was dead time.)
        setCountdown(1);
      } catch (err) {
        // Stop the late stream if the timeout beat a still-pending acquire.
        void acquire
          ?.then((late) => {
            if (late !== stream) late.getTracks().forEach((track) => track.stop());
          })
          .catch(() => {});
        if (cancelled) return;
        const timedOut =
          err instanceof Error && err.message === 'camera_acquire_timeout';
        setStreamErr(
          timedOut
            ? t.cameraNoStart
            : err instanceof Error
              ? err.message
              : 'Camera access denied.',
        );
      }
    })();
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((track) => track.stop());
    };
    // Acquisition must run exactly once per mount; the one string read from
    // `t` is listed so a language flip can't leave a stale message behind.
  }, [t.cameraNoStart]);

  // Retry counter for frames that aren't ready yet — a distinct state (not
  // setCountdown(0) again) because setting state to its current value
  // doesn't re-fire the effect.
  const [captureAttempt, setCaptureAttempt] = useState(0);
  const MAX_CAPTURE_ATTEMPTS = 10;

  useEffect(() => {
    if (countdown === null) return;
    if (countdown === 0) {
      // Capture frame.
      const v = videoRef.current;
      const c = canvasRef.current;
      if (!v || !c) return;
      // play() resolving doesn't guarantee a decoded frame — on slow
      // tablets videoWidth can still be 0 here, and a 0×0 canvas makes
      // toDataURL return the literal string "data:," — a junk "photo"
      // that silently defeated the verification the associate consented
      // to. Give the pipeline a beat to produce a real frame; if it never
      // does, punch without a photo rather than punch with garbage.
      if (v.videoWidth === 0 || v.videoHeight === 0) {
        if (captureAttempt < MAX_CAPTURE_ATTEMPTS) {
          const retry = window.setTimeout(
            () => setCaptureAttempt((a) => a + 1),
            150,
          );
          return () => clearTimeout(retry);
        }
        onSkipRef.current();
        return;
      }
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      const ctx = c.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(v, 0, 0);
      const data = c.toDataURL('image/jpeg', 0.7);
      // Submit immediately. The selfie upload + descriptor extraction run
      // off the critical path in the parent (attachSelfieAndFace) so the
      // associate isn't held on the camera — both are audit/flag-only and
      // never gate the punch.
      setAnalyzing(true);
      onCapturedRef.current(data);
      return;
    }
    const t = window.setTimeout(() => setCountdown(countdown - 1), 1000);
    return () => clearTimeout(t);
  }, [countdown, captureAttempt]);

  if (streamErr) {
    return (
      <div className="text-center max-w-md px-4">
        <div className="text-2xl mb-4">{t.cameraUnavailable}</div>
        <div className="text-silver text-sm mb-6">{streamErr}</div>
        <div className="flex gap-3 justify-center">
          <Button onClick={onSkip} size="lg">
            {photoRequired ? t.punchWithoutPhoto : t.continueWithoutSelfie}
          </Button>
          <Button onClick={onCancel} size="lg" variant="secondary">
            {t.cancel}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center">
      {/* Identity + direction check. Big and personal on purpose: if the
          name is wrong (typo'd PIN hit someone else's code) or the
          direction is wrong (expected clock-in, says clock-out), Cancel
          is right below. */}
      {analyzing ? (
        <div className="text-2xl text-silver mb-4">{t.verifying}</div>
      ) : preflight ? (
        <div className="text-center mb-4">
          <div className="text-3xl text-white">
            {t.greet[preflight.predictedAction]},{' '}
            <span className="text-gold-bright">{preflight.firstName}</span>
          </div>
          <div className="text-base text-silver mt-1">{t.notYou}</div>
          {preflight.missedClockOutAt && (
            <div role="status" className="mt-3 rounded-lg border border-warning/60 bg-warning/10 px-4 py-2 text-base text-warning">
              {t.missedOut(fmtDate(preflight.missedClockOutAt))}
            </div>
          )}
        </div>
      ) : (
        <div className="text-2xl text-silver mb-4">{t.smile}</div>
      )}
      <div className="relative">
        <video
          ref={videoRef}
          className="aspect-[4/3] w-[min(24rem,calc(100vw-2rem))] rounded-2xl bg-black object-cover scale-x-[-1]"
          muted
          playsInline
        />
        {/* Soft vignette + face-framing oval. The countdown is short, so
            the oval does the positioning work — associates learn where to
            stand after a punch or two, which keeps face-match quality up
            (and the admin review queue quiet) without slowing the line. */}
        {/* bg-[rgba(...)] (not bg-black/30) on the vignette: it dims the
            LIVE CAMERA FEED, so it must stay dark in both themes — index.css
            remaps `.bg-black/30` to a 4% slate tint in light mode, which
            would erase the dimming. The arbitrary value escapes the remap. */}
        {countdown !== null && countdown > 0 && (
          <div className="absolute inset-0 rounded-2xl bg-[rgba(0,0,0,0.3)]">
            <div
              aria-hidden="true"
              className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-40 h-52 rounded-[50%] border-2 border-dashed border-white/70"
            />
            {/* text-[#fff], not text-white: the countdown sits on an
                always-dark scrim over the camera feed, and light mode remaps
                `.text-white` to a dark foreground — dark-on-dark. The
                arbitrary value keeps the digit white in both themes. */}
            <div className="absolute top-2 right-2 w-14 h-14 rounded-full border-2 border-gold/80 bg-black/50 flex items-center justify-center text-3xl font-bold text-[#fff] drop-shadow-[0_2px_4px_rgba(0,0,0,0.8)]">
              {countdown}
            </div>
            <div className="absolute bottom-2 inset-x-0 text-center text-sm text-white/90 drop-shadow">
              {t.centerFace}
            </div>
          </div>
        )}
        {analyzing && (
          <div className="absolute inset-0 flex items-center justify-center bg-midnight/60 rounded-2xl">
            <div className="text-gold text-2xl animate-pulse">⋯</div>
          </div>
        )}
      </div>
      <canvas ref={canvasRef} className="hidden" />
      {/* Plain-language privacy note — the photo appears with zero
          warning otherwise. (Biometric-consent law compliance, e.g.
          BIPA, is a policy matter handled outside this screen.) */}
      <div className="mt-4 text-sm text-silver/80 max-w-sm text-center">
        {t.privacy}
      </div>
      {/* Always-visible escape hatch. The photo never gates the punch, so
          there is no reason the ability to skip it should only exist on
          the error screen — a camera that shows a black rectangle without
          ever rejecting (the hang case) used to leave Cancel as the only
          way out, looping the associate back to the same dead camera. */}
      {photoRequired && photoNotice && (
        <div role="status" className="mt-3 max-w-sm rounded-lg border border-gold/50 bg-gold/10 px-4 py-2 text-center text-base text-ink">
          {photoNotice}
        </div>
      )}
      <div className="mt-4 flex items-center gap-4">
        {!photoRequired && (
          <button
            onClick={onSkip}
            disabled={analyzing}
            className="min-h-[44px] px-6 text-silver text-base hover:text-white transition disabled:opacity-40"
          >
            {t.continueWithoutSelfie}
          </button>
        )}
        <button
          onClick={onCancel}
          disabled={analyzing}
          className="min-h-[44px] px-6 text-silver text-base hover:text-white transition disabled:opacity-40"
        >
          {t.cancel}
        </button>
      </div>
    </div>
  );
}

function ResultScreen({ result, t }: { result: PunchResult; t: KioskStrings }) {
  // Kiosk language toggle, not the user locale — see ClockFace. In the
  // store's zone when the punch came back with one.
  const tz = result.summary?.timezone;
  const clock = (iso: string) =>
    // eslint-disable-next-line no-restricted-syntax
    new Date(iso).toLocaleTimeString(t.locale, { hour: 'numeric', minute: '2-digit', ...(tz ? { timeZone: tz } : {}) });
  const time = clock(result.at);
  if (result.queued) {
    // Known person (the preflight answered before the network dropped):
    // "Maria — Clocked in · 1:58 PM · will send". Unknown: neutral.
    const known = result.queuedKnown;
    return (
      <div className="relative text-center px-6">
        <style>{`@keyframes kiosk-celebrate-in {
          0% { transform: scale(0.7); opacity: 0; }
          60% { transform: scale(1.05); opacity: 1; }
          100% { transform: scale(1); opacity: 1; }
        }`}</style>
        <div
          style={{ animation: 'kiosk-celebrate-in 0.5s cubic-bezier(.34,1.56,.64,1) both' }}
        >
          <div className="mx-auto mb-5 h-28 w-28 rounded-full border-4 border-current grid place-items-center text-warning">
            <Timer className="h-16 w-16" strokeWidth={2.5} aria-hidden="true" />
          </div>
          <div className="text-sm uppercase tracking-[0.3em] text-silver/80 mb-3">
            {known ? `${t.resultPrefix[result.action]}, ${result.associateName}` : t.punchSaved}
          </div>
          <div className="font-display text-7xl md:text-8xl leading-none text-white">
            {known ? t.resultVerb[result.action] : t.savedOffline}
          </div>
          <div className="mt-6 text-2xl text-silver">
            {known ? `${t.savedOffline} — ${t.willSend}` : t.syncWhenBack}
          </div>
          <div className="mt-2 text-3xl text-gold-bright tabular-nums">{time}</div>
        </div>
      </div>
    );
  }
  // First name only on the result greeting — "Welcome back, Kaal" reads
  // warmer than full-legal-name on a wall-mounted tablet. Falls back to
  // whatever the server sent if the split is empty (single-name records).
  const firstName = result.associateName.split(' ')[0] || result.associateName;
  const greeting = `${t.resultPrefix[result.action]}, ${firstName}`;
  const verb = t.resultVerb[result.action];
  const accent =
    result.action === 'CLOCK_IN'
      ? 'text-success'
      : result.action === 'CLOCK_OUT'
        ? 'text-gold'
        : 'text-warning';
  const halo =
    result.action === 'CLOCK_IN'
      ? '[--glow:rgb(var(--color-success)/0.24)]'
      : result.action === 'CLOCK_OUT'
        ? '[--glow:rgb(var(--color-gold)/0.24)]'
        : '[--glow:rgb(var(--color-warning)/0.24)]';
  const sum = result.summary;
  // On time inside the 7-minute grace the attendance rules use; early only
  // when it's worth saying.
  const lateness =
    sum?.lateMinutes == null
      ? null
      : sum.lateMinutes >= 7
        ? { text: t.minLate(sum.lateMinutes), tone: 'text-warning' }
        : sum.lateMinutes <= -5
          ? { text: t.minEarly(-sum.lateMinutes), tone: 'text-silver' }
          : { text: t.onTime, tone: 'text-success' };
  return (
    <div className="relative text-center px-6">
      <style>{`@keyframes kiosk-celebrate-in {
        0% { transform: scale(0.6); opacity: 0; }
        60% { transform: scale(1.06); opacity: 1; }
        100% { transform: scale(1); opacity: 1; }
      }
      @keyframes kiosk-halo {
        0%, 100% { transform: translate(-50%, -50%) scale(1); opacity: 0.55; }
        50% { transform: translate(-50%, -50%) scale(1.08); opacity: 0.9; }
      }`}</style>
      {/* Soft action-tinted halo behind the verb. Sits below the content
          layer so the text reads cleanly while still feeling lit-from-within. */}
      <div
        aria-hidden="true"
        className={`pointer-events-none absolute left-1/2 top-1/2 h-[36rem] w-[36rem] rounded-full glow ${halo}`}
        style={{ animation: 'kiosk-halo 2.4s ease-in-out infinite' }}
      />
      <div
        className="relative"
        style={{ animation: 'kiosk-celebrate-in 0.55s cubic-bezier(.34,1.56,.64,1) both' }}
      >
        {/* Vector mark, not '✓' — the emoji glyph rendered a different
            shape on every tablet's platform font. */}
        <div
          className={`mx-auto mb-5 h-28 w-28 rounded-full border-4 border-current grid place-items-center ${accent}`}
        >
          <Check className="h-16 w-16" strokeWidth={3} aria-hidden="true" />
        </div>
        <div className="text-sm uppercase tracking-[0.3em] text-silver/80 mb-3">
          {greeting}
        </div>
        <div className={`font-display text-7xl md:text-8xl leading-none ${accent}`}>
          {verb}
        </div>
        <div className="mt-6 text-3xl text-gold-bright tabular-nums">{time}</div>
        {sum && (
          <div className="mx-auto mt-6 flex max-w-xl flex-wrap items-center justify-center gap-x-6 gap-y-3 text-lg">
            {sum.shift && (
              <span className="text-silver tabular-nums">
                {t.shiftWindow(clock(sum.shift.startsAt), clock(sum.shift.endsAt))}
                {lateness && <span className={`ml-2 font-medium ${lateness.tone}`}>· {lateness.text}</span>}
              </span>
            )}
            {!sum.shift && lateness && <span className={`font-medium ${lateness.tone}`}>{lateness.text}</span>}
            {sum.mealDueAt && <span className="text-silver tabular-nums">{t.mealDue(clock(sum.mealDueAt))}</span>}
            <WeekRing minutes={sum.weekMinutes} t={t} />
          </div>
        )}
      </div>
    </div>
  );
}

/** Hours this week as a small ring toward 40 — gold, amber past 40. */
function WeekRing({ minutes, t }: { minutes: number; t: KioskStrings }) {
  const hours = minutes / 60;
  const frac = Math.min(1, hours / 40);
  const r = 16;
  const c = 2 * Math.PI * r;
  const over = hours > 40;
  const label = t.hoursShort((Math.round(hours * 10) / 10).toLocaleString(t.locale, { maximumFractionDigits: 1 }));
  return (
    <span className="inline-flex items-center gap-2 text-silver">
      <svg width="40" height="40" viewBox="0 0 40 40" aria-hidden="true">
        <circle cx="20" cy="20" r={r} fill="none" strokeWidth="4" stroke="currentColor" className="text-navy-secondary" />
        <circle
          cx="20"
          cy="20"
          r={r}
          fill="none"
          strokeWidth="4"
          strokeLinecap="round"
          stroke="currentColor"
          className={over ? 'text-warning' : 'text-gold'}
          strokeDasharray={`${c * frac} ${c}`}
          transform="rotate(-90 20 20)"
        />
      </svg>
      <span className="tabular-nums">
        <span className="font-medium text-ink">{label}</span> {t.thisWeek}
      </span>
    </span>
  );
}

function isSopBlock(d: unknown): d is KioskSopBlock {
  return !!d && typeof d === 'object' && typeof (d as KioskSopBlock).sopId === 'string' && typeof (d as KioskSopBlock).requiredOpen === 'number';
}

const CONFIRM_SECONDS = 3;

/**
 * "Maria L. — Clock in?" before the punch, for everyone — photo or no
 * photo. The number auto-submits on its 4th digit, so a one-digit slip
 * that lands on a coworker's number used to punch them in without either
 * person seeing a name. Confirms itself after 3 seconds: the line keeps
 * moving, and "Not me" is the big second button.
 */
function ConfirmWho({
  t,
  name,
  action,
  missedClockOutAt,
  onConfirm,
  onNotMe,
}: {
  t: KioskStrings;
  name: string;
  action: KioskPunchAction;
  missedClockOutAt: string | null;
  onConfirm: () => void;
  onNotMe: () => void;
}) {
  const [left, setLeft] = useState(CONFIRM_SECONDS);
  const doneRef = useRef(false);
  const confirmRef = useRef(onConfirm);
  confirmRef.current = onConfirm;
  const fire = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    confirmRef.current();
  };
  useEffect(() => {
    const id = window.setInterval(() => setLeft((n) => n - 1), 1000);
    return () => window.clearInterval(id);
  }, []);
  useEffect(() => {
    if (left <= 0) fire();
    // fire reads refs only
  }, [left]);
  return (
    <div className="flex w-full max-w-lg flex-col items-center px-6 text-center">
      <div className="mb-3 text-sm uppercase tracking-[0.3em] text-silver/80">{t.confirmWhoIsThis}</div>
      <div className="font-display text-6xl leading-tight text-gold-bright break-words">{name}</div>
      <div className="mt-3 text-3xl text-ink">{t.confirmQuestion[action]}</div>
      {missedClockOutAt && (
        <div role="status" className="mt-4 rounded-lg border border-warning/60 bg-warning/10 px-4 py-2 text-base text-warning">
          {t.missedOut(fmtDate(missedClockOutAt))}
        </div>
      )}
      <Button onClick={fire} size="lg" className="mt-10 min-h-[64px] w-full rounded-xl py-4 text-2xl font-medium">
        {t.confirmYes}
      </Button>
      <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-navy-secondary" aria-hidden="true">
        <div
          className="h-full rounded-full bg-gold"
          style={{ width: `${(Math.max(0, left - 1) / CONFIRM_SECONDS) * 100}%`, transition: 'width 1s linear' }}
        />
      </div>
      <div className="mt-2 text-sm text-silver" aria-live="polite">
        {t.confirmAuto(Math.max(0, left))}
      </div>
      <button
        type="button"
        onClick={() => {
          doneRef.current = true;
          onNotMe();
        }}
        className="mt-6 min-h-[56px] w-full rounded-xl border border-navy-secondary bg-navy-secondary/40 py-3 text-xl text-ink transition-colors hover:bg-navy-secondary/70"
      >
        {t.confirmNotMe}
      </button>
    </div>
  );
}

/**
 * The clock-out SOP gate as its own screen, not the red error: what's open,
 * and the way out — pick (or type) why it's incomplete, add a note for the
 * next shift if you like, submit, and the clock-out carries on. All done
 * but not submitted: no reason needed, just submit.
 */
function SopBlockScreen({
  t,
  info,
  busy,
  error,
  onActivity,
  onSubmit,
  onCancel,
}: {
  t: KioskStrings;
  info: KioskSopBlock;
  busy: boolean;
  error: string | null;
  onActivity: () => void;
  onSubmit: (v: { reason: string; note: string }) => void;
  onCancel: () => void;
}) {
  const [pick, setPick] = useState<string | null>(null);
  const [other, setOther] = useState('');
  const [note, setNote] = useState('');
  const incomplete = info.requiredOpen > 0;
  const reason = pick === '__other' ? other.trim() : (pick ?? '');
  const ready = !incomplete || reason.length >= 5;
  return (
    <div className="flex max-h-[100dvh] w-full max-w-xl flex-col overflow-y-auto px-6 py-10 text-left">
      <div className="mb-4 text-warning">
        <ClipboardList className="h-14 w-14" strokeWidth={2} aria-hidden="true" />
      </div>
      <div className="text-3xl text-ink">{t.sopTitle}</div>
      <p className="mt-2 text-lg text-silver">
        {incomplete ? t.sopBody(info.label, info.sopDone, info.sopTotal) : t.sopBodyDone(info.label)}
      </p>
      {incomplete && (
        <fieldset className="mt-6">
          <legend className="mb-2 text-base text-ink">{t.sopWhy}</legend>
          <div className="flex flex-col gap-2">
            {[...t.sopReasons, '__other'].map((r) => (
              <button
                key={r}
                type="button"
                aria-pressed={pick === r}
                onClick={() => {
                  setPick(r);
                  onActivity();
                }}
                className={`min-h-[52px] rounded-xl border px-4 py-3 text-left text-lg transition-colors ${
                  pick === r ? 'border-gold bg-gold/15 text-ink' : 'border-navy-secondary bg-navy-secondary/40 text-ink hover:bg-navy-secondary/70'
                }`}
              >
                {r === '__other' ? t.sopOther : r}
              </button>
            ))}
          </div>
          {pick === '__other' && (
            <Textarea
              aria-label={t.sopOther}
              className="mt-3 text-lg"
              rows={2}
              maxLength={1000}
              value={other}
              placeholder={t.sopOtherPlaceholder}
              onChange={(e) => {
                setOther(e.target.value);
                onActivity();
              }}
            />
          )}
        </fieldset>
      )}
      <label className="mt-6 block text-base text-ink" htmlFor="kiosk-sop-note">
        {t.sopNoteLabel}
      </label>
      <Textarea
        id="kiosk-sop-note"
        className="mt-2 text-lg"
        rows={2}
        maxLength={1000}
        value={note}
        placeholder={t.sopNotePlaceholder}
        onChange={(e) => {
          setNote(e.target.value);
          onActivity();
        }}
      />
      {error && (
        <div role="alert" className="mt-4 rounded-lg border border-alert/60 bg-alert/10 px-4 py-2 text-base text-alert">
          {error}
        </div>
      )}
      <Button
        size="lg"
        className="mt-6 min-h-[60px] w-full rounded-xl text-xl font-medium"
        disabled={!ready}
        loading={busy}
        onClick={() => onSubmit({ reason: incomplete ? reason : '', note: note.trim() })}
      >
        {t.sopSubmitOut}
      </Button>
      <p className="mt-3 text-center text-sm text-silver">{t.sopInApp}</p>
      <button type="button" onClick={onCancel} className="mt-4 min-h-[44px] self-center px-6 text-base text-silver transition hover:text-ink">
        {t.cancel}
      </button>
    </div>
  );
}

function ResetCorner({ onReset }: { onReset: () => void }) {
  const confirm = useConfirm();
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (count === 0) return;
    const t = window.setTimeout(() => setCount(0), 800);
    return () => clearTimeout(t);
  }, [count]);
  return (
    <button
      aria-label="Settings"
      onClick={async () => {
        const next = count + 1;
        if (next >= 3) {
          if (await confirm({ title: 'Unpair this kiosk and clear the device token?', destructive: true })) {
            onReset();
          }
          setCount(0);
        } else {
          setCount(next);
        }
      }}
      className="fixed top-0 right-0 w-12 h-12 opacity-0"
    />
  );
}
