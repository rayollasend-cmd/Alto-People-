import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

/**
 * Hand-rolled i18n — deliberately not a library. The needs are small
 * (two languages, flat string keys, {name} interpolation) and every
 * i18n dependency drags in pluralization engines, ICU parsers, and a
 * runtime we'd ship to every phone. The dictionary lives in this chunk;
 * missing es keys fall back to en, and a missing key renders the key
 * itself so it's findable in QA instead of blank.
 *
 * Spanish first because it's the workforce's dominant second language;
 * the associate-facing core (tab bar, dashboard, schedule) is the
 * translated slice — admin surfaces stay English for now.
 */

export type Lang = 'en' | 'es';

const STORAGE_KEY = 'alto.lang';

const en = {
  // Bottom tab bar
  'tabs.home': 'Home',
  'tabs.schedule': 'Schedule',
  'tabs.clock': 'Clock',
  'tabs.timeOff': 'Time off',
  'tabs.pay': 'Pay',
  'tabs.more': 'More',
  'tabs.moreAria': 'More — open full navigation',

  // Common
  'common.retry': 'Retry',
  'common.cancel': 'Cancel',
  'common.search': 'Search…',
  'common.language': 'Language',
  'common.undo': 'Undo',
  'common.from': 'From',
  'common.to': 'To',
  'common.gotIt': 'Got it',
  'nav.pinned': 'Pinned',

  // "What's new" release card (associate-visible entries)
  'whatsnew.title': 'New this week',
  'whatsnew.weekAhead':
    "You'll get “Your week ahead” the evening before your work week starts.",
  'whatsnew.espanol': 'La aplicación ahora habla español — cámbialo en el menú.',

  // Associate dashboard
  'dash.greeting': 'Hey {name} 👋',
  'dash.subtitle': "Here's what's on for today.",
  'dash.clock': 'Clock',
  'dash.onClock': 'On the clock',
  'dash.offClock': 'Off the clock',
  'dash.startedIn': 'Started {time} · {elapsed} in',
  'dash.kioskHint': 'Punch in with your PIN at the worksite kiosk tablet.',
  'dash.nextShift': 'Next shift',
  'dash.nothingScheduled': 'Nothing scheduled',
  'dash.managerWillPublish':
    'Your manager will publish shifts ahead of the week. Check back soon.',
  'dash.viewSchedule': 'View schedule',
  'dash.seeFullSchedule': 'See full schedule',
  'dash.lastPaystub': 'Last paystub',
  'dash.noPaystubs': 'No paystubs yet',
  'dash.firstPaystub':
    'Your first one will show up here once your manager runs payroll.',
  'dash.netWorked': 'Net · {hours}h worked',
  'dash.paidOn': 'paid {date}',
  'dash.viewPayHistory': 'View pay history',
  'dash.timeOff': 'Time off',
  'dash.noBalance': 'No balance yet',
  'dash.sickAccrues': 'Sick-leave hours accrue automatically as you work.',
  'dash.openTimeOff': 'Open time off',
  'dash.requestOrView': 'Request or view balance',
  'dash.quickLinks': 'Quick links',
  'dash.myTimesheet': 'My timesheet',
  'dash.scheduleSwaps': 'Schedule & swaps',
  'dash.documents': 'Documents',
  'dash.requestTimeOff': 'Request time off',
  'dash.loadFailed': "Couldn't load this",
  'dash.checkConnection': 'Check your connection and try again.',
  'dash.pushTitle': 'Get shift alerts on your lock screen',
  'dash.pushBody': 'New shifts, swaps, and reminders — even when the app is closed.',
  'dash.pushOn': 'Turn on',
  'dash.pushLater': 'Not now',
  'dash.actionNeeded': 'Action needed',
  'dash.allCaughtUp': "You're all caught up ✓",
  'dash.actionAgreements': '{count} agreement waiting for your signature',
  'dash.actionAgreementsPlural': '{count} agreements waiting for your signature',
  'dash.actionDocs': '{count} document needs your attention',
  'dash.actionDocsPlural': '{count} documents need your attention',
  'dash.actionShifts': '{count} upcoming shift to confirm',
  'dash.actionShiftsPlural': '{count} upcoming shifts to confirm',
  'dash.actionInbox': '{count} unread message in your inbox',
  'dash.actionInboxPlural': '{count} unread messages in your inbox',
  'dash.pushOnToast':
    "Notifications on — you'll hear about shifts even with the app closed.",
  'dash.pushFailed': 'Could not enable notifications.',

  // My schedule chrome
  'sched.title': 'My schedule',
  'sched.subtitle': 'Your published shifts.',
  'sched.list': 'List',
  'sched.week': 'Week',
  'sched.month': 'Month',
  'sched.viewAria': 'Schedule view',
  'sched.refresh': 'Refresh',
  'sched.upcoming': 'Upcoming',
  'sched.thisWeek': 'This week',
  'sched.nextWeek': 'Next week',
  'sched.over40': 'Over 40h — check with your manager',
  'sched.shiftsWord': '{count} shift',
  'sched.shiftsWordPlural': '{count} shifts',
  'sched.noUpcoming': 'No upcoming shifts.',
  'sched.noShifts': 'No shifts yet',
  'sched.emptyDesc':
    "When a manager publishes a shift for you, it'll show up here. Post your availability below to make scheduling easier.",
  'sched.unlinked':
    'Your login is not linked to an employee record, so no schedule can be shown. Ask HR to link your account — shifts assigned to you will appear here once that is fixed.',
  'sched.truncated':
    'Showing your next 100 shifts — anything scheduled beyond them will appear here as earlier shifts pass.',
  'sched.showRecent': 'Show recent shifts ({count})',
  'sched.hideRecent': 'Hide recent shifts ({count})',
  'sched.loadOlder': 'Load older shifts',
  'sched.fullHistory': "That's your full shift history.",
  'sched.offline': "You're offline — showing your schedule from {time}.",
  'sched.loadFailed': 'Failed to load.',
  'sched.loadOlderFailed': 'Could not load older shifts.',

  // Open-shift pickups
  'sched.openHeading': 'Open shifts you can pick up ({count})',
  'sched.openRequested': 'Requested',
  'sched.openWithdraw': 'Withdraw',
  'sched.openPickUp': 'Pick up',
  'sched.pickupToast': 'Pickup requested — your manager will confirm it.',
  'sched.pickupFailed': 'Could not request this shift.',
  'sched.withdrawFailed': 'Could not withdraw the request.',
  'sched.pickupConfirmTitle': 'Request this shift?',
  'sched.pickupConfirmNote': "Your manager confirms pickups before they're final.",
  'sched.pickupConfirmLabel': 'Request pickup',

  // Calendar subscription card
  'sched.calTitle': 'Subscribe in your calendar',
  'sched.calBody':
    "Add this URL once and your published shifts show up in Google, Apple, or Outlook calendars — refreshed hourly. Don't share it; anyone with the link can see your schedule.",
  'sched.calLoadFailed': 'Could not load calendar URL.',
  'sched.calUnavailable': 'Calendar subscription is unavailable right now.',
  'sched.calCopyUrl': 'Copy URL',
  'sched.calCopied': 'Copied',
  'sched.calCopiedToast': 'Calendar URL copied. Paste it into Google or Outlook.',
  'sched.calCopyFailed': 'Could not copy — long-press the URL to copy manually.',
  'sched.calOpenApple': 'Open in Apple Calendar',
  'sched.calResetLink': 'Reset link',
  'sched.calResetConfirmTitle': 'Reset your calendar link?',
  'sched.calResetConfirmDesc':
    "If this link got shared, resetting it locks the old one out immediately. Any calendar subscribed with the current link stops updating — you'll need to re-subscribe with the new one.",
  'sched.calResetToast':
    'New link created. Re-subscribe in your calendar app — the old link no longer works.',
  'sched.calResetFailed': 'Could not reset the link.',

  // Shift card
  'shift.next': 'Next',
  'shift.confirmed': 'Confirmed',
  'shift.open': 'Open',
  'shift.worked': 'Worked',
  'shift.draft': 'Draft',
  'shift.cancelled': 'Cancelled',
  'shift.workingWithYou': 'Working with you',
  'shift.noTeammates': 'No one else is scheduled alongside this shift yet.',
  'shift.managerNote': 'Note from your manager: ',
  'shift.illBeThere': "I'll be there",
  'shift.youConfirmed': 'You confirmed this shift',
  'shift.confirmedToast': 'Confirmed — your manager can see you acknowledged it.',
  'shift.offerToTeammate': 'Offer this shift to a teammate',
  'shift.offerTo': 'Offer to',
  'shift.loadingTeammates': 'Loading teammates…',
  'shift.pickTeammate': 'Pick a teammate',
  'shift.busyDuring': ' — busy during this shift',
  'shift.tradeLabel': 'Take one of their shifts in exchange (optional)',
  'shift.justHandOff': 'Nothing — just hand mine off',
  'shift.noteOptional': 'Note (optional)',
  'shift.notePlaceholder': "e.g. Doctor's appointment that morning",
  'shift.sendRequest': 'Send request',
  'shift.detailFailed': 'Could not load shift details.',
  'shift.confirmFailed': 'Could not confirm the shift.',
  'shift.teammatesFailed': 'Could not load teammates.',
  'shift.tradeProposedToast':
    'Trade proposed. They accept first, then your manager approves both halves.',
  'shift.swapSentToast':
    'Swap request sent. Track it under Shift swaps below — your manager has the final say.',
  'shift.swapSendFailed': 'Could not send the swap request.',

  // Shift swaps (marketplace section)
  'swap.title': 'Shift swaps',
  'swap.tabIncoming': 'incoming',
  'swap.tabOutgoing': 'outgoing',
  'swap.loadFailed': 'Failed to load.',
  'swap.actionFailed': 'Action failed.',
  'swap.emptyIncomingTitle': 'No incoming swap requests',
  'swap.emptyOutgoingTitle': 'No outgoing swap requests',
  'swap.emptyIncomingDesc':
    "When a teammate asks to swap a shift with you, it'll show up here.",
  'swap.emptyOutgoingDesc':
    'Request a swap from your assigned shift in the schedule above.',
  'swap.theyTake': 'They take your: ',
  'swap.youTake': 'You take their: ',
  'swap.from': 'From',
  'swap.to': 'To',
  'swap.accept': 'Accept',
  'swap.decline': 'Decline',
  'swap.declineConfirmTitle': 'Decline this swap request?',
  'swap.declineConfirmDesc': '{name} will be notified that you declined.',
  'swap.stWaitingYou': 'Waiting for you to accept',
  'swap.stWaitingYouHint':
    'Accept or decline below — a manager gives final approval after that.',
  'swap.stWaitingPeer': 'Waiting for {name} to accept',
  'swap.stWaitingPeerHint': 'Once they accept, a manager gives final approval.',
  'swap.stAccepted': 'Accepted — waiting for manager approval',
  'swap.stAcceptedHint': "You'll be notified when a manager decides.",
  'swap.stYouDeclined': 'You declined',
  'swap.stPeerDeclined': '{name} declined',
  'swap.stApproved': 'Approved — schedules updated',
  'swap.stRejected': 'Not approved',
  'swap.stRejectedHint':
    'A manager rejected this swap — the shift stays as originally scheduled.',
  'swap.stCancelledByRequester': '{name} cancelled this request',
  'swap.stCancelled': 'Cancelled',

  // Time & attendance — associate kiosk-only explainer
  'time.title': 'Time & Attendance',
  'time.subtitle': 'Clock in at the worksite kiosk.',
  'time.kioskHeading': 'Use the time-clock tablet at your worksite',
  'time.kioskBody':
    "Hourly associates clock in and out using the kiosk tablet installed at your site, not from a personal phone. Tap your 4-digit PIN, take the selfie, and you're punched in. Ask your manager if you don't know your PIN yet.",
  'time.myTimesheet': 'My timesheet',
  'time.myTimesheetDesc':
    'Every kiosk punch with your hours and approval status.',
  'time.approvedTotal': '{hours} approved',
  'time.pendingTotal': '{hours} pending review',
  'time.stillOn': 'still on the clock',
  'time.breakMinutes': '{minutes}m break',
  'time.noEntries': 'No punches in this range',
  'time.noEntriesDesc':
    'Punches from the worksite kiosk will show up here the moment you clock in.',
  'time.loadFailed': 'Could not load your timesheet.',
  'time.status.ACTIVE': 'On the clock',
  'time.status.COMPLETED': 'Pending review',
  'time.status.APPROVED': 'Approved',
  'time.status.REJECTED': 'Rejected',
  'time.lastWeek': 'Last week',
  'time.last14': 'Last 14 days',
  'time.rangeAria': 'Quick date ranges',
  'time.weekOf': 'Week of {date}',
  'time.weekOvertime': 'includes {hours} overtime',
  'time.scheduled': 'Scheduled {range}',
  'time.grossEstimate': '≈ {amount} gross (approved)',
  'time.grossLabel': '≈ Est. gross',
  'time.grossDisclaimer':
    'Estimate before taxes and deductions — not a pay statement.',
  'time.reportIssue': 'Report an issue',
  'time.reportIssueDesc':
    "Tell HR what looks wrong with this entry. The date and punch times are attached automatically, and you can track the case under HR cases.",
  'time.whatsWrong': 'What looks wrong?',
  'time.reportPlaceholder': 'e.g. I clocked out at 5:00, not 4:30',
  'time.send': 'Send to HR',
  'time.reportSent': 'Sent — HR will follow up.',
  'time.reportFailed': 'Could not send',

  // Time off — associate view
  'timeoff.title': 'Time off',
  'timeoff.subtitle': 'Submit a request, see your balance, track approvals.',
  'timeoff.request': 'Request time off',
  'timeoff.myRequests': 'My requests',
  'timeoff.mostRecentFirst': 'Most recent first',
  'timeoff.noRequests': 'No requests yet',
  'timeoff.noRequestsDesc': 'Submit one with the button above. HR will be notified.',
  'timeoff.withdraw': 'Withdraw',
  'timeoff.noteFrom': 'Note from {who}:',
  'timeoff.hr': 'HR',
  'timeoff.noBalance': 'No accrued balance yet',
  'timeoff.noBalanceDesc':
    'Sick-leave hours accrue automatically as you work. Other categories start at 0 and are added by HR.',
  'timeoff.available': 'available',
  'timeoff.status.PENDING': 'Pending',
  'timeoff.status.APPROVED': 'Approved',
  'timeoff.status.DENIED': 'Denied',
  'timeoff.status.CANCELLED': 'Withdrawn',
  'timeoff.cat.SICK': 'Sick',
  'timeoff.cat.VACATION': 'Vacation',
  'timeoff.cat.PTO': 'PTO',
  'timeoff.cat.BEREAVEMENT': 'Bereavement',
  'timeoff.cat.JURY_DUTY': 'Jury duty',
  'timeoff.cat.OTHER': 'Other',
  'timeoff.loadFailed': 'Could not load time-off data',
  'timeoff.withdrawnToast': 'Request withdrawn',
  'timeoff.cancelFailed': 'Could not cancel',
  'timeoff.submittedToast': 'Request submitted',
  'timeoff.submitFailed': 'Could not submit',
  'timeoff.pickDates': 'Pick a start and end date',
  'timeoff.hoursPositive': 'Hours must be greater than 0',
  'timeoff.dialogDesc':
    "HR will see your request immediately. You'll be notified when it's reviewed.",
  'timeoff.category': 'Category',
  'timeoff.startDate': 'Start date',
  'timeoff.endDate': 'End date',
  'timeoff.totalHours': 'Total hours',
  'timeoff.totalHoursHint': 'Half-hour granularity. 8 = a full work day.',
  'timeoff.reasonOptional': 'Reason (optional)',
  'timeoff.reasonPlaceholder': 'Family event, doctor visit, etc.',
  'timeoff.submit': 'Submit',
  'timeoff.balanceLine': '{avail} available · {after} left after this request',
  'timeoff.balanceOver': 'This request exceeds your available balance by {over}.',
  'timeoff.filterAll': 'All',
  'timeoff.filterAria': 'Filter requests by status',
  'timeoff.noneWithStatus': 'No requests with this status.',
  'timeoff.weekdayWord': '{count} weekday',
  'timeoff.weekdayWordPlural': '{count} weekdays',
  'timeoff.holidayWord': '{count} holiday',
  'timeoff.holidayWordPlural': '{count} holidays',
  'timeoff.dayWord': '{count} day',
  'timeoff.dayWordPlural': '{count} days',
  'timeoff.fullDays': 'Full days ({hours}h)',
  'timeoff.halfDays': 'Half days ({hours}h)',

  // Pay — associate paystub list
  'pay.title': 'My pay',
  'pay.subtitle': 'Recent paystubs with year-to-date totals.',
  'pay.loadFailed': 'Failed to load.',
  'pay.ytdLoadFailed': "Couldn't load year-to-date totals.",
  'pay.noPaystubs': 'No paystubs yet',
  'pay.noPaystubsDesc':
    'Your first paystub will appear here after payroll runs for a period you worked.',
  'pay.pendingCount': 'Pending ({count})',
  'pay.paystubWord': '{count} paystub',
  'pay.paystubWordPlural': '{count} paystubs',
  'pay.hrsAtRate': '{hours} hrs · {rate}/hr',
  'pay.gross': 'Gross',
  'pay.taxes': 'Taxes',
  'pay.taxPlusPostTax': 'Tax + post-tax',
  'pay.net': 'Net',
  'pay.netPay': 'Net pay',
  'pay.ytdNet': 'YTD net {amount}',
  'pay.earnings': 'Earnings',
  'pay.deductions': 'Deductions',
  'pay.employerContrib': 'Employer contributions (informational)',
  'pay.colHours': 'Hours',
  'pay.colRate': 'Rate',
  'pay.colCurrent': 'Current',
  'pay.colYtd': 'YTD',
  'pay.grossPay': 'Gross pay',
  'pay.fedIncomeTax': 'Federal income tax',
  'pay.socialSecurity': 'Social Security (FICA)',
  'pay.medicare': 'Medicare',
  'pay.stateIncomeTax': 'State income tax',
  'pay.garnishments': 'Garnishments / post-tax',
  'pay.totalDeductions': 'Total deductions',
  'pay.employerFica': 'Employer FICA match',
  'pay.employerMedicare': 'Employer Medicare match',
  'pay.futa': 'Federal unemployment (FUTA)',
  'pay.suta': 'State unemployment (SUTA)',
  'pay.disbursementRef': 'Disbursement ref: {ref}',
  'pay.downloadPdf': 'Download PDF',
  'pay.downloadFailed': 'Download failed.',
  'pay.status.PENDING': 'Pending',
  'pay.status.DISBURSED': 'Paid',
  'pay.status.FAILED': 'Failed',
  'pay.status.HELD': 'Held',
  'pay.status.VOIDED': 'Voided',
  'pay.kind.REGULAR': 'Regular',
  'pay.kind.OVERTIME': 'Overtime',
  'pay.kind.DOUBLE_TIME': 'Double time',
  'pay.kind.HOLIDAY': 'Holiday',
  'pay.kind.SICK': 'Sick',
  'pay.kind.VACATION': 'Vacation',
  'pay.kind.BONUS': 'Bonus',
  'pay.kind.COMMISSION': 'Commission',
  'pay.kind.TIPS': 'Tips',
  'pay.kind.REIMBURSEMENT': 'Reimbursement (non-taxable)',

  // Pay — tax & pay settings expander
  'pay.taxSettingsTitle': 'Tax & pay settings',
  'pay.taxDocs': 'Tax documents',
  'pay.taxDocsHint': 'W-2s & year-end forms →',
  'pay.edit': 'Edit',
  'pay.save': 'Save',
  'pay.w4Title': 'Federal W-4',
  'pay.w4None': 'No W-4 on file yet.',
  'pay.w4SetUp': 'Set up your W-4',
  'pay.filing.SINGLE': 'Single or married filing separately',
  'pay.filing.MARRIED_FILING_JOINTLY': 'Married filing jointly',
  'pay.filing.HEAD_OF_HOUSEHOLD': 'Head of household',
  'pay.w4FilingStatus': 'Filing status',
  'pay.w4Dependents': 'Dependents credit',
  'pay.w4OtherIncome': 'Other income',
  'pay.w4Deductions': 'Deductions',
  'pay.w4ExtraPerCheck': 'Extra withholding / check',
  'pay.w4DependentsField': 'Dependents credit (W-4 step 3)',
  'pay.w4OtherIncomeField': 'Other income (4a)',
  'pay.w4DeductionsField': 'Deductions (4b)',
  'pay.w4ExtraField': 'Extra withholding per check (4c)',
  'pay.w4MultipleJobs': 'Multiple jobs / spouse works (step 2)',
  'pay.w4UpdatedToast': 'W-4 updated — applies from your next paycheck.',
  'pay.w4UpdateFailed': 'Failed to update W-4.',
  'pay.ddTitle': 'Direct deposit',
  'pay.ddChange': 'Change',
  'pay.ddAdd': 'Add',
  'pay.ddNone': 'No direct-deposit account on file.',
  'pay.ddBranchCard': 'Paid to your Branch card.',
  'pay.ddAccountLine': '{type} account',
  'pay.ddBank': 'Bank',
  'pay.ddVerified': 'verified',
  'pay.ddPendingVerify': 'pending verification',
  'pay.ddRoutingPh': 'Routing number (9 digits)',
  'pay.ddAccountPh': 'Account number',
  'pay.ddConfirmPh': 'Confirm account number',
  'pay.ddMismatch': 'Account numbers don’t match — re-check both fields.',
  'pay.ddChecking': 'Checking',
  'pay.ddSavings': 'Savings',
  'pay.ddEmailNote':
    'We’ll email you a confirmation whenever this changes — a heads-up in case it wasn’t you.',
  'pay.ddValidation': 'Enter a 9-digit routing number and a valid account number.',
  'pay.ddUpdatedToast': 'Direct deposit updated (account ending {last4}).',
  'pay.ddUpdateFailed': 'Failed to update direct deposit.',

  // Pay — "ask about this paycheck" HR-case dialog
  'pay.askButton': 'Ask about this paycheck',
  'pay.askDesc':
    'This files an HR case with the paycheck’s details attached, so payroll can look into it and get back to you.',
  'pay.askLabel': 'What’s your question?',
  'pay.askPlaceholder': 'e.g., My paycheck shows as failed — when will it be re-sent?',
  'pay.askEmpty': 'Tell us what you need help with first.',
  'pay.askSentToast': 'Sent — HR will follow up on your paycheck.',
  'pay.askSendFailed': 'Could not send your question.',
  'pay.askSend': 'Send',

  // Login
  'login.title': 'Sign in',
  'login.subtitle': 'Use your Alto HR credentials.',
  'login.brandTagline': 'Your schedule, time clock, and pay',
  'login.email': 'Email',
  'login.password': 'Password',
  'login.forgot': 'Forgot password?',
  'login.minChars': 'Minimum 12 characters.',
  'login.signIn': 'Sign in',
  'login.signingIn': 'Signing in…',
  'login.errInvalid': 'Invalid email or password.',
  'login.errNetwork': 'Network error — check your connection and try again.',
  'login.errRateLimited': 'Too many login attempts. Please wait a minute and try again.',
  'login.errServer': "We're having trouble signing you in. Please try again in a moment.",
  'login.securedBy': 'Secured by Alto HR',
  'login.or': 'or',
  'login.usePasskey': 'Use a passkey',
  'login.ssoButton': 'Sign in with SSO',
  'login.errSsoNoAccount':
    'No Alto account matches your SSO identity — ask your admin to invite you.',
  'login.errSsoFailed': 'SSO sign-in failed — try again or use your password.',
  'login.errPasskeyEmailFirst': 'Enter your email first, then use your passkey.',
  'login.errPasskey': 'Passkey sign-in failed — use your password instead.',

  // Login — two-step (MFA) challenge
  'login.mfaTitle': 'Two-step sign-in',
  'login.mfaRecoveryDesc':
    'Enter one of the recovery codes you saved when you set up two-step sign-in. Each code works once.',
  'login.mfaCodeDesc': 'Enter the 6-digit code from your authenticator app.',
  'login.recoveryCode': 'Recovery code',
  'login.authCode': 'Authenticator code',
  'login.verifying': 'Verifying…',
  'login.verifyAndSignIn': 'Verify and sign in',
  'login.useAuthCodeInstead': 'Use authenticator code instead',
  'login.useRecoveryInstead': 'Use a recovery code instead',
  'login.errCodeRateLimited': 'Too many code attempts. Try again in a few minutes.',
  'login.errSignInExpired': 'Sign-in expired. Please start again.',
  'login.errCodeInvalid': 'That code is incorrect or expired.',
  'login.errCodeVerifyServer':
    "We're having trouble verifying your code. Please try again in a moment.",
  'login.errCodeVerify': 'Could not verify code.',

  // Login — org-enforced MFA enrollment
  'login.enrollTitle': 'Set up two-step sign-in',
  'login.enrollBody':
    'Your organization requires two-step sign-in for this account. Scan the QR code with an authenticator app, save your recovery codes, and enter a code to finish signing in.',
  'login.errEnrollStart': 'Could not start setup. Try signing in again.',
  'login.qrAlt': 'Scan with your authenticator app',
  'login.manualSecret': 'Manual entry secret',
  'login.recoveryCodesLabel': 'Recovery codes — save these now',
  'login.recoveryCodesHint':
    'Each code works once — they are the only way in if you lose your phone.',
  'login.ackSaved': "I've saved my recovery codes somewhere safe.",
  'login.enrollCodeLabel': '6-digit code from your authenticator app',
  'login.turnOnAndSignIn': 'Turn on and sign in',
} as const;

