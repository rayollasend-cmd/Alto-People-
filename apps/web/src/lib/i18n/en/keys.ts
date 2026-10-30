// Every English key, as a type only — no pack is loaded by importing this.
import type { enCore } from './core';
import type { enHugoPane } from './hugoPane';
import type { enHugoWork } from './hugoWork';
import type { enAddr } from './addr';
import type { enAdminHome } from './adminHome';
import type { enAgr } from './agr';
import type { enAgreementsPage } from './agreementsPage';
import type { enAi } from './ai';
import type { enAppr } from './appr';
import type { enAvail } from './avail';
import type { enBadge } from './badge';
import type { enBell } from './bell';
import type { enBreakq } from './breakq';
import type { enCal } from './cal';
import type { enCallout } from './callout';
import type { enCap } from './cap';
import type { enCareer } from './career';
import type { enClock } from './clock';
import type { enCrewText } from './crewText';
import type { enCrew } from './crew';
import type { enDash } from './dash';
import type { enDecisions } from './decisions';
import type { enDocs } from './docs';
import type { enDocscan } from './docscan';
import type { enDrive } from './drive';
import type { enEarn } from './earn';
import type { enEarned } from './earned';
import type { enEmergency } from './emergency';
import type { enEwa } from './ewa';
import type { enExecPortal } from './execPortal';
import type { enFleetOps } from './fleetOps';
import type { enFilters } from './filters';
import type { enFin } from './fin';
import type { enFloor } from './floor';
import type { enFloorUi } from './floorUi';
import type { enFocus } from './focus';
import type { enGrid } from './grid';
import type { enHandoff } from './handoff';
import type { enHeader } from './header';
import type { enHelp } from './help';
import type { enHero } from './hero';
import type { enHome } from './home';
import type { enHrc } from './hrc';
import type { enHugoSeat } from './hugoSeat';
import type { enHugoAdmin } from './hugoAdmin';
import type { enInbox } from './inbox';
import type { enInstall } from './install';
import type { enKb } from './kb';
import type { enLane } from './lane';
import type { enLearning } from './learning';
import type { enLrn } from './lrn';
import type { enManagerHome } from './managerHome';
import type { enMe } from './me';
import type { enMk } from './mk';
import type { enMsg } from './msg';
import type { enMyLeave } from './myLeave';
import type { enNeeds } from './needs';
import type { enNext14 } from './next14';
import type { enNotIn } from './notIn';
import type { enOb } from './ob';
import type { enOffers } from './offers';
import type { enOnbBanner } from './onbBanner';
import type { enOneOnOne } from './oneOnOne';
import type { enOpsRun } from './opsRun';
import type { enPay } from './pay';
import type { enPayCheck } from './payCheck';
import type { enPayNotice } from './payNotice';
import type { enPayrollHome } from './payrollHome';
import type { enPayx } from './payx';
import type { enPeople } from './people';
import type { enPhones } from './phones';
import type { enPhotocrop } from './photocrop';
import type { enPicker } from './picker';
import type { enPortal } from './portal';
import type { enPortalOps } from './portalOps';
import type { enPts } from './pts';
import type { enPush } from './push';
import type { enPw } from './pw';
import type { enRdq } from './rdq';
import type { enRecord } from './record';
import type { enRecruiterHome } from './recruiterHome';
import type { enRegion } from './region';
import type { enReimbDesk } from './reimbDesk';
import type { enReimbPage } from './reimbPage';
import type { enReviews } from './reviews';
import type { enRide } from './ride';
import type { enRmb } from './rmb';
import type { enRtw } from './rtw';
import type { enRunTotals } from './runTotals';
import type { enSched } from './sched';
import type { enSchedHome } from './schedHome';
import type { enSettings } from './settings';
import type { enSettingsPage } from './settingsPage';
import type { enShift } from './shift';
import type { enShiftLeads } from './shiftLeads';
import type { enSup } from './sup';
import type { enSupport } from './support';
import type { enSwap } from './swap';
import type { enTabs } from './tabs';
import type { enTheme } from './theme';
import type { enTile } from './tile';
import type { enTime } from './time';
import type { enTimeHome } from './timeHome';
import type { enTimefix } from './timefix';
import type { enTimeoff } from './timeoff';
import type { enTop } from './top';
import type { enTour } from './tour';
import type { enTrain } from './train';
import type { enW4est } from './w4est';
import type { enW9 } from './w9';
import type { enIjobs } from './ijobs';
import type { enBenme } from './benme';
import type { enWallet } from './wallet';
import type { enWeek } from './week';
import type { enWf } from './wf';
import type { enWhatsNewPage } from './whatsNewPage';
import type { enWhatsnew } from './whatsnew';

