/**
 * Human labels for the EmploymentType enum. Was inlined in
 * PeopleDirectory; shared so every surface (directory, headcount
 * breakdowns, drill drawers) renders "W-2" instead of "W2_EMPLOYEE".
 */
export const EMPLOYMENT_LABEL: Record<string, string> = {
  W2_EMPLOYEE: 'W-2',
  CONTRACTOR_1099_INDIVIDUAL: '1099 Individual',
  CONTRACTOR_1099_BUSINESS: '1099 Business',
};