export type MessageKey = keyof typeof en;

const es: Record<MessageKey, string> = {
  'tabs.home': 'Inicio',
  'tabs.schedule': 'Horario',
  'tabs.clock': 'Reloj',
  'tabs.timeOff': 'Ausencias',
  'tabs.pay': 'Pago',
  'tabs.more': 'Más',
  'tabs.moreAria': 'Más — abrir la navegación completa',

  'common.retry': 'Reintentar',
  'common.cancel': 'Cancelar',
  'common.search': 'Buscar…',
  'common.language': 'Idioma',
  'common.undo': 'Deshacer',
  'common.from': 'Desde',
  'common.to': 'Hasta',
  'common.gotIt': 'Entendido',
  'whatsnew.title': 'Novedades de la semana',
  'whatsnew.weekAhead':
    'Recibirás “Tu semana” la noche antes de que empiece tu semana laboral.',
  'whatsnew.espanol': 'La aplicación ahora habla español — cámbialo en el menú.',
  'nav.pinned': 'Fijados',

  'dash.greeting': 'Hola {name} 👋',
  'dash.subtitle': 'Esto es lo que hay para hoy.',
  'dash.clock': 'Reloj',
  'dash.onClock': 'En turno',
  'dash.offClock': 'Fuera de turno',
  'dash.startedIn': 'Entrada {time} · {elapsed} trabajadas',
  'dash.kioskHint': 'Marca con tu PIN en la tableta del quiosco de tu sitio de trabajo.',
  'dash.nextShift': 'Próximo turno',
  'dash.nothingScheduled': 'Nada programado',
  'dash.managerWillPublish':
    'Tu gerente publicará los turnos antes de la semana. Vuelve pronto.',
  'dash.viewSchedule': 'Ver horario',
  'dash.seeFullSchedule': 'Ver horario completo',
  'dash.lastPaystub': 'Último recibo de pago',
  'dash.noPaystubs': 'Aún no hay recibos',
  'dash.firstPaystub':
    'El primero aparecerá aquí cuando tu gerente procese la nómina.',
  'dash.netWorked': 'Neto · {hours}h trabajadas',
  'dash.paidOn': 'pagado {date}',
  'dash.viewPayHistory': 'Ver historial de pagos',
  'dash.timeOff': 'Ausencias',
  'dash.noBalance': 'Aún sin saldo',
  'dash.sickAccrues':
    'Las horas por enfermedad se acumulan automáticamente al trabajar.',
  'dash.openTimeOff': 'Abrir ausencias',
  'dash.requestOrView': 'Solicitar o ver saldo',
  'dash.quickLinks': 'Accesos rápidos',
  'dash.myTimesheet': 'Mi hoja de horas',
  'dash.scheduleSwaps': 'Horario y cambios',
  'dash.documents': 'Documentos',
  'dash.requestTimeOff': 'Solicitar ausencia',
  'dash.loadFailed': 'No se pudo cargar',
  'dash.checkConnection': 'Revisa tu conexión e inténtalo de nuevo.',
  'dash.pushTitle': 'Recibe alertas de turnos en tu pantalla de bloqueo',
  'dash.pushBody':
    'Nuevos turnos, cambios y recordatorios — incluso con la app cerrada.',
  'dash.pushOn': 'Activar',
  'dash.pushLater': 'Ahora no',
  'dash.actionNeeded': 'Acción necesaria',
  'dash.allCaughtUp': 'Estás al día ✓',
  'dash.actionAgreements': '{count} acuerdo espera tu firma',
  'dash.actionAgreementsPlural': '{count} acuerdos esperan tu firma',
  'dash.actionDocs': '{count} documento necesita tu atención',
  'dash.actionDocsPlural': '{count} documentos necesitan tu atención',
  'dash.actionShifts': '{count} turno próximo por confirmar',
  'dash.actionShiftsPlural': '{count} turnos próximos por confirmar',
  'dash.actionInbox': '{count} mensaje sin leer en tu bandeja de entrada',
  'dash.actionInboxPlural': '{count} mensajes sin leer en tu bandeja de entrada',
  'dash.pushOnToast':
    'Notificaciones activadas — te avisaremos de tus turnos incluso con la app cerrada.',
  'dash.pushFailed': 'No se pudieron activar las notificaciones.',

  'sched.title': 'Mi horario',
  'sched.subtitle': 'Tus turnos publicados.',
  'sched.list': 'Lista',
  'sched.week': 'Semana',
  'sched.month': 'Mes',
  'sched.viewAria': 'Vista del horario',
  'sched.refresh': 'Actualizar',
  'sched.upcoming': 'Próximos',
  'sched.thisWeek': 'Esta semana',
  'sched.nextWeek': 'Próxima semana',
  'sched.over40': 'Más de 40h — consulta con tu gerente',
  'sched.shiftsWord': '{count} turno',
  'sched.shiftsWordPlural': '{count} turnos',
  'sched.noUpcoming': 'No hay turnos próximos.',
  'sched.noShifts': 'Aún no hay turnos',
  'sched.emptyDesc':
    'Cuando un gerente publique un turno para ti, aparecerá aquí. Publica tu disponibilidad abajo para facilitar la programación.',
  'sched.unlinked':
    'Tu cuenta no está vinculada a un registro de empleado, así que no se puede mostrar tu horario. Pide a RR. HH. que vincule tu cuenta — los turnos asignados a ti aparecerán aquí cuando se corrija.',
  'sched.truncated':
    'Mostrando tus próximos 100 turnos — lo programado más allá aparecerá aquí a medida que pasen los anteriores.',
  'sched.showRecent': 'Mostrar turnos recientes ({count})',
  'sched.hideRecent': 'Ocultar turnos recientes ({count})',
  'sched.loadOlder': 'Cargar turnos anteriores',
  'sched.fullHistory': 'Ese es todo tu historial de turnos.',
  'sched.offline': 'Sin conexión — mostrando tu horario de {time}.',
  'sched.loadFailed': 'No se pudo cargar.',
  'sched.loadOlderFailed': 'No se pudieron cargar los turnos anteriores.',

  'sched.openHeading': 'Turnos abiertos que puedes tomar ({count})',
  'sched.openRequested': 'Solicitado',
  'sched.openWithdraw': 'Retirar',
  'sched.openPickUp': 'Tomar',
  'sched.pickupToast': 'Turno solicitado — tu gerente lo confirmará.',
  'sched.pickupFailed': 'No se pudo solicitar este turno.',
  'sched.withdrawFailed': 'No se pudo retirar la solicitud.',
  'sched.pickupConfirmTitle': '¿Solicitar este turno?',
  'sched.pickupConfirmNote':
    'Tu gerente confirma los turnos tomados antes de que sean definitivos.',
  'sched.pickupConfirmLabel': 'Solicitar turno',

  'sched.calTitle': 'Suscríbete desde tu calendario',
  'sched.calBody':
    'Agrega esta URL una vez y tus turnos publicados aparecerán en los calendarios de Google, Apple u Outlook — se actualizan cada hora. No la compartas; cualquiera con el enlace puede ver tu horario.',
  'sched.calLoadFailed': 'No se pudo cargar la URL del calendario.',
  'sched.calUnavailable':
    'La suscripción al calendario no está disponible en este momento.',
  'sched.calCopyUrl': 'Copiar URL',
  'sched.calCopied': 'Copiada',
  'sched.calCopiedToast': 'URL del calendario copiada. Pégala en Google u Outlook.',
  'sched.calCopyFailed':
    'No se pudo copiar — mantén presionada la URL para copiarla manualmente.',
  'sched.calOpenApple': 'Abrir en Calendario de Apple',
  'sched.calResetLink': 'Restablecer enlace',
  'sched.calResetConfirmTitle': '¿Restablecer tu enlace de calendario?',
  'sched.calResetConfirmDesc':
    'Si este enlace se llegó a compartir, restablecerlo bloquea el anterior de inmediato. Cualquier calendario suscrito con el enlace actual dejará de actualizarse — tendrás que volver a suscribirte con el nuevo.',
  'sched.calResetToast':
    'Nuevo enlace creado. Vuelve a suscribirte en tu app de calendario — el enlace anterior ya no funciona.',
  'sched.calResetFailed': 'No se pudo restablecer el enlace.',

  'shift.next': 'Próximo',
  'shift.confirmed': 'Confirmado',
  'shift.open': 'Abierto',
  'shift.worked': 'Trabajado',
  'shift.draft': 'Borrador',
  'shift.cancelled': 'Cancelado',
  'shift.workingWithYou': 'Trabajan contigo',
  'shift.noTeammates': 'Nadie más está programado junto a este turno todavía.',
  'shift.managerNote': 'Nota de tu gerente: ',
  'shift.illBeThere': 'Ahí estaré',
  'shift.youConfirmed': 'Confirmaste este turno',
  'shift.confirmedToast': 'Confirmado — tu gerente puede ver que lo aceptaste.',
  'shift.offerToTeammate': 'Ofrecer este turno a un compañero',
  'shift.offerTo': 'Ofrecer a',
  'shift.loadingTeammates': 'Cargando compañeros…',
  'shift.pickTeammate': 'Elige un compañero',
  'shift.busyDuring': ' — ocupado durante este turno',
  'shift.tradeLabel': 'Tomar uno de sus turnos a cambio (opcional)',
  'shift.justHandOff': 'Nada — solo entregar el mío',
  'shift.noteOptional': 'Nota (opcional)',
  'shift.notePlaceholder': 'p. ej. Cita médica esa mañana',
  'shift.sendRequest': 'Enviar solicitud',
  'shift.detailFailed': 'No se pudieron cargar los detalles del turno.',
  'shift.confirmFailed': 'No se pudo confirmar el turno.',
  'shift.teammatesFailed': 'No se pudieron cargar los compañeros.',
  'shift.tradeProposedToast':
    'Intercambio propuesto. Primero acepta tu compañero y luego tu gerente aprueba ambas partes.',
  'shift.swapSentToast':
    'Solicitud de cambio enviada. Síguela abajo en Cambios de turno — tu gerente tiene la última palabra.',
  'shift.swapSendFailed': 'No se pudo enviar la solicitud de cambio.',

  'swap.title': 'Cambios de turno',
  'swap.tabIncoming': 'recibidas',
  'swap.tabOutgoing': 'enviadas',
  'swap.loadFailed': 'No se pudo cargar.',
  'swap.actionFailed': 'No se pudo completar la acción.',
  'swap.emptyIncomingTitle': 'No hay solicitudes de cambio recibidas',
  'swap.emptyOutgoingTitle': 'No hay solicitudes de cambio enviadas',
  'swap.emptyIncomingDesc':
    'Cuando un compañero te pida cambiar un turno, aparecerá aquí.',
  'swap.emptyOutgoingDesc':
    'Solicita un cambio desde tu turno asignado en el horario de arriba.',
  'swap.theyTake': 'Toman tu turno: ',
  'swap.youTake': 'Tomas su turno: ',
  'swap.from': 'De',
  'swap.to': 'Para',
  'swap.accept': 'Aceptar',
  'swap.decline': 'Rechazar',
  'swap.declineConfirmTitle': '¿Rechazar esta solicitud de cambio?',
  'swap.declineConfirmDesc': 'Se notificará a {name} que la rechazaste.',
  'swap.stWaitingYou': 'Esperando que aceptes',
  'swap.stWaitingYouHint':
    'Acepta o rechaza abajo — después un gerente da la aprobación final.',
  'swap.stWaitingPeer': 'Esperando que {name} acepte',
  'swap.stWaitingPeerHint': 'Cuando acepte, un gerente da la aprobación final.',
  'swap.stAccepted': 'Aceptado — esperando la aprobación del gerente',
  'swap.stAcceptedHint': 'Te avisaremos cuando un gerente decida.',
  'swap.stYouDeclined': 'La rechazaste',
  'swap.stPeerDeclined': '{name} la rechazó',
  'swap.stApproved': 'Aprobado — horarios actualizados',
  'swap.stRejected': 'No aprobado',
  'swap.stRejectedHint':
    'Un gerente rechazó este cambio — el turno queda como estaba programado.',
  'swap.stCancelledByRequester': '{name} canceló esta solicitud',
  'swap.stCancelled': 'Cancelada',

  'time.title': 'Tiempo y asistencia',
  'time.subtitle': 'Marca tu entrada en el quiosco del sitio de trabajo.',
  'time.kioskHeading': 'Usa la tableta de marcaje en tu sitio de trabajo',
  'time.kioskBody':
    'Los asociados por hora marcan entrada y salida en la tableta del quiosco instalada en su sitio, no desde un teléfono personal. Ingresa tu PIN de 4 dígitos, tómate la selfie y quedas registrado. Pregunta a tu gerente si aún no conoces tu PIN.',
  'time.myTimesheet': 'Mi hoja de horas',
  'time.myTimesheetDesc':
    'Cada marcaje del quiosco con tus horas y su estado de aprobación.',
  'time.approvedTotal': '{hours} aprobadas',
  'time.pendingTotal': '{hours} por revisar',
  'time.stillOn': 'aún en turno',
  'time.breakMinutes': '{minutes}m de descanso',
  'time.noEntries': 'No hay marcajes en este rango',
  'time.noEntriesDesc':
    'Los marcajes del quiosco de tu sitio aparecerán aquí en cuanto marques entrada.',
  'time.loadFailed': 'No se pudo cargar tu hoja de horas.',
  'time.status.ACTIVE': 'En turno',
  'time.status.COMPLETED': 'Por revisar',
  'time.status.APPROVED': 'Aprobado',
  'time.status.REJECTED': 'Rechazado',
  'time.lastWeek': 'Semana pasada',
  'time.last14': 'Últimos 14 días',
  'time.rangeAria': 'Rangos rápidos de fechas',
  'time.weekOf': 'Semana del {date}',
  'time.weekOvertime': 'incluye {hours} extra',
  'time.scheduled': 'Programado {range}',
  'time.grossEstimate': '≈ {amount} bruto (aprobado)',
  'time.grossLabel': '≈ Bruto est.',
  'time.grossDisclaimer':
    'Estimación antes de impuestos y deducciones — no es un comprobante de pago.',
  'time.reportIssue': 'Reportar un problema',
  'time.reportIssueDesc':
    'Cuéntale a RR. HH. qué está mal con este registro. La fecha y las horas se adjuntan automáticamente, y puedes seguir el caso en Casos de RR. HH.',
  'time.whatsWrong': '¿Qué está mal?',
  'time.reportPlaceholder': 'p. ej. Marqué salida a las 5:00, no a las 4:30',
  'time.send': 'Enviar a RR. HH.',
  'time.reportSent': 'Enviado — RR. HH. te responderá.',
  'time.reportFailed': 'No se pudo enviar',

  'timeoff.title': 'Ausencias',
  'timeoff.subtitle': 'Envía una solicitud, consulta tu saldo y sigue las aprobaciones.',
  'timeoff.request': 'Solicitar ausencia',
  'timeoff.myRequests': 'Mis solicitudes',
  'timeoff.mostRecentFirst': 'Las más recientes primero',
  'timeoff.noRequests': 'Aún no hay solicitudes',
  'timeoff.noRequestsDesc': 'Envía una con el botón de arriba. Se notificará a RR. HH.',
  'timeoff.withdraw': 'Retirar',
  'timeoff.noteFrom': 'Nota de {who}:',
  'timeoff.hr': 'RR. HH.',
  'timeoff.noBalance': 'Aún sin saldo acumulado',
  'timeoff.noBalanceDesc':
    'Las horas por enfermedad se acumulan automáticamente al trabajar. Las demás categorías empiezan en 0 y las agrega RR. HH.',
  'timeoff.available': 'disponible',
  'timeoff.status.PENDING': 'Pendiente',
  'timeoff.status.APPROVED': 'Aprobada',
  'timeoff.status.DENIED': 'Denegada',
  'timeoff.status.CANCELLED': 'Retirada',
  'timeoff.cat.SICK': 'Enfermedad',
  'timeoff.cat.VACATION': 'Vacaciones',
  'timeoff.cat.PTO': 'PTO',
  'timeoff.cat.BEREAVEMENT': 'Duelo',
  'timeoff.cat.JURY_DUTY': 'Deber de jurado',
  'timeoff.cat.OTHER': 'Otro',
  'timeoff.loadFailed': 'No se pudieron cargar los datos de ausencias',
  'timeoff.withdrawnToast': 'Solicitud retirada',
  'timeoff.cancelFailed': 'No se pudo cancelar',
  'timeoff.submittedToast': 'Solicitud enviada',
  'timeoff.submitFailed': 'No se pudo enviar',
  'timeoff.pickDates': 'Elige una fecha de inicio y una de fin',
  'timeoff.hoursPositive': 'Las horas deben ser mayores que 0',
  'timeoff.dialogDesc':
    'RR. HH. verá tu solicitud de inmediato. Te avisaremos cuando sea revisada.',
  'timeoff.category': 'Categoría',
  'timeoff.startDate': 'Fecha de inicio',
  'timeoff.endDate': 'Fecha de fin',
  'timeoff.totalHours': 'Horas totales',
  'timeoff.totalHoursHint': 'En incrementos de media hora. 8 = un día completo de trabajo.',
  'timeoff.reasonOptional': 'Motivo (opcional)',
  'timeoff.reasonPlaceholder': 'Evento familiar, cita médica, etc.',
  'timeoff.submit': 'Enviar',
  'timeoff.balanceLine': '{avail} disponibles · {after} restantes después de esta solicitud',
  'timeoff.balanceOver': 'Esta solicitud excede tu saldo disponible por {over}.',
  'timeoff.filterAll': 'Todas',
  'timeoff.filterAria': 'Filtrar solicitudes por estado',
  'timeoff.noneWithStatus': 'No hay solicitudes con este estado.',
  'timeoff.weekdayWord': '{count} día hábil',
  'timeoff.weekdayWordPlural': '{count} días hábiles',
  'timeoff.holidayWord': '{count} día festivo',
  'timeoff.holidayWordPlural': '{count} días festivos',
  'timeoff.dayWord': '{count} día',
  'timeoff.dayWordPlural': '{count} días',
  'timeoff.fullDays': 'Días completos ({hours}h)',
  'timeoff.halfDays': 'Medios días ({hours}h)',

  'pay.title': 'Mi pago',
  'pay.subtitle': 'Recibos de pago recientes con totales acumulados del año.',
  'pay.loadFailed': 'No se pudo cargar.',
  'pay.ytdLoadFailed': 'No se pudieron cargar los totales del año.',
  'pay.noPaystubs': 'Aún no hay recibos',
  'pay.noPaystubsDesc':
    'Tu primer recibo aparecerá aquí cuando se procese la nómina de un período que trabajaste.',
  'pay.pendingCount': 'Pendientes ({count})',
  'pay.paystubWord': '{count} recibo',
  'pay.paystubWordPlural': '{count} recibos',
  'pay.hrsAtRate': '{hours} h · {rate}/h',
  'pay.gross': 'Bruto',
  'pay.taxes': 'Impuestos',
  'pay.taxPlusPostTax': 'Impuestos + post-impuestos',
  'pay.net': 'Neto',
  'pay.netPay': 'Pago neto',
  'pay.ytdNet': 'Neto acumulado {amount}',
  'pay.earnings': 'Ingresos',
  'pay.deductions': 'Deducciones',
  'pay.employerContrib': 'Aportes del empleador (informativo)',
  'pay.colHours': 'Horas',
  'pay.colRate': 'Tarifa',
  'pay.colCurrent': 'Actual',
  'pay.colYtd': 'Acum.',
  'pay.grossPay': 'Pago bruto',
  'pay.fedIncomeTax': 'Impuesto federal sobre la renta',
  'pay.socialSecurity': 'Seguro Social (FICA)',
  'pay.medicare': 'Medicare',
  'pay.stateIncomeTax': 'Impuesto estatal sobre la renta',
  'pay.garnishments': 'Embargos / post-impuestos',
  'pay.totalDeductions': 'Total de deducciones',
  'pay.employerFica': 'Aporte FICA del empleador',
  'pay.employerMedicare': 'Aporte Medicare del empleador',
  'pay.futa': 'Desempleo federal (FUTA)',
  'pay.suta': 'Desempleo estatal (SUTA)',
  'pay.disbursementRef': 'Ref. de desembolso: {ref}',
  'pay.downloadPdf': 'Descargar PDF',
  'pay.downloadFailed': 'Error al descargar.',
  'pay.status.PENDING': 'Pendiente',
  'pay.status.DISBURSED': 'Pagado',
  'pay.status.FAILED': 'Fallido',
  'pay.status.HELD': 'Retenido',
  'pay.status.VOIDED': 'Anulado',
  'pay.kind.REGULAR': 'Regular',
  'pay.kind.OVERTIME': 'Horas extra',
  'pay.kind.DOUBLE_TIME': 'Tiempo doble',
  'pay.kind.HOLIDAY': 'Festivo',
  'pay.kind.SICK': 'Enfermedad',
  'pay.kind.VACATION': 'Vacaciones',
  'pay.kind.BONUS': 'Bono',
  'pay.kind.COMMISSION': 'Comisión',
  'pay.kind.TIPS': 'Propinas',
  'pay.kind.REIMBURSEMENT': 'Reembolso (no gravable)',

  'pay.taxSettingsTitle': 'Impuestos y configuración de pago',
  'pay.taxDocs': 'Documentos fiscales',
  'pay.taxDocsHint': 'W-2 y formularios de fin de año →',
  'pay.edit': 'Editar',
  'pay.save': 'Guardar',
  'pay.w4Title': 'W-4 federal',
  'pay.w4None': 'Aún no hay un W-4 registrado.',
  'pay.w4SetUp': 'Configura tu W-4',
  'pay.filing.SINGLE': 'Soltero(a) o casado(a) que declara por separado',
  'pay.filing.MARRIED_FILING_JOINTLY': 'Casado(a) que declara en conjunto',
  'pay.filing.HEAD_OF_HOUSEHOLD': 'Cabeza de familia',
  'pay.w4FilingStatus': 'Estado civil tributario',
  'pay.w4Dependents': 'Crédito por dependientes',
  'pay.w4OtherIncome': 'Otros ingresos',
  'pay.w4Deductions': 'Deducciones',
  'pay.w4ExtraPerCheck': 'Retención extra por cheque',
  'pay.w4DependentsField': 'Crédito por dependientes (paso 3 del W-4)',
  'pay.w4OtherIncomeField': 'Otros ingresos (4a)',
  'pay.w4DeductionsField': 'Deducciones (4b)',
  'pay.w4ExtraField': 'Retención extra por cheque (4c)',
  'pay.w4MultipleJobs': 'Varios empleos / tu cónyuge trabaja (paso 2)',
  'pay.w4UpdatedToast': 'W-4 actualizado — se aplica desde tu próximo pago.',
  'pay.w4UpdateFailed': 'No se pudo actualizar el W-4.',
  'pay.ddTitle': 'Depósito directo',
  'pay.ddChange': 'Cambiar',
  'pay.ddAdd': 'Agregar',
  'pay.ddNone': 'No hay una cuenta de depósito directo registrada.',
  'pay.ddBranchCard': 'Se te paga a tu tarjeta Branch.',
  'pay.ddAccountLine': 'Cuenta {type}',
  'pay.ddBank': 'bancaria',
  'pay.ddVerified': 'verificada',
  'pay.ddPendingVerify': 'verificación pendiente',
  'pay.ddRoutingPh': 'Número de ruta (9 dígitos)',
  'pay.ddAccountPh': 'Número de cuenta',
  'pay.ddConfirmPh': 'Confirma el número de cuenta',
  'pay.ddMismatch': 'Los números de cuenta no coinciden — revisa ambos campos.',
  'pay.ddChecking': 'Corriente',
  'pay.ddSavings': 'De ahorros',
  'pay.ddEmailNote':
    'Te enviaremos un correo de confirmación cada vez que esto cambie — un aviso por si no fuiste tú.',
  'pay.ddValidation':
    'Ingresa un número de ruta de 9 dígitos y un número de cuenta válido.',
  'pay.ddUpdatedToast': 'Depósito directo actualizado (cuenta que termina en {last4}).',
  'pay.ddUpdateFailed': 'No se pudo actualizar el depósito directo.',
  'pay.askButton': 'Preguntar sobre este pago',
  'pay.askDesc':
    'Esto crea un caso de RR. HH. con los detalles del pago adjuntos, para que nómina lo revise y te responda.',
  'pay.askLabel': '¿Cuál es tu pregunta?',
  'pay.askPlaceholder': 'p. ej., Mi pago aparece como fallido — ¿cuándo se reenviará?',
  'pay.askEmpty': 'Cuéntanos primero en qué necesitas ayuda.',
  'pay.askSentToast': 'Enviado — RR. HH. te responderá sobre tu pago.',
  'pay.askSendFailed': 'No se pudo enviar tu pregunta.',
  'pay.askSend': 'Enviar',

  'login.title': 'Iniciar sesión',
  'login.subtitle': 'Usa tus credenciales de Alto HR.',
  'login.brandTagline': 'Tu horario, tu reloj y tu pago',
  'login.email': 'Correo electrónico',
  'login.password': 'Contraseña',
  'login.forgot': '¿Olvidaste tu contraseña?',
  'login.minChars': 'Mínimo 12 caracteres.',
  'login.signIn': 'Iniciar sesión',
  'login.signingIn': 'Iniciando sesión…',
  'login.errInvalid': 'Correo o contraseña incorrectos.',
  'login.errNetwork': 'Error de red — revisa tu conexión e inténtalo de nuevo.',
  'login.errRateLimited':
    'Demasiados intentos de inicio de sesión. Espera un minuto e inténtalo de nuevo.',
  'login.errServer':
    'Tenemos problemas para iniciar tu sesión. Inténtalo de nuevo en un momento.',
  'login.securedBy': 'Protegido por Alto HR',
  'login.or': 'o',
  'login.usePasskey': 'Usar una llave de acceso',
  'login.ssoButton': 'Iniciar sesión con SSO',
  'login.errSsoNoAccount':
    'Ninguna cuenta de Alto coincide con tu identidad de SSO — pide a tu administrador que te invite.',
  'login.errSsoFailed':
    'No se pudo iniciar sesión con SSO — inténtalo de nuevo o usa tu contraseña.',
  'login.errPasskeyEmailFirst':
    'Ingresa primero tu correo y luego usa tu llave de acceso.',
  'login.errPasskey':
    'No se pudo iniciar sesión con la llave de acceso — usa tu contraseña.',
  'login.mfaTitle': 'Inicio de sesión en dos pasos',
  'login.mfaRecoveryDesc':
    'Ingresa uno de los códigos de recuperación que guardaste al configurar el inicio de sesión en dos pasos. Cada código funciona una sola vez.',
  'login.mfaCodeDesc': 'Ingresa el código de 6 dígitos de tu aplicación de autenticación.',
  'login.recoveryCode': 'Código de recuperación',
  'login.authCode': 'Código del autenticador',
  'login.verifying': 'Verificando…',
  'login.verifyAndSignIn': 'Verificar e iniciar sesión',
  'login.useAuthCodeInstead': 'Usar el código del autenticador',
  'login.useRecoveryInstead': 'Usar un código de recuperación',
  'login.errCodeRateLimited':
    'Demasiados intentos de código. Inténtalo de nuevo en unos minutos.',
  'login.errSignInExpired': 'El inicio de sesión expiró. Vuelve a empezar.',
  'login.errCodeInvalid': 'Ese código es incorrecto o ya expiró.',
  'login.errCodeVerifyServer':
    'Tenemos problemas para verificar tu código. Inténtalo de nuevo en un momento.',
  'login.errCodeVerify': 'No se pudo verificar el código.',
  'login.enrollTitle': 'Configura el inicio de sesión en dos pasos',
  'login.enrollBody':
    'Tu organización requiere el inicio de sesión en dos pasos para esta cuenta. Escanea el código QR con una aplicación de autenticación, guarda tus códigos de recuperación e ingresa un código para terminar de iniciar sesión.',
  'login.errEnrollStart':
    'No se pudo iniciar la configuración. Intenta iniciar sesión de nuevo.',
  'login.qrAlt': 'Escanéalo con tu aplicación de autenticación',
  'login.manualSecret': 'Clave para ingreso manual',
  'login.recoveryCodesLabel': 'Códigos de recuperación — guárdalos ahora',
  'login.recoveryCodesHint':
    'Cada código funciona una sola vez — son la única forma de entrar si pierdes tu teléfono.',
  'login.ackSaved': 'Guardé mis códigos de recuperación en un lugar seguro.',
  'login.enrollCodeLabel': 'Código de 6 dígitos de tu aplicación de autenticación',
  'login.turnOnAndSignIn': 'Activar e iniciar sesión',
};

