/**
 * The two catalogs the market-rate desk benchmarks against, with the
 * suggestions that save an admin from looking codes up.
 *
 *   SOC_CATALOG   the occupations (2018 SOC) a staffing company actually
 *                 fills, each with the words its role names tend to use
 *   CBSA_CATALOG  metro areas (Core-Based Statistical Areas, the "area" in
 *                 BLS OEWS) for the states we operate in, extendable — an
 *                 admin can type any CBSA code the catalog doesn't list
 *
 * Suggestions are only ever suggestions: the admin confirms the mapping.
 * Zip-to-metro is approximate at the edges (a zip can straddle counties),
 * so the UI says "suggested" and shows the reason.
 */

export interface SocEntry {
  code: string;
  title: string;
  keywords: string[];
}

export const SOC_CATALOG: SocEntry[] = [
  { code: '53-7065', title: 'Stockers and Order Fillers', keywords: ['stocker', 'stock', 'order filler', 'picker', 'replenish', 'overnight'] },
  { code: '53-7062', title: 'Laborers and Freight, Stock, and Material Movers, Hand', keywords: ['laborer', 'labourer', 'mover', 'warehouse', 'loader', 'unloader', 'freight', 'material handler', 'general labor'] },
  { code: '53-7064', title: 'Packers and Packagers, Hand', keywords: ['packer', 'packager', 'packing'] },
  { code: '53-7051', title: 'Industrial Truck and Tractor Operators', keywords: ['forklift', 'reach truck', 'pallet jack', 'truck operator'] },
  { code: '43-5071', title: 'Shipping, Receiving, and Inventory Clerks', keywords: ['receiving', 'shipping', 'inventory', 'receiver'] },
  { code: '41-2011', title: 'Cashiers', keywords: ['cashier', 'checkout', 'register'] },
  { code: '41-2031', title: 'Retail Salespersons', keywords: ['sales associate', 'retail', 'sales floor', 'merchandiser'] },
  { code: '41-1011', title: 'First-Line Supervisors of Retail Sales Workers', keywords: ['shift lead', 'team lead', 'lead', 'supervisor', 'key holder', 'store lead'] },
  { code: '37-2011', title: 'Janitors and Cleaners', keywords: ['janitor', 'cleaner', 'custodian', 'porter', 'sanitation'] },
  { code: '37-2012', title: 'Maids and Housekeeping Cleaners', keywords: ['housekeeper', 'housekeeping', 'room attendant', 'maid', 'turnover'] },
  { code: '37-1011', title: 'First-Line Supervisors of Housekeeping and Janitorial Workers', keywords: ['housekeeping supervisor', 'housekeeping lead', 'janitorial supervisor'] },
  { code: '37-3011', title: 'Landscaping and Groundskeeping Workers', keywords: ['landscaper', 'landscaping', 'grounds', 'groundskeeper'] },
  { code: '35-2014', title: 'Cooks, Restaurant', keywords: ['cook', 'line cook', 'grill'] },
  { code: '35-2021', title: 'Food Preparation Workers', keywords: ['prep', 'food prep', 'kitchen helper'] },
  { code: '35-3023', title: 'Fast Food and Counter Workers', keywords: ['counter', 'fast food', 'concession'] },
  { code: '35-3031', title: 'Waiters and Waitresses', keywords: ['server', 'waiter', 'waitress', 'banquet server'] },
  { code: '35-3011', title: 'Bartenders', keywords: ['bartender', 'bar'] },
  { code: '35-9021', title: 'Dishwashers', keywords: ['dishwasher', 'dish', 'steward'] },
  { code: '35-1012', title: 'First-Line Supervisors of Food Preparation and Serving Workers', keywords: ['kitchen lead', 'food supervisor', 'banquet captain'] },
  { code: '43-4081', title: 'Hotel, Motel, and Resort Desk Clerks', keywords: ['front desk', 'desk clerk', 'guest services'] },
  { code: '43-4051', title: 'Customer Service Representatives', keywords: ['customer service', 'call center', 'csr'] },
  { code: '33-9032', title: 'Security Guards', keywords: ['security', 'guard', 'loss prevention'] },
  { code: '53-3058', title: 'Passenger Vehicle Drivers, Except Bus Drivers, Transit and Intercity', keywords: ['driver', 'shuttle', 'van driver', 'chauffeur'] },
  { code: '49-9071', title: 'Maintenance and Repair Workers, General', keywords: ['maintenance', 'repair', 'handyman', 'facilities'] },
  { code: '39-3091', title: 'Amusement and Recreation Attendants', keywords: ['recreation attendant', 'pool attendant', 'ride operator', 'beach attendant'] },
];

