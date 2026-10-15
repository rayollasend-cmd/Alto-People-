import type { IntegrationVendor, IntegrationVendorInfo } from '@alto-people/shared';
import type { IntegrationAdapter } from './adapter.js';
import { adpAdapter } from './vendors/adp.js';
import { beelineAdapter } from './vendors/beeline.js';
import { fieldglassAdapter } from './vendors/fieldglass.js';
import { ukgAdapter } from './vendors/ukg.js';
import { workdayAdapter } from './vendors/workday.js';

/**
 * Brief 3-5: the vendor catalog — what each adapter can do, which
 * credentials a live connection needs, and the default field mapping a
 * tenant overrides field by field. The default mappings are the shapes the
 * sandbox fixtures carry, so a new connection proves itself before anyone
 * types a credential.
 */

const ADAPTERS: Record<IntegrationVendor, IntegrationAdapter> = {
  FIELDGLASS: fieldglassAdapter,
  ADP: adpAdapter,
  WORKDAY: workdayAdapter,
  UKG: ukgAdapter,
  BEELINE: beelineAdapter,
};

export function adapterFor(vendor: IntegrationVendor): IntegrationAdapter {
  return ADAPTERS[vendor];
}

export const VENDOR_CATALOG: readonly IntegrationVendorInfo[] = [
  {
    vendor: 'FIELDGLASS',
    label: 'SAP Fieldglass',
    what: 'The VMS Alto bills through today: timesheets out, work orders in.',
    capabilities: ['pushTimesheets', 'pullWorkOrders'],
    credentialFields: [
      { key: 'baseUrl', label: 'API base URL', secret: false },
      { key: 'clientId', label: 'OAuth client id', secret: true },
      { key: 'clientSecret', label: 'OAuth client secret', secret: true },
      { key: 'apiKey', label: 'Application key', secret: true },
    ],
    defaultMapping: {
      timesheet: { workerListName: 'workerName', workerEmail: 'workerEmail', day: 'date', hours: 'hours', site: 'site', billRate: 'rate', weekEnding: 'weekEnding' },
      workOrder: { ref: 'workOrderId', workerName: 'worker.name', workerEmail: 'worker.email', site: 'site', startDate: 'startDate', endDate: 'endDate', billRate: 'rate', status: 'status' },
    },
    apiNote: 'Fieldglass Connectors: Time Sheet Upload and Work Order Download, OAuth2 client credentials. Shapes read from the vendor docs on 2026-10-15; confirm on the customer’s instance.',
  },
  {
    vendor: 'ADP',
    label: 'ADP Workforce Now',
    what: 'Payroll: the finalized run exported as pay data; employees kept in step.',
    capabilities: ['pushPayrollExport', 'pullWorkers', 'pushWorkers'],
    credentialFields: [
      { key: 'baseUrl', label: 'API base URL', secret: false },
      { key: 'tokenUrl', label: 'Token URL', secret: false },
      { key: 'clientId', label: 'Client id', secret: true },
      { key: 'clientSecret', label: 'Client secret', secret: true },
      { key: 'payrollGroupCode', label: 'Payroll group code', secret: false },
    ],
    defaultMapping: {
      worker: {
        externalId: 'associateOID',
        firstName: 'person.legalName.givenName',
        lastName: 'person.legalName.familyName1',
        email: 'businessCommunication.emails.0.emailUri',
        phone: 'businessCommunication.mobiles.0.formattedNumber',
        hireDate: 'workerDates.originalHireDate',
        position: 'workAssignments.0.jobTitle',
        siteName: 'workAssignments.0.homeWorkLocation.nameCode.shortName',
      },
      payroll: {
        workerEmail: 'associateEmail',
        workerName: 'associateName',
        payDate: 'payDate',
        hours: 'hours',
        gross: 'grossPay',
        net: 'netPay',
        federalWithholding: 'federalTax',
        fica: 'socialSecurityTax',
        medicare: 'medicareTax',
        stateWithholding: 'stateTax',
        preTaxDeductions: 'preTaxDeductions',
        postTaxDeductions: 'postTaxDeductions',
      },
    },
    apiNote: 'ADP API Central: Workers v2 and Pay Data Input v1, OAuth2 client credentials with mutual TLS (the certificate is uploaded in the ADP console, not here).',
  },
  {
    vendor: 'WORKDAY',
    label: 'Workday',
    what: 'The system of record for people: workers and shifts kept in step both ways.',
    capabilities: ['pullWorkers', 'pushWorkers', 'pullSchedules', 'pushSchedules'],
    credentialFields: [
      { key: 'baseUrl', label: 'REST base URL', secret: false },
      { key: 'tenant', label: 'Workday tenant', secret: false },
      { key: 'workersReportUrl', label: 'Workers report (RaaS) URL', secret: false },
      { key: 'tokenUrl', label: 'Token URL', secret: false },
      { key: 'clientId', label: 'API client id', secret: true },
      { key: 'clientSecret', label: 'API client secret', secret: true },
      { key: 'refreshToken', label: 'Refresh token', secret: true },
    ],
    defaultMapping: {
      worker: { externalId: 'Employee_ID', firstName: 'Legal_First_Name', lastName: 'Legal_Last_Name', email: 'Primary_Work_Email', hireDate: 'Hire_Date', separatedAt: 'Termination_Date', position: 'Business_Title', siteName: 'Location' },
      schedule: { ref: 'id', workerEmail: 'worker.email', startsAt: 'startDateTime', endsAt: 'endDateTime', position: 'position.descriptor', siteName: 'location.descriptor', status: 'status' },
    },
    apiNote: 'Workday REST: a Report-as-a-Service report for workers and the Scheduling API for shifts, OAuth2 refresh-token grant. The report’s column names are the mapping’s vendor fields.',
  },
  {
    vendor: 'UKG',
    label: 'UKG Pro Workforce Management',
    what: 'People and schedules in the customer’s UKG, kept in step both ways.',
    capabilities: ['pullWorkers', 'pushWorkers', 'pullSchedules', 'pushSchedules'],
    credentialFields: [
      { key: 'baseUrl', label: 'API base URL', secret: false },
      { key: 'appKey', label: 'App key', secret: true },
      { key: 'clientId', label: 'Client id', secret: true },
      { key: 'clientSecret', label: 'Client secret', secret: true },
      { key: 'username', label: 'Integration user', secret: false },
      { key: 'password', label: 'Integration password', secret: true },
    ],
    defaultMapping: {
      worker: {
        externalId: 'personNumber',
        firstName: 'personInformation.person.firstName',
        lastName: 'personInformation.person.lastName',
        email: 'personInformation.emailAddresses.0.address',
        hireDate: 'personInformation.person.hireDate',
        position: 'jobAssignment.jobTitle',
        siteName: 'jobAssignment.primaryLaborAccounts.0.organizationPath',
      },
      schedule: { ref: 'id', workerEmail: 'employee.email', startsAt: 'startDateTime', endsAt: 'endDateTime', position: 'segments.0.orgJobRef.qualifier', siteName: 'transfer.orgPath', status: 'status' },
    },
    apiNote: 'UKG Pro WFM (Dimensions) REST: persons multi_read / multi_upsert and schedule multi_read / multi_update, OAuth2 password grant with an app key.',
  },
  {
    vendor: 'BEELINE',
    label: 'Beeline',
    what: 'The contingent program: assignments in as work orders, hours out as timesheets.',
    capabilities: ['pullWorkOrders', 'pushTimesheets'],
    credentialFields: [
      { key: 'baseUrl', label: 'API base URL', secret: false },
      { key: 'apiKey', label: 'API key', secret: true },
      { key: 'clientId', label: 'Client id', secret: true },
      { key: 'clientSecret', label: 'Client secret', secret: true },
    ],
    defaultMapping: {
      workOrder: { ref: 'assignmentId', workerName: 'worker.fullName', workerEmail: 'worker.workEmail', site: 'workLocation.name', startDate: 'startDate', endDate: 'endDate', billRate: 'billRate.amount', status: 'status' },
      timesheet: { workerEmail: 'workerEmail', day: 'workDate', hours: 'hours', site: 'workLocation', weekEnding: 'weekEnding' },
    },
    apiNote: 'Beeline Enterprise API: assignments and timesheets, API key plus client credentials.',
  },
];

export function vendorInfo(vendor: IntegrationVendor): IntegrationVendorInfo {
  const v = VENDOR_CATALOG.find((c) => c.vendor === vendor);
  if (!v) throw new Error(`unknown vendor ${vendor}`);
  return v;
}