const MESSAGES: Record<Lang, Record<MessageKey, string>> = { en, es };

function detectLang(): Lang {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'en' || stored === 'es') return stored;
    return navigator.language?.toLowerCase().startsWith('es') ? 'es' : 'en';
  } catch {
    return 'en';
  }
}

function format(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_, k: string) =>
    k in vars ? String(vars[k]) : `{${k}}`,
  );
}

export type Translate = (
  key: MessageKey,
  vars?: Record<string, string | number>,
) => string;

interface I18nContextValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: Translate;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(detectLang);

  useEffect(() => {
    // Keep <html lang> honest for screen readers and hyphenation.
    document.documentElement.lang = lang;
  }, [lang]);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Storage unavailable — the choice just doesn't persist.
    }
  }, []);

  const t = useCallback<Translate>(
    (key, vars) => format(MESSAGES[lang][key] ?? en[key] ?? key, vars),
    [lang],
  );

  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

const FALLBACK: I18nContextValue = {
  lang: 'en',
  setLang: () => {},
  t: (key, vars) => format(en[key] ?? key, vars),
};

/** Works without a provider (English) so isolated component tests and
 *  storybook-style renders don't need wrapping. */
export function useI18n(): I18nContextValue {
  return useContext(I18nContext) ?? FALLBACK;
}