export interface CbsaEntry {
  code: string;
  name: string;
  state: string;
}

export const CBSA_CATALOG: CbsaEntry[] = [
  { code: '18880', name: 'Crestview-Fort Walton Beach-Destin, FL', state: 'FL' },
  { code: '37860', name: 'Pensacola-Ferry Pass-Brent, FL', state: 'FL' },
  { code: '37460', name: 'Panama City-Panama City Beach, FL', state: 'FL' },
  { code: '45220', name: 'Tallahassee, FL', state: 'FL' },
  { code: '27260', name: 'Jacksonville, FL', state: 'FL' },
  { code: '23540', name: 'Gainesville, FL', state: 'FL' },
  { code: '36100', name: 'Ocala, FL', state: 'FL' },
  { code: '36740', name: 'Orlando-Kissimmee-Sanford, FL', state: 'FL' },
  { code: '19660', name: 'Deltona-Daytona Beach-Ormond Beach, FL', state: 'FL' },
  { code: '37340', name: 'Palm Bay-Melbourne-Titusville, FL', state: 'FL' },
  { code: '45300', name: 'Tampa-St. Petersburg-Clearwater, FL', state: 'FL' },
  { code: '29460', name: 'Lakeland-Winter Haven, FL', state: 'FL' },
  { code: '35840', name: 'North Port-Bradenton-Sarasota, FL', state: 'FL' },
  { code: '15980', name: 'Cape Coral-Fort Myers, FL', state: 'FL' },
  { code: '34940', name: 'Naples-Marco Island, FL', state: 'FL' },
  { code: '38940', name: 'Port St. Lucie, FL', state: 'FL' },
  { code: '33100', name: 'Miami-Fort Lauderdale-West Palm Beach, FL', state: 'FL' },
  { code: '33660', name: 'Mobile, AL', state: 'AL' },
  { code: '13820', name: 'Birmingham, AL', state: 'AL' },
  { code: '12060', name: 'Atlanta-Sandy Springs-Roswell, GA', state: 'GA' },
  { code: '16740', name: 'Charlotte-Concord-Gastonia, NC-SC', state: 'NC' },
  { code: '39580', name: 'Raleigh-Cary, NC', state: 'NC' },
  { code: '34980', name: 'Nashville-Davidson-Murfreesboro-Franklin, TN', state: 'TN' },
  { code: '26420', name: 'Houston-Pasadena-The Woodlands, TX', state: 'TX' },
  { code: '19100', name: 'Dallas-Fort Worth-Arlington, TX', state: 'TX' },
  { code: '12420', name: 'Austin-Round Rock-San Marcos, TX', state: 'TX' },
  { code: '41700', name: 'San Antonio-New Braunfels, TX', state: 'TX' },
  { code: '35620', name: 'New York-Newark-Jersey City, NY-NJ', state: 'NY' },
  { code: '16980', name: 'Chicago-Naperville-Elgin, IL-IN', state: 'IL' },
  { code: '31080', name: 'Los Angeles-Long Beach-Anaheim, CA', state: 'CA' },
];