export type EnglishKey =
  | keyof typeof enCore
  | keyof typeof enHugoPane
  | keyof typeof enHugoWork
  | keyof typeof enAddr
  | keyof typeof enAdminHome
  | keyof typeof enAgr
  | keyof typeof enAgreementsPage
  | keyof typeof enAi
  | keyof typeof enAppr
  | keyof typeof enAvail
  | keyof typeof enBadge
  | keyof typeof enBell
  | keyof typeof enBreakq
  | keyof typeof enCal
  | keyof typeof enCallout
  | keyof typeof enCap
  | keyof typeof enCareer
  | keyof typeof enClock
  | keyof typeof enCrewText
  | keyof typeof enCrew
  | keyof typeof enDash
  | keyof typeof enDecisions
  | keyof typeof enDocs
  | keyof typeof enDocscan
  | keyof typeof enDrive
  | keyof typeof enEarn
  | keyof typeof enEarned
  | keyof typeof enEmergency
  | keyof typeof enEwa
  | keyof typeof enExecPortal
  | keyof typeof enFleetOps
  | keyof typeof enFilters
  | keyof typeof enFin
  | keyof typeof enFloor
  | keyof typeof enFloorUi
  | keyof typeof enFocus
  | keyof typeof enGrid
  | keyof typeof enHandoff
  | keyof typeof enHeader
  | keyof typeof enHelp
  | keyof typeof enHero
  | keyof typeof enHome
  | keyof typeof enHrc
  | keyof typeof enHugoSeat
  | keyof typeof enHugoAdmin
  | keyof typeof enInbox
  | keyof typeof enInstall
  | keyof typeof enKb
  | keyof typeof enLane
  | keyof typeof enLearning
  | keyof typeof enLrn
  | keyof typeof enManagerHome
  | keyof typeof enMe
  | keyof typeof enMk
  | keyof typeof enMsg
  | keyof typeof enMyLeave
  | keyof typeof enNeeds
  | keyof typeof enNext14
  | keyof typeof enNotIn
  | keyof typeof enOb
  | keyof typeof enOffers
  | keyof typeof enOnbBanner
  | keyof typeof enOneOnOne
  | keyof typeof enOpsRun
  | keyof typeof enPay
  | keyof typeof enPayCheck
  | keyof typeof enPayNotice
  | keyof typeof enPayrollHome
  | keyof typeof enPayx
  | keyof typeof enPeople
  | keyof typeof enPhones
  | keyof typeof enPhotocrop
  | keyof typeof enPicker
  | keyof typeof enPortal
  | keyof typeof enPortalOps
  | keyof typeof enPts
  | keyof typeof enPush
  | keyof typeof enPw
  | keyof typeof enRdq
  | keyof typeof enRecord
  | keyof typeof enRecruiterHome
  | keyof typeof enRegion
  | keyof typeof enReimbDesk
  | keyof typeof enReimbPage
  | keyof typeof enReviews
  | keyof typeof enRide
  | keyof typeof enRmb
  | keyof typeof enRtw
  | keyof typeof enRunTotals
  | keyof typeof enSched
  | keyof typeof enSchedHome
  | keyof typeof enSettings
  | keyof typeof enSettingsPage
  | keyof typeof enShift
  | keyof typeof enShiftLeads
  | keyof typeof enSup
  | keyof typeof enSupport
  | keyof typeof enSwap
  | keyof typeof enTabs
  | keyof typeof enTheme
  | keyof typeof enTile
  | keyof typeof enTime
  | keyof typeof enTimeHome
  | keyof typeof enTimefix
  | keyof typeof enTimeoff
  | keyof typeof enTop
  | keyof typeof enTour
  | keyof typeof enTrain
  | keyof typeof enW4est
  | keyof typeof enW9
  | keyof typeof enIjobs
  | keyof typeof enBenme
  | keyof typeof enWallet
  | keyof typeof enWeek
  | keyof typeof enWf
  | keyof typeof enWhatsNewPage
  | keyof typeof enWhatsnew;
