/**
 * Alto HR canonical onboarding content — single source of truth for the
 * Associate Employment Agreement (e-signed) and the 10 policies + handbook
 * ack (read + acknowledged via PolicyAckTask).
 *
 * The seed inserts these on `npm run db:seed`. The application-create flow
 * also auto-issues the Employment Agreement to every new application's
 * E_SIGN task using AGREEMENT_BODY below, so the moment HR sends an invite
 * the associate has the agreement ready to read and sign.
 *
 * Bumping AGREEMENT_VERSION (or any policy's version) does NOT mass-update
 * existing applications; it only affects new ones from that point forward.
 */

export const AGREEMENT_TITLE =
  'Alto HR — Associate Employment Agreement (Version 2.0, Effective 2026)';
export const AGREEMENT_VERSION = '2.0';

export const AGREEMENT_BODY = `ALTO ETHO LLC
DBA ALTO HR
108 Bailey Drive, Suite 2-851  |  Niceville, FL 32578
Phone: 850-749-3420  |  Email: hr@altohr.com  |  Website: altohr.co

ASSOCIATE EMPLOYMENT AGREEMENT
Version 2.0  |  Effective 2026
Temporary Staffing Agreement  |  Technology End User Agreement  |  Policy Acknowledgment

This Agreement governs the full employment relationship between Alto Etho LLC (DBA Alto HR) and the Associate. It incorporates the terms of use for Alto ShiftNexus (ASN) and Alto People — the proprietary technology platforms of Alto HR — and acknowledges the voluntary housing and transportation services provided through Helios Housing and Transportation. Standards reflect Walmart retail compliance requirements, U.S. hospitality industry standards, and applicable federal and Florida and Alabama state law. Please read this Agreement carefully and in its entirety before signing.

PART 1 — EMPLOYMENT TERMS AND CONDITIONS

Section 1 — Nature of Employment
1.1  Temporary Employment. The Associate is hired as a temporary employee of Alto Etho LLC, DBA Alto HR. This Agreement does not constitute an offer of permanent employment. Alto HR is a licensed temporary staffing agency operating in Florida and Alabama that places associates at client worksites including Walmart retail locations, hospitality and resort properties, food and beverage operations, warehouse and distribution facilities, and golf and recreation facilities.
1.2  At-Will Employment. Employment with Alto HR is at-will. Either party may terminate this employment relationship at any time, with or without cause and with or without advance notice, subject to applicable federal and state law.
1.3  Client Assignment. The Associate is assigned to perform services at the designated client worksite specified in Section A. Alto HR retains the right to reassign the Associate to a different client location, department, or shift at any time based on business need, client request, or performance.
1.4  Probationary Period. The first thirty (30) calendar days of employment constitute a probationary period. During this period Alto HR may terminate this Agreement without cause and without notice.
1.5  Seasonal Employment. Where applicable, this Agreement covers a defined seasonal employment period. Seasonal employment ends automatically at the conclusion of the defined season unless expressly extended in writing by Alto HR.
1.6  Multi-Client Environment. Alto HR serves clients across multiple industries including large-format retail (Walmart Supercenters and Neighborhood Markets), premier resort and hospitality operations, food and beverage establishments, golf and recreation clubs, and warehouse and distribution facilities. The performance standards, compliance requirements, and conduct expectations in this Agreement reflect the combined requirements of all client environments Alto HR serves.

Section 2 — Compensation and Pay
2.1  Hourly Rate. The Associate shall be compensated at the hourly rate specified in Section A. This rate is subject to review.
2.2  Pay Period. Alto HR processes payroll on a weekly basis. Associates are paid for all approved hours worked during the preceding pay week.
2.3  Timekeeping — Alto People. All time must be recorded through the Alto People geofenced clock-in system. The system verifies the Associate's GPS location before activating the clock-in function. The Associate must be physically present at their assigned client worksite to clock in. Alto HR does not accept paper timesheets or verbal time reporting. Timesheets not submitted within thirty (30) days of the work week are not eligible for payment and the fees for those hours are forfeited.
2.4  Overtime. Overtime is paid at one and one-half times (1.5x) the regular hourly rate for hours worked in excess of forty (40) in a single workweek, in accordance with the FLSA and applicable state law. Overtime must be approved in advance.
2.5  Pay Delivery — Branch Payroll Card. Associates who elect the Branch payroll card will have net pay loaded to their Branch card on each payday. The Branch card is issued by Branch's banking partner and is subject to Branch's separate cardholder agreement. Alto HR is not responsible for card fees, card loss, or issues arising from the Associate's use of the Branch card.
2.6  Payroll Deductions. Alto HR will deduct all legally required amounts from the Associate's pay including federal and state income tax, FICA, Medicare, and court-ordered garnishments. Where the Associate has elected and authorized Helios housing deductions in writing, those deductions will be applied automatically to the payroll cycle.
2.7  Earned Wage Access. Where available through Branch, Associates may access a portion of their earned wages before the standard payday. Use of earned wage access is governed by Branch's cardholder terms.

Section 3 — Work Schedule and Attendance
3.1  Scheduled Hours. The Associate's work schedule will be communicated through the Alto People scheduling platform. Schedules are published at least seventy-two (72) hours before the shift start time.
3.2  Shift Confirmation. Associates must confirm each scheduled shift no later than two (2) hours before the shift start time through the Alto People app. If the Associate cannot make a shift they must notify their Shift Lead through Alto People or by direct phone call no later than two (2) hours before the shift start. Failure to notify is considered a no-call no-show.
3.3  No-Call No-Show Policy. A no-call no-show is a serious attendance violation. Two no-call no-shows within a single season may result in termination. At Walmart locations a no-call no-show also affects Alto HR's fill rate score which is reported to Walmart's district leadership.
3.4  Attendance Standard. Alto HR maintains a fill rate target of 97% or above across all client locations. The Associate's attendance record is a component of their performance evaluation and affects their eligibility for the Alto HR Return Worker Program.

Section 4 — Workplace Conduct — All Client Types
4.1  Universal Conduct Standards. The following conduct will result in immediate termination regardless of client type:
- Theft, fraud, dishonesty, or misrepresentation of any kind
- Physical altercation, harassment, or threatening behavior toward any person
- Possession or use of alcohol or illegal substances during work hours or on client premises
- Unauthorized access to or use of client technology systems, registers, or security equipment
- Falsification of time records, safety logs, temperature logs, or any compliance documentation
- Violation of client confidentiality or data privacy policies
- Unauthorized photography or recording at any client worksite
- Violation of the Alto People or Alto ShiftNexus End User Agreement
4.2  Walmart-Specific Conduct Standards. At Walmart client locations the Associate additionally agrees to:
- Follow all Walmart store policies and procedures as communicated by the Alto HR Shift Lead
- Never interact with Walmart's inventory systems, POS registers, or internal software
- Never accept direction from Walmart employees regarding duties beyond the scope of the Alto HR shift assignment without Shift Lead approval
- Maintain fire lane clearance at all times and photograph clearance in ASN at shift close
- Complete all ASN department compliance modules before the shift may close — no exceptions
4.3  Hospitality and Resort Conduct Standards. At hospitality client locations including resorts, hotels, golf clubs, and restaurants the Associate additionally agrees to:
- Maintain the elevated appearance standard described in the Uniform Policy — pressed, clean, and client-appropriate at all times
- Address all guests, members, and clients professionally and courteously — the guest experience is the product
- Never discuss operational details, staffing arrangements, or Alto HR's client relationship with guests or members
- Follow all client-specific service standards and guest interaction protocols as directed by the client supervisor
- Report any guest complaint, incident, or safety concern to the Shift Lead immediately and through Alto People
4.4  Client Worksite Authority. The Associate acknowledges that the client may request removal of any Alto HR associate from their worksite at any time for any reason. Such a request results in the immediate end of the assignment. Alto HR may terminate employment as a result of a client removal request.

Section 5 — Housing and Transportation — Helios Services
5.1  Helios Partnership. Alto HR has partnered with Helios Housing and Transportation to offer associates access to optional housing and daily transportation services near client worksites along the Emerald Coast corridor and in other markets where Alto HR operates.
5.2  Voluntary Participation. Participation in Helios housing and transportation services is entirely voluntary and is not a condition of employment with Alto HR unless expressly stated otherwise in the Associate's individual employment agreement. Associates are free to arrange their own independent housing and transportation without any impact on their employment status, compensation, or scheduling.
5.3  Associate Acknowledgment — Independent Arrangements. Associates who choose not to use Helios services acknowledge and agree to the following:
- Their independent housing and transportation arrangement must not interfere with their ability to report to work on time and in compliance with their scheduled shift at their assigned client location
- Transportation failures, housing disruptions, or personal logistical issues do not constitute a valid excuse for tardiness, absenteeism, or no-shows — the same attendance standards apply regardless of housing or transportation choice
- Alto HR bears no responsibility for the Associate's housing costs, transportation costs, personal safety in transit, or the reliability of their independent arrangements
- Repeated attendance violations attributable to independent housing or transportation arrangements will be treated as standard attendance violations under this Agreement
5.4  J-1 Program Participants — Housing and Transportation. J-1 visa associates may arrange independent housing and transportation subject to the following conditions:
- The Associate's independent housing arrangement must be legal, safe, and in compliance with all applicable local housing ordinances and health and safety codes
- The independent housing arrangement must not violate any J-1 program sponsor guidelines or State Department requirements regarding participant housing standards
- The Associate's housing address must be reported to Alto HR's HR Administrator and to the J-1 program sponsor immediately upon establishment and upon any change, as required by SEVIS reporting obligations
- The Associate's independent transportation arrangement must not result in a pattern of tardiness, absences, or no-shows that would constitute a violation of J-1 program participation requirements or jeopardize the Associate's visa status
- If a J-1 Associate's independent housing or transportation arrangement results in program guideline violations, SEVIS reporting complications, attendance violations, or conditions that jeopardize the integrity of the J-1 program, Alto HR reserves the right to require the Associate to enroll in Helios housing and transportation services as a condition of continued program participation
5.5  Helios Agreement. Associates who elect to use Helios housing or transportation services will enter into a separate agreement directly with Helios Housing and Transportation. Alto HR is not a party to the Helios agreement and does not assume liability for any dispute, injury, property damage, or other issue arising from the Associate's use of Helios services. Any complaints or disputes related to Helios services must be directed to Helios directly.
5.6  Authorized Deduction. Where the Associate elects Helios housing and authorizes a weekly deduction in writing within the Helios Housing Agreement, Alto HR will apply that deduction to the Associate's payroll automatically. No deduction will be applied without the Associate's prior written authorization.

Section 6 — Safety Compliance
6.1  OSHA. The Associate agrees to follow all applicable OSHA General Industry Standards and any client-specific safety requirements on every shift.
6.2  Walmart Safety Requirements. At Walmart locations the Associate must: maintain clear fire lanes at all times, photograph aisle and fire lane clearance in ASN at shift close, wear non-slip footwear, and report all injuries and incidents in ASN on the shift during which they occur.
6.3  Hospitality Safety Requirements. At hospitality client locations the Associate must follow all client-specific safety protocols for pool areas, food preparation zones, chemical handling, equipment operation, and guest interaction areas.
6.4  Incident Reporting. Every injury, near-miss, or unsafe condition must be reported to the Shift Lead immediately and logged in Alto People on the shift during which it occurs. Failure to report a workplace injury on the same shift may affect workers compensation eligibility.

Section 7 — Benefits and Workers Compensation
7.1  Workers Compensation. The Associate is covered by Alto HR's workers compensation insurance for work-related injuries sustained during employment. All injuries must be reported immediately and documented in Alto People.
7.2  Standard Benefits. Temporary associates may not be eligible for standard benefits unless expressly stated in writing by Alto HR.
7.3  ACA Monitoring. Alto HR monitors associate hours in compliance with the Affordable Care Act. Associates whose hours qualify them for coverage will be notified.
7.4  Branch Financial Wellness. Associates enrolled in the Branch payroll card program have access to Branch's earned wage access and financial wellness tools as a benefit of their payroll card enrollment.

Section 8 — Termination
8.1  Termination by Alto HR. Alto HR may terminate this Agreement at any time with or without cause. Termination for cause may occur without notice.
8.2  Resignation. The Associate agrees to provide a minimum of seventy-two (72) hours written notice of resignation through Alto People or in writing to the Operations Manager.
8.3  End of Assignment. The conclusion of a seasonal assignment does not constitute termination of employment unless Alto HR expressly terminates the employment relationship in writing.
8.4  Final Pay. Final pay will be issued in compliance with applicable Florida or Alabama law. All authorized deductions including Helios housing charges, unreturned equipment, or other outstanding obligations will be applied to the extent permitted by law.
8.5  Return of Property. Upon termination the Associate must immediately return all Alto HR property including uniforms, access cards, and company-issued equipment. Failure to return property may result in deductions from the final paycheck to the extent permitted by law.
8.6  Housing Vacate. Where the Associate occupies Helios housing, the Associate must coordinate vacate timing directly with Helios per the terms of the Helios Housing Agreement. Alto HR is not responsible for managing the housing vacate process.

PART 2 — J-1 WORK AND TRAVEL PROGRAM ADDENDUM
Applicable to J-1 Visa Participants Only — Non-Applicable if Associate is Not a J-1 Holder

This addendum applies exclusively to associates participating in the J-1 Summer Work and Travel program sponsored by a Department of State-designated exchange visitor sponsor. All J-1 associates must read this section in addition to all other sections of this Agreement.

Section 9 — J-1 Program Terms
9.1  Pre-Arranged Employment. The Associate's J-1 visa and DS-2019 form are issued on the basis of pre-arranged employment with Alto HR. This Agreement constitutes the pre-arranged employment documentation for J-1 program purposes.
9.2  Program Compliance. The Associate agrees to comply with all requirements of the J-1 program sponsor, including participant reporting obligations, address reporting, check-in requirements, and program-specific conduct standards.
9.3  Work Authorization Limitation. The Associate's authorization to work in the United States is limited to the scope and duration of their J-1 visa. The Associate may not work outside the terms of their DS-2019 or visa status.
9.4  SEVIS Reporting. Alto HR is required to report changes in the Associate's employment status, housing address, or program participation to the J-1 program sponsor for SEVIS reporting. The Associate must notify Alto HR's HR Administrator of any change in housing address within twenty-four (24) hours.
9.5  Home Country Return. The Associate agrees to return to their home country at the conclusion of their J-1 program period as required by their visa status. Alto HR does not sponsor immigration petitions or visa status changes.
9.6  Housing — J-1 Specific. As described in Section 5.4 of this Agreement, J-1 associates may arrange independent housing provided it complies with program sponsor guidelines, applicable law, and does not result in attendance violations or SEVIS reporting complications.
9.7  Tax Withholding. J-1 participants are subject to specific federal and state tax withholding rules. Alto HR will apply the appropriate withholding based on the Associate's W-4 or W-8BEN submission. Associates are encouraged to consult a tax professional familiar with J-1 visa tax obligations.
9.8  Cultural Exchange Participation. The J-1 Summer Work and Travel program is a cultural exchange program. Alto HR supports the Associate's participation in American cultural activities during non-working hours. Nothing in this Agreement restricts the Associate's ability to engage in lawful cultural, recreational, or social activities outside of scheduled work hours.

PART 3 — ALTO SHIFTNEXUS (ASN) END USER AGREEMENT
Proprietary On-Site Compliance and Shift Documentation Platform

Alto ShiftNexus (ASN) is the proprietary shift compliance and documentation platform of Alto Etho LLC. ASN is used to document shift activities, cold chain compliance events, safety checks, department performance, and client-facing operational records. By accepting employment with Alto HR and being granted access to ASN, the Associate agrees to the following terms.

Section 10 — Alto ShiftNexus (ASN) — End User Agreement
10.1  License Grant. Alto HR grants the Associate a limited, non-exclusive, non-transferable, revocable license to access and use ASN solely for the purpose of performing assigned job duties during the term of employment. This license is automatically revoked upon termination.
10.2  Authorized Use. The Associate may use ASN only for its intended purposes: shift opening and shift closing; department compliance logging — temperature records, FIFO completion, cull and shrink logging; photo documentation — temperature log photographs, aisle clearance photographs, incident scene photographs; floor safety checks — moisture log, fire lane clearance, cardboard clearance; incident reporting; MOD (Manager on Duty) sign-off capture; Daily Service Summary submission. The Associate may NOT use ASN for: sharing login credentials with any other person; accessing records belonging to other associates, other shifts, or other client locations; screenshot, copying, exporting, or reproducing any ASN data without written authorization; attempting to reverse engineer, modify, or tamper with the ASN platform; any personal, commercial, or non-employment purpose; providing false, incomplete, or misleading information in any ASN submission.
10.3  Compliance Documentation Obligations — Walmart Standard. At Walmart client locations, ASN compliance documentation is a federal food safety requirement under FSMA Rule 204. Associates in Department Lead or Shift Lead roles acknowledge: temperature logs must be submitted with photographic evidence before the shift may be closed — no photograph, no compliance; all department compliance modules must be submitted and approved in ASN before the Shift Lead closes the shift; the MOD sign-off must be captured in ASN before the Shift Lead leaves the client premises; all incidents must be reported in ASN on the shift during which they occur — retroactive reporting is not accepted; falsification or omission of any compliance record in ASN constitutes grounds for immediate termination and may create civil and criminal liability.
10.4  Compliance Documentation — Hospitality Standard. At hospitality and food service client locations, ASN shift documentation must include shift open and close confirmation with timestamps; department coverage confirmation by role; food safety temperature checks where applicable to the client's requirements; incident reports for any guest or staff safety event; client supervisor sign-off captured in ASN at shift close.
10.5  Intellectual Property. ASN and all content, data, reports, and documentation generated through ASN are the exclusive intellectual property of Alto Etho LLC. The Associate has no ownership interest in any ASN data. All compliance records, temperature logs, incident reports, and shift summaries are the property of Alto HR and may be used for client reporting, legal defense, regulatory compliance, and performance evaluation.
10.6  Data and GPS Consent. The Associate acknowledges that ASN records activity, timestamps, and where applicable location data during shift operations. By using ASN the Associate consents to the collection and use of this data for compliance, payroll verification, and client reporting purposes.
10.7  System Availability. In the event ASN is unavailable during a shift, the Shift Lead must contact the Command Desk immediately for alternative compliance documentation instructions. Technical unavailability does not relieve the Associate of compliance documentation obligations.
VIOLATION: Falsification of any ASN record including temperature logs, FIFO completion, floor safety checks, or MOD sign-off is an immediate termination offense. At Walmart client locations it may also constitute a federal food safety violation under FSMA 204.

PART 4 — ALTO PEOPLE END USER AGREEMENT
Proprietary Workforce Management, HR, and Scheduling Technology Platform

Alto People is the proprietary workforce management, scheduling, time tracking, payroll, onboarding, communication, and HR administration platform of Alto Etho LLC. All associates granted access to Alto People agree to the following terms as a condition of employment.

Section 11 — Alto People Platform — End User Agreement
11.1  License Grant. Alto HR grants the Associate a limited, non-exclusive, non-transferable, revocable license to access and use the Alto People platform solely for employment-related purposes during the term of employment. This license is automatically revoked upon termination.
11.2  Authorized Use — Associate. Associates are authorized to use Alto People for the following purposes: reviewing and confirming scheduled shifts; clocking in and clocking out using the geofenced clock-in feature; confirming or declining scheduled shifts — two hours before shift start; requesting shift swaps with other associates; claiming open shifts posted by the Shift Lead; viewing pay stubs, earnings history, and Branch card balance; accessing and downloading employment documents — offer letter, W-2, certifications; updating personal information, emergency contact, and banking details; receiving and reading company communications and shift announcements; submitting workplace incident or concern reports; completing onboarding steps and signing employment documents digitally; reviewing performance notes and seasonal ratings.
11.3  Geofenced Clock-In Consent. The Associate acknowledges and consents to the following: the clock-in function uses GPS location data to verify physical presence at the assigned client worksite before clock-in is permitted; the Associate's GPS location is recorded at clock-in and clock-out and stored in Alto HR's systems for payroll verification and compliance purposes; attempting to clock in from outside the designated geofence — including using VPN, GPS spoofing, or any other method to falsify location — is a violation of this Agreement and grounds for immediate termination; the Associate consents to the collection and use of location data for these purposes and acknowledges this data may be reviewed by Alto HR management.
11.4  Onboarding Data. The Associate acknowledges that during onboarding they submitted personal, financial, and documentation data through Alto People. This data is stored securely and used exclusively for employment administration including payroll processing, I-9 verification, tax filing, and background screening. Alto HR does not sell the Associate's personal data to third parties.
11.5  Communication Consent. The Associate consents to receiving push notifications, in-app messages, and SMS communications from Alto People related to their employment including schedule updates, shift confirmations, payroll notifications, document requests, and emergency broadcasts. Disabling notifications does not relieve the Associate of the obligation to review employment communications in a timely manner.
11.6  Multi-Language Support. Alto People supports associate-facing content in English, Turkish, Spanish, and Norwegian to support the diverse international workforce Alto HR recruits through the J-1 program. Language preference can be set in the Associate's profile settings.
11.7  Intellectual Property. Alto People and all features, data, interfaces, workflows, and content within the platform are the exclusive intellectual property of Alto Etho LLC. All data generated through the Associate's use of Alto People including time entries, shift records, performance ratings, and employment documents is the property of Alto HR.
11.8  Account Security. The Associate is responsible for maintaining the security of Alto People login credentials. The Associate must not share their username or password. If unauthorized access is suspected, the Associate must notify Alto HR immediately. Alto HR may terminate platform access at any time without prior notice.

PART 5 — ADDITIONAL TECHNOLOGY TERMS
Branch Payroll Card | Helios Platform | Wise Business | GEC Exchanges

Section 12 — Branch Payroll Card — Terms of Use Acknowledgment
12.1  The Associate acknowledges that the Branch payroll card is issued by Branch's banking partner — not by Alto HR. The Associate agrees to review and comply with Branch's cardholder agreement, which is provided separately during onboarding.
12.2  Alto HR's Role. Alto HR loads net pay onto the Associate's Branch card on each payday. Alto HR's responsibility is limited to the accurate and timely transmission of the net pay amount. Card fees, card loss, unauthorized transactions, and disputes with Branch's banking partner are governed by the Branch cardholder agreement and must be resolved directly with Branch.
12.3  Earned Wage Access. Where the Associate uses Branch's earned wage access feature to access pay before payday, the Associate acknowledges that the amount accessed will be deducted from the same pay period's net pay. Alto HR is not liable for any financial decisions the Associate makes using earned wage access.
12.4  International Transfers — Wise Business. J-1 associates who use the Wise Business international transfer service to send money to their home country acknowledge that Wise Business is an independent financial services company. Alto HR does not operate, control, or guarantee Wise Business services. Use of Wise Business is governed by Wise's own terms of service.

Section 13 — Helios Housing and Transportation Platform
13.1  Helios is an independent company that provides housing and transportation services through its own platform and agreements. Associates who enroll in Helios services acknowledge that their relationship with Helios is governed by a separate Helios agreement and that Alto HR is not a party to that agreement.
13.2  Alto HR may share the Associate's employment information including work location, shift schedule, and contact details with Helios solely for the purpose of coordinating housing and transportation logistics. The Associate consents to this limited data sharing by enrolling in Helios services.
13.3  Helios Service Issues. Any issue with Helios housing or transportation — including maintenance requests, disputes, safety concerns, or service failures — must be directed to Helios directly. Alto HR will not intervene in disputes between the Associate and Helios beyond facilitating communication where appropriate.

Section 14 — GEC Exchanges — J-1 Program Platform
14.1  J-1 Program Administration. GEC Exchanges is Alto HR's J-1 program sponsor partner for host employer onboarding and participant documentation. J-1 associates acknowledge that GEC Exchanges may have access to their program documentation including DS-2019 forms, SEVIS records, and program participation data as required by J-1 program administration.
14.2  GEC Platform. Where J-1 associates access the GEC Exchanges program platform, use of that platform is governed by GEC Exchanges' own terms of service. Alto HR is not responsible for the operation or content of the GEC Exchanges platform.

PART 6 — GENERAL LEGAL PROVISIONS
Non-Solicitation | Arbitration | Governing Law | EEO | Full Agreement

Section 15 — Non-Solicitation and Non-Compete
15.1  Non-Solicitation of Clients. During the term of employment and for twelve (12) months following termination, the Associate agrees not to solicit, approach, or accept direct employment from any client to which they were assigned by Alto HR without prior written consent.
15.2  Non-Solicitation of Associates. During the term of employment and for twelve (12) months following termination, the Associate agrees not to solicit, recruit, or encourage any Alto HR associate to terminate their employment or join a competing organization.
15.3  Non-Compete. During the term of employment, the Associate agrees not to perform staffing or workforce services for any competing staffing agency operating in the same markets as Alto HR without prior written consent.

Section 16 — Dispute Resolution and Arbitration
16.1  Mandatory Arbitration. Any dispute arising out of or relating to this Agreement or the Associate's employment shall be resolved through binding arbitration administered by the American Arbitration Association (AAA) under its Employment Arbitration Rules.
16.2  Class Action Waiver. The Associate waives any right to bring any claim as a class action, collective action, or representative action. All disputes must be brought individually.
16.3  Governing Law. This Agreement is governed by the laws of the State of Florida without regard to conflict of law provisions.
16.4  Venue. Any arbitration or legal proceeding shall be conducted in Okaloosa County, Florida, or the county in which the Associate's primary worksite is located.

Section 17 — Equal Employment Opportunity and Anti-Harassment
17.1  EEO. Alto HR does not discriminate on the basis of race, color, religion, sex, gender identity, sexual orientation, national origin, age, disability, genetic information, veteran status, pregnancy, immigration status, or any other characteristic protected by applicable law.
17.2  Anti-Harassment. Harassment of any kind is strictly prohibited. Any associate who experiences or witnesses harassment must report it through the Alto People concern reporting tool or directly to the HR Administrator.
17.3  ADA. Associates with disabilities who require a reasonable accommodation should submit a written request to the HR Administrator. Alto HR will engage in an interactive process to identify appropriate accommodations.

Section 18 — Incorporated Policies
The following policies are incorporated into this Agreement by reference and are binding on the Associate. All policies are provided in the Alto HR Associate Policy Manual and are accessible through the Alto People platform: Cold Chain Compliance Policy; Food Safety and FSMA 204 Policy; Workplace Safety and OSHA Compliance Policy; Uniform and Appearance Policy; Housing and Transportation Policy; Social Media and Confidentiality Policy; Drug and Alcohol Free Workplace Policy; Equal Employment Opportunity and Anti-Harassment Policy; Data Privacy and Technology Use Policy; Performance Standards and Disciplinary Policy.

Section 19 — Entire Agreement
19.1  This Agreement, together with all addenda, exhibits, and incorporated policies, constitutes the entire agreement between Alto HR and the Associate with respect to the subject matter hereof and supersedes all prior discussions, representations, and agreements.
19.2  Amendments. No amendment to this Agreement is valid unless made in writing and signed by both parties.
19.3  Severability. If any provision is found unenforceable, the remaining provisions continue in full force and effect.
19.4  Acknowledgment. The Associate confirms they have read this Agreement in its entirety, have had the opportunity to ask questions, and understand and agree to all terms.

By signing below I confirm that I have received, read, and understood this Associate Employment Agreement Version 2.0 in its entirety including all six parts: Employment Terms, J-1 Addendum (if applicable), Alto ShiftNexus End User Agreement, Alto People End User Agreement, Additional Technology Terms, and General Legal Provisions. I understand this is a legally binding agreement. I understand that my housing and transportation through Helios is voluntary and that if I arrange independent housing and transportation I am solely responsible for ensuring those arrangements do not affect my workplace attendance or violate my J-1 program guidelines.

Alto Etho LLC  |  DBA Alto HR  |  108 Bailey Drive Suite 2-851, Niceville FL 32578  |  850-749-3420  |  altohr.co
Document Version 2.0  |  Effective 2026  |  Supersedes All Prior Versions  |  Confidential`;