/** Florida zip prefixes → metro (the state we operate most in). */
const ZIP3: Record<string, string> = {
  '320': '27260', '322': '27260', '323': '45220', '324': '37460', '325': '37860',
  '326': '23540', '327': '36740', '328': '36740', '329': '37340', '330': '33100',
  '331': '33100', '332': '33100', '333': '33100', '334': '33100', '335': '45300',
  '336': '45300', '337': '45300', '338': '29460', '339': '15980', '341': '34940',
  '342': '35840', '344': '36100', '346': '45300', '347': '36740', '349': '38940',
};

/** Zips whose prefix points to the wrong metro (the 325 prefix spans Pensacola and Fort Walton Beach/Destin). */
const ZIP5: Record<string, string> = {
  '32536': '18880', '32539': '18880', '32541': '18880', '32542': '18880', '32544': '18880',
  '32547': '18880', '32548': '18880', '32550': '18880', '32564': '18880', '32567': '18880',
  '32569': '18880', '32578': '18880', '32579': '18880', '32580': '18880', '32459': '18880',
  '32413': '37460', '32407': '37460', '32408': '37460',
  '32114': '19660', '32117': '19660', '32118': '19660', '32174': '19660', '32176': '19660',
};

/** City names that pin a metro when the zip is missing. */
const CITY: Record<string, string> = {
  destin: '18880', 'fort walton beach': '18880', 'miramar beach': '18880', 'santa rosa beach': '18880', niceville: '18880', crestview: '18880',
  pensacola: '37860', 'pensacola beach': '37860', 'gulf breeze': '37860', 'navarre': '37860',
  'panama city': '37460', 'panama city beach': '37460',
  tallahassee: '45220', jacksonville: '27260', gainesville: '23540', ocala: '36100', orlando: '36740', kissimmee: '36740',
  'daytona beach': '19660', melbourne: '37340', tampa: '45300', 'st. petersburg': '45300', clearwater: '45300',
  lakeland: '29460', sarasota: '35840', bradenton: '35840', 'fort myers': '15980', naples: '34940', miami: '33100',
  'fort lauderdale': '33100', 'west palm beach': '33100', mobile: '33660', birmingham: '13820', atlanta: '12060',
};

export function cbsaByCode(code: string): CbsaEntry | null {
  return CBSA_CATALOG.find((c) => c.code === code) ?? null;
}

export function socByCode(code: string): SocEntry | null {
  return SOC_CATALOG.find((s) => s.code === code) ?? null;
}

export interface Suggestion<T> {
  value: T;
  reason: string;
}

/** The metro a site most likely sits in, and why. */
export function suggestArea(site: { zip: string | null; city: string | null; state: string | null }): Suggestion<CbsaEntry> | null {
  const zip = (site.zip ?? '').trim().slice(0, 5);
  if (/^\d{5}$/.test(zip)) {
    const exact = ZIP5[zip];
    if (exact) return { value: cbsaByCode(exact)!, reason: `zip ${zip}` };
    const prefix = ZIP3[zip.slice(0, 3)];
    if (prefix) return { value: cbsaByCode(prefix)!, reason: `zips starting ${zip.slice(0, 3)}` };
  }
  const city = (site.city ?? '').trim().toLowerCase();
  if (city && CITY[city]) return { value: cbsaByCode(CITY[city])!, reason: `the city, ${site.city}` };
  return null;
}

export const positionKey = (position: string) => position.trim().toLowerCase().replace(/\s+/g, ' ');

/** The occupation a role name most likely is, by its words. Longest keyword wins, so "shift lead" beats "lead". */
export function suggestSoc(position: string): Suggestion<SocEntry> | null {
  const name = positionKey(position);
  let best: { soc: SocEntry; kw: string } | null = null;
  for (const soc of SOC_CATALOG) {
    for (const kw of soc.keywords) {
      const hit = new RegExp(`(^|[^a-z])${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`).test(name);
      if (hit && (!best || kw.length > best.kw.length)) best = { soc, kw };
    }
  }
  return best ? { value: best.soc, reason: `“${best.kw}” in the name` } : null;
}