export interface PolicySpec {
  title: string;
  version: string;
  industry: string | null;
  body: string;
}

export const ALTO_POLICIES: PolicySpec[] = [
  {
    title: 'Policy 1 — Cold Chain Compliance Policy',
    version: '2026.1',
    industry: null,
    body: `Applicable to all retail, grocery, and food service client locations including Walmart Supercenters and Neighborhood Markets.

This policy meets and exceeds Walmart's cold chain compliance standards as required under the FDA Food Safety Modernization Act (FSMA) Rule 204 — Traceability Record Keeping. All associates assigned to Frozen, Dairy, Produce, Meat, Seafood, or Deli departments are required to follow this policy on every shift without exception.

1.1  Purpose
The purpose of this policy is to ensure that Alto HR associates maintain the integrity of the cold chain at all times when handling temperature-sensitive food products. A cold chain break is not simply a compliance failure — it is a food safety event that can result in illness, federal regulatory exposure for the client, and termination of Alto HR's contract. Alto HR's cold chain compliance record is the single most important performance metric we maintain.

1.2  Temperature Standards
- Frozen (all products): 0°F or below; escalate at 10°F.
- Dairy / Refrigerated: 38°F or below; escalate at 45°F.
- Fresh Produce: 34°F – 45°F depending on product; escalate at 50°F.
- Meat and Seafood: 28°F – 32°F; escalate at 40°F.
- Deli / Prepared Foods (cold hold): 40°F or below; escalate at 41°F.
- Hot Hold (Deli / Food Service): 135°F or above; escalate below 135°F.

1.3  Cold Chain Timing Requirements
- Frozen product must be moved from the receiving dock to the freezer zone within five (5) minutes of receipt — no exceptions.
- Dairy and refrigerated product must be moved within ten (10) minutes of receipt.
- Produce must be moved within fifteen (15) minutes of receipt for temperature-sensitive items.
- No frozen or refrigerated product may be staged in a non-temperature-controlled area at any time.
- Associates may not leave frozen or refrigerated pallets unattended on the sales floor.

1.4  Temperature Log Requirements — Walmart FSMA 204 Standard
Associates in cold chain departments must:
1. Check and record the temperature of all refrigeration and freezer units at shift open — before handling any product.
2. Photograph the thermometer display for every unit checked — photographs must be timestamped.
3. Upload all photographs to Alto ShiftNexus (ASN) in the designated temperature log module.
4. Re-check and photograph all temperatures at shift close.
5. Log any temperature exceedance immediately in ASN — do not continue stocking into a failing unit.
6. Escalate any temperature reading outside the required range to the Shift Lead immediately.
7. Do not leave the shift without confirming all temperature logs are submitted and approved in ASN.

1.5  Hospitality and Food Service Standard
At hospitality and food service client locations, associates must additionally comply with Florida Division of Hotels and Restaurants food safety requirements; ServSafe temperature logging standards; the two-hour rule (hot food below 135°F or cold food above 41°F for more than two hours must be discarded and logged); and cooling logs (cooked food cooled from 135°F to 70°F within two hours and from 70°F to 41°F within four additional hours).

1.6  FIFO — First In First Out
All associates must apply FIFO rotation to every department, every shift. Existing product is pulled forward and date-checked before any new product is placed. New product is placed behind existing product. Any product found past expiration is removed and logged in ASN with item name, quantity, and expiry date.

VIOLATION: Any associate found stocking product into a unit with a known temperature failure, falsifying temperature records, or failing to log a cold chain breach will be subject to immediate termination. A cold chain falsification is not a performance issue — it is a food safety violation.`,
  },
  {
    title: 'Policy 2 — Food Safety and FSMA 204 Policy',
    version: '2026.1',
    industry: null,
    body: `Applicable to all food handling roles at retail, grocery, hospitality, food and beverage, and food service client locations.

This policy incorporates the requirements of the FDA Food Safety Modernization Act (FSMA), specifically the Food Traceability Rule (Section 204), Walmart's Supplier Food Safety Standards, and the Florida Department of Business and Professional Regulation food safety standards applicable to hospitality and food service environments.

2.1  Purpose
Alto HR associates who handle food products are directly responsible for the safety of the food supply at every client location. This policy establishes the minimum food safety standards that every associate must meet and exceed on every shift.

2.2  Food Handler Certification Requirements
- General retail stocking (frozen, dairy, produce, GM): Basic Food Handler Certificate, before first shift.
- Deli, bakery, food prep, meat, seafood: ServSafe Food Handler (ANSI accredited), before first shift.
- Deli/food service manager or lead role: ServSafe Food Manager Certification, before first shift.
- Bartender / bar associate (hospitality): Responsible Vendor / TIPS Certification, before first shift.
- Food and beverage server (resort/restaurant): Basic Food Handler Certificate, before first shift.
- Banquet and catering associate: Basic Food Handler Certificate, before first shift.

2.3  Personal Hygiene Standards
- Wash hands thoroughly with soap and warm water for a minimum of twenty (20) seconds: before beginning work, after handling raw meat or seafood, after using the restroom, after touching the face or hair, after handling trash or chemicals, and after any activity that could contaminate the hands.
- Wear clean, appropriate attire — hair net or hat where required by client policy.
- Wear disposable gloves when handling ready-to-eat foods — change gloves between tasks and whenever contamination may have occurred.
- Do not handle food if experiencing symptoms of illness including vomiting, diarrhea, jaundice, or open infected wounds on the hands.
- Report any food-related illness symptoms to the Shift Lead immediately.
- No bare-hand contact with ready-to-eat food at any time.

2.4  Walmart FSMA 204 Traceability Obligations
Associates must log all product rotation events, damage events, and shrink events in ASN; never discard product without logging it first; maintain the cold chain timing records required under Policy 1; and report any product that arrived damaged, mislabeled, or outside temperature specifications in the ASN receiving log.

2.5  Allergen Awareness
At hospitality and food service client locations, associates must be aware of the eight major food allergens: milk, eggs, fish, shellfish, tree nuts, peanuts, wheat, and soybeans. Associates must never substitute ingredients without explicit instruction; never represent a dish as allergen-free unless confirmed by the kitchen supervisor; report any guest allergen inquiry immediately; and maintain allergen separation during food preparation and service.

VIOLATION: No associate may return to food handling duties after reporting illness symptoms without written medical clearance. Working while sick in a food handling environment is a violation of Florida food safety law and this policy.`,
  },
  {
    title: 'Policy 3 — Workplace Safety and OSHA Compliance Policy',
    version: '2026.1',
    industry: null,
    body: `Applicable to all client locations — retail, hospitality, warehouse, food service, and golf and recreation. Aligned with OSHA 29 CFR Part 1910, Walmart's Safety Programs, and Florida DBPR hospitality safety standards.

3.1  Purpose
Safety is the foundation of every shift. Every associate is responsible for their own safety and the safety of their colleagues and the customers around them.

3.2  Fire Lane Compliance — Walmart Standard
- Never park a pallet, cart, equipment, or any material in a designated fire lane — even temporarily.
- Clear fire lanes immediately if any obstruction is found — log the clearance in ASN.
- Photograph fire lane status at shift close and upload to the ASN GM module.
- Notify the Shift Lead immediately if any fire lane is blocked by a non-Alto HR pallet or obstruction.
ALTO STANDARD: The shift does not close in ASN until fire lane clearance is photographed and confirmed.

3.3  Slip, Trip, and Fall Prevention
- Wear non-slip footwear on every shift — mandatory uniform requirement.
- Address any liquid spill immediately by placing wet floor signs and cleaning or reporting.
- In produce departments — inspect misting system zones for floor moisture at shift open and throughout. Log floor safety checks in ASN.
- Never run, jump, or engage in unsafe behavior in the workplace.
- Never stand on shelving, equipment, or anything not designed as a ladder.
- Keep all aisles and walkways clear of boxes, wrap, equipment, and debris throughout the shift.

3.4  Lifting and Physical Safety
- Use proper lifting technique — bend at the knees, keep the back straight, lift with the legs.
- Use team lifting for any item weighing more than fifty (50) pounds — never lift heavy items alone.
- Use mechanical assistance — pallet jacks, hand trucks, carts — for large or heavy loads.
- Report any physical discomfort, strain, or injury to the Shift Lead immediately.

3.5  Chemical Safety and Hazard Communication
- Use cleaning chemicals in accordance with the product's Safety Data Sheet (SDS).
- Wear appropriate PPE — gloves, eye protection, and apron where required.
- Never mix cleaning chemicals.
- Follow client-specific SDS protocols at Walmart and pool/cleaning agent procedures at hospitality locations.

3.6  Incident Reporting — All Client Locations
- Report every injury, near-miss, or unsafe condition to the Shift Lead immediately.
- Log all incidents in the Alto People incident reporting module before the shift closes.
- At Walmart locations also log in ASN and notify the Walmart store's overnight manager or MOD.
- Photograph the incident scene before disturbing it.
- Failure to report a workplace injury on the shift during which it occurs may affect workers compensation eligibility.

3.7  Cardboard and Waste Management — Retail Standard
- All cardboard must be broken down and taken to the compactor before the end of every shift.
- No cardboard may remain on the sales floor when the shift closes.
- Banding, stretch wrap, and pallets must be removed and disposed of in the designated area.

3.8  Golf and Recreation Safety
At golf club and recreation client locations, associates operating golf carts must hold a valid driver's license and follow posted speed limits; grounds equipment may only be operated by associates trained by the client supervisor; pool and beach areas require associates to follow posted safety rules and the client's emergency procedures; immediately report any guest injury or safety incident.`,
  },
  {
    title: 'Policy 4 — Uniform and Appearance Policy',
    version: '2026.1',
    industry: null,
    body: `Applicable to all Alto HR associates at all client locations. The uniform and appearance of every Alto HR associate is a direct representation of the Company and its client.

4.1  Standard Uniform — All Locations
- Alto HR company shirt — clean, intact, properly worn at all times on shift.
- Dark work pants or jeans — no tears, rips, or excessively baggy fit.
- Non-slip, closed-toe footwear — mandatory for all shifts at all client types.
- Hair must be neat and pulled back where required by food safety or client policy.
- Alto HR-issued name badge where provided — worn visibly at all times.

4.2  Cold Chain and Food Safety Uniform Additions
- Insulated gloves for frozen department work — provided by Alto HR or client.
- Hair net or hat — required in all deli, bakery, food prep, and hot food service environments.
- Disposable gloves — required for all ready-to-eat food handling.
- Apron — required where cleaning chemicals or food prep activities create a contamination risk.

4.3  Hospitality and Resort Client Standard
At hospitality client locations including Sandestin Golf and Beach Resort, Hilton Sandestin Beach, Santa Rosa Golf and Beach Club, and similar properties, the appearance standard is elevated to reflect the premium guest experience standard:
- Alto HR shirt must be freshly laundered and pressed — no wrinkles, stains, or damage.
- Footwear must be clean and appropriate for a hospitality environment — no heavily worn or damaged shoes.
- No visible tattoos on the face or neck unless client policy specifies otherwise.
- Jewelry must be minimal and appropriate.
- Personal hygiene is a professional standard — deodorant, clean hands, and presentable grooming are expected at all times.

4.4  Prohibited Items
- No open-toe footwear of any kind at any client location.
- No shorts unless specifically authorized by the client and Alto HR management.
- No headphones or earbuds during active shift hours.
- No personal mobile phone use on the sales floor or in the dining room during guest service hours — phones are for Alto People and ASN only.
- No Alto HR uniform may be worn outside of work hours in any manner that could bring the company into disrepute.

VIOLATION: Associates who arrive to a shift without the required uniform will be sent home and the shift will be marked as a no-show. Repeated uniform violations will result in disciplinary action up to and including termination.`,
  },
  {
    title: 'Policy 5 — Housing and Transportation Policy',
    version: '2026.1',
    industry: null,
    body: `Helios Housing and Transportation Services — Voluntary Participation. Alto HR has partnered with Helios Housing and Transportation to provide optional housing and daily transportation services for associates who wish to use them. Participation is voluntary and not a condition of employment unless otherwise specified in the associate's individual employment agreement or J-1 program terms.

5.1  Helios Housing Services — Overview
Alto HR has arranged a partnership with Helios Housing and Transportation to offer associates access to vetted, furnished, and conveniently located residential accommodations near client worksites along the Emerald Coast corridor.

5.2  Voluntary Participation
Housing through Helios is offered as a convenience and is not mandatory for employment with Alto HR unless expressly stated in the Associate's individual employment agreement. Associates who choose not to use Helios housing acknowledge that their personal housing arrangement must not interfere with their ability to report to work on time; that Alto HR bears no responsibility for their housing costs, transportation, or living conditions; and that housing-related issues that result in tardiness, absenteeism, or no-shows will be treated as attendance violations.

5.3  Helios Housing Agreement
Associates who elect to use Helios housing will enter into a separate housing agreement directly with Helios. Weekly housing costs will be deducted from the associate's paycheck only if the associate has authorized this in writing. Housing is available for the duration of the associate's employment and terminates when employment ends.

5.4  Helios Transportation Services
Helios Transportation offers a daily shuttle service between housing locations and client worksites. Use is voluntary. Associates who choose not to use Helios transportation are responsible for arranging their own reliable transportation.

5.5  J-1 Visa Program — Housing and Transportation
J-1 associates may arrange their own independent housing and transportation provided that their independent arrangement is legal, safe, and compliant with applicable local ordinances and J-1 program sponsor guidelines; does not result in attendance violations or SEVIS reporting complications; and is reported to Alto HR's HR Administrator and the J-1 program sponsor as required. If an independent arrangement results in attendance or program violations, Alto HR reserves the right to require enrollment in Helios services as a condition of continued program participation.

5.6  Alto HR's Role
Alto HR's responsibility regarding housing and transportation is limited to facilitating the associate's access to Helios services where elected. Any complaints, maintenance issues, or disputes related to Helios housing or transportation must be directed to Helios directly.

ALTO STANDARD: Associates are encouraged to use Helios services for the convenience and reliability they provide. However, regardless of housing and transportation choice, every associate is held to the same attendance and punctuality standard on every shift.`,
  },
  {
    title: 'Policy 6 — Social Media and Confidentiality Policy',
    version: '2026.1',
    industry: null,
    body: `Applicable to all Alto HR associates during and after employment.

6.1  Purpose
Alto HR and its clients operate in environments where confidentiality and professionalism are essential to business relationships, legal compliance, and client trust.

6.2  Social Media Policy
Associates must not post, share, photograph, or record any of the following without prior written authorization:
- Images or videos from inside any client worksite — including Walmart store interiors, resort dining areas, club facilities, or any other client property.
- Images or videos of clients, guests, or members of the public at any client location.
- Any information about client operations, staffing levels, sales data, security procedures, or internal communications.
- Any content that identifies the associate's employer, client worksite, or co-workers in a manner that could damage the reputation of Alto HR or the client.
- Any content that constitutes harassment, discrimination, or defamatory statements about any person.
Associates are permitted to acknowledge their employment with Alto HR on personal social media. Associates may not make statements on social media that could be construed as representing the official positions of Alto HR or its clients.

6.3  Confidential Information
Associates may have access to confidential information including client operational data; Alto HR business information; personal information of other associates; and guest and member information at hospitality client locations. Associates agree not to disclose, share, copy, or use any confidential information for any purpose other than performing their assigned duties. This obligation survives the termination of employment.

6.4  Photography and Recording Prohibition
Photography and video recording at client worksites is strictly prohibited without explicit written authorization from both Alto HR and the client. This includes recording through personal devices, wearable technology, or any other recording equipment. Associates found recording at client worksites without authorization will be subject to immediate termination and may face legal action.`,
  },
  {
    title: 'Policy 7 — Drug and Alcohol Free Workplace Policy',
    version: '2026.1',
    industry: null,
    body: `Applicable to all Alto HR associates at all client locations and in company housing.

7.1  Purpose
Alto HR maintains a drug and alcohol free workplace in compliance with applicable federal and state law and the requirements of its clients including Walmart and all hospitality partners.

7.2  Prohibited Conduct
The following conduct is strictly prohibited and will result in immediate termination:
- Reporting to work under the influence of alcohol, illegal drugs, prescription drugs that impair job performance, or any other intoxicant.
- Consuming alcohol, illegal drugs, or any other intoxicant during work hours or on client premises.
- Possessing alcohol, illegal drugs, drug paraphernalia, or any controlled substance at any client worksite.
- Selling, distributing, or facilitating the use of drugs or alcohol at any client worksite or in company-provided housing.
Associates taking legally prescribed medication that may impair their ability to perform their duties safely must notify Alto HR's HR Administrator before their shift.

7.3  Testing
- Pre-employment drug testing may be required depending on client requirements.
- Reasonable suspicion testing — if a supervisor has reasonable cause to believe an associate is under the influence while on duty, the associate will be required to submit to immediate testing.
- Post-incident testing — any workplace incident or injury may trigger mandatory drug and alcohol testing.
- Random testing — Alto HR or its clients may conduct random drug and alcohol testing programs in accordance with applicable law.

7.4  Alcohol at Hospitality Locations
Associates assigned to bartending, bar service, or food and beverage roles may handle alcoholic beverages in the course of their duties. This does not permit the associate to consume alcohol during their shift. The prohibition on alcohol consumption during work hours applies regardless of the nature of the role.`,
  },
  {
    title: 'Policy 8 — Equal Employment Opportunity and Anti-Harassment Policy',
    version: '2026.1',
    industry: null,
    body: `Applicable to all Alto HR associates, clients, and workplace environments.

8.1  Equal Employment Opportunity
Alto HR does not discriminate against any associate or applicant on the basis of race, color, religion, sex, gender identity, sexual orientation, national origin, age, disability, genetic information, veteran status, pregnancy, or any other characteristic protected by applicable federal, state, or local law. This policy applies to all aspects of employment including hiring, assignment, compensation, scheduling, training, and termination.

8.2  Anti-Harassment
Harassment of any kind is strictly prohibited. Harassment includes any unwelcome conduct based on a protected characteristic that creates an intimidating, hostile, or offensive work environment or that unreasonably interferes with an associate's ability to perform their duties. Examples of prohibited conduct include:
- Verbal harassment — slurs, offensive jokes, name-calling, or derogatory comments based on protected characteristics.
- Physical harassment — unwanted physical contact, touching, or assault.
- Visual harassment — displaying offensive images, symbols, or written materials.
- Sexual harassment — unwelcome sexual advances, requests for sexual favors, or other conduct of a sexual nature that affects employment conditions or creates a hostile work environment.
- Cyberbullying or online harassment directed at a co-worker through social media or messaging platforms.

8.3  Reporting Procedure
Any associate who experiences or witnesses discrimination or harassment is encouraged to report it immediately through:
- The Alto People concern reporting tool — available through the associate's app.
- Direct report to the HR Administrator — in person, by phone, or by email.
- Anonymous report — available through the Alto People concern tool.
All reports will be investigated promptly and confidentially. Retaliation against any associate who reports discrimination or harassment in good faith is strictly prohibited and is itself grounds for disciplinary action.

8.4  Diversity and Inclusion
Alto HR's associate workforce reflects the diverse communities it serves and the international talent it recruits through the J-1 Work and Travel program. Discrimination or harassment based on immigration status, country of origin, or language is a violation of this policy and of applicable federal law.`,
  },
  {
    title: 'Policy 9 — Data Privacy and Technology Use Policy',
    version: '2026.1',
    industry: null,
    body: `Applicable to all Alto HR associates and all company technology platforms.

9.1  Purpose
Alto HR collects and processes personal data from associates in the course of employment administration. This policy explains how Alto HR handles that data, what rights associates have, and what obligations associates have regarding the use of Alto HR's technology platforms including Alto ShiftNexus (ASN) and Alto People.

9.2  Data Collected
- Identity data — name, date of birth, Social Security Number or Tax Identification Number, government-issued ID.
- Contact data — address, phone number, email address.
- Employment data — role, client assignment, department, pay rate, work history, performance records.
- Financial data — bank account details, payroll card information, tax withholding elections.
- Time and location data — GPS-verified clock-in and clock-out records from the Alto People geofenced time management system.
- Document data — I-9, W-4, certifications, visa documents, housing agreements.
- J-1 program data — DS-2019, SEVIS number, program dates, sponsor contact, home country address.

9.3  How Alto HR Uses This Data
Payroll processing and tax filing; employment eligibility verification (I-9 compliance); scheduling, workforce management, and client assignment; client compliance reporting (shift records and ASN documentation shared with clients as required); J-1 program sponsor reporting (SEVIS compliance); workers compensation and benefits administration; performance management and employment decisions. Alto HR will not sell associate personal data to third parties. Alto HR may share associate data with its technology service providers including Branch, Helios, GEC Exchanges, and Randstad Sourceright as necessary to fulfill employment administration obligations.

9.4  Associate Technology Use Obligations
Associates who use Alto People or Alto ShiftNexus agree to use company technology platforms only for authorized employment-related purposes; maintain the security of their login credentials and never share passwords; report any unauthorized access or suspected security breach immediately; not attempt to access data, records, or features outside the scope of their assigned role; and not install unauthorized software or applications on company-issued devices.

9.5  Client Technology Systems
Associates must never access, use, or interact with any client technology system including registers, inventory management systems, security cameras, or computer terminals without explicit authorization from the client's management. Unauthorized access to client technology systems constitutes a serious breach of this policy and may result in immediate termination and referral to law enforcement.

9.6  Data Retention
Alto HR retains associate personal data for as long as required by applicable law and for the period necessary to fulfill the purposes described in this policy. Upon termination of employment, Alto HR will retain records as required by the IRS, Department of Labor, and applicable state law, typically a minimum of three to seven years depending on the record type.`,
  },
  {
    title: 'Policy 10 — Performance Standards and Disciplinary Policy',
    version: '2026.1',
    industry: null,
    body: `Applicable to all Alto HR associates across all client environments.

10.1  Purpose
Alto HR maintains the highest performance standards in the staffing industry because our clients depend on our associates to perform consistently, professionally, and compliantly on every shift.

10.2  Key Performance Standards
- Fill rate (showing up to scheduled shifts): 97% or above. Failure: progressive discipline / termination.
- No-show rate: 2% or below. Failure: progressive discipline / termination.
- Shift confirmation (2 hours before): 100% of shifts. Failure: verbal warning then written warning.
- ASN / compliance module submission: 100% where applicable. Failure: written warning / termination.
- Uniform compliance: 100% of shifts. Failure: sent home — no-show recorded.
- Punctuality (on time clock-in): 97% or above. Failure: progressive discipline.
- Cold chain compliance: 100%. Failure: immediate termination for falsification.
- Incident reporting: 100% — same shift. Failure: written warning / termination.
- Code of conduct: zero violations. Failure: immediate termination for serious violations.

10.3  Progressive Discipline
Alto HR applies a progressive discipline framework for performance and conduct issues that do not warrant immediate termination:
1. Verbal warning — documented in Alto People by the HR Administrator or Operations Manager.
2. Written warning — formal written notice with specific performance improvement expectations and timeline.
3. Final written warning — last opportunity to meet the required standard before termination.
4. Termination — employment ends.
Alto HR reserves the right to skip any step of the progressive discipline process and proceed directly to termination for serious violations including but not limited to: falsification of records, theft, physical altercation, food safety violations, cold chain falsification, and violation of client security policies.

10.4  Return Worker Program
Associates who complete a full season in good standing — meeting the performance standards above with no disciplinary incidents — are eligible for Alto HR's Return Worker Program. Return workers receive priority scheduling consideration, may qualify for a performance bonus, and are the first to receive notification of the following season's positions.`,
  },
];

export const HANDBOOK_POLICY: PolicySpec = {
  title: 'Associate Policy Manual — Acknowledgment of Receipt',
  version: '2026.1',
  industry: null,
  body: `By acknowledging this policy, you confirm that you have received a copy of the Alto HR Associate Policy Manual, that you have read and understood all 10 policies contained in this manual (Policy 1 through Policy 10), and that you agree to comply with all policies as a condition of your employment with Alto Etho LLC, DBA Alto HR.

You acknowledge that violations of these policies may result in disciplinary action up to and including immediate termination.

By clicking Acknowledge, you confirm:
- You have received the Alto HR Associate Policy Manual.
- You have read all 10 policies and the cross-reference to the Associate Employment Agreement.
- You agree to comply with all policies as a condition of employment.
- You understand violations may result in disciplinary action up to and including immediate termination.
- You understand this acknowledgment is part of your permanent employment record.`,
};
