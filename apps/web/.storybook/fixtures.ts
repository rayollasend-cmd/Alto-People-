/**
 * Made-up records the stories share. Names are invented, sites are the dev
 * seed's kind of places, and the list is long enough (60) to show how a
 * layout holds up past the first screen, with a few long names on purpose.
 */

export interface StoryPerson {
  id: string;
  name: string;
  email: string;
  role: string;
  site: string;
  status: 'Active' | 'Onboarding' | 'On leave' | 'Inactive';
  hours: number;
  hired: string;
}

const FIRST = ['Maria', 'Dana', 'Luis', 'Aisha', 'Tomás', 'Priya', 'Kwame', 'Yuki', 'Olena', 'Jean-Baptiste', 'Grace', 'Mateo', 'Fatima', 'Noah', 'Sofía'];
const LAST = ['Lopez', 'Reyes', 'Okafor', 'Nguyen', 'Haddad', 'Kowalczyk', 'Bianchi', 'Santos-Villanueva', 'Ivanenko', 'Charles', 'Park', 'Mensah'];
const ROLES = ['Housekeeper', 'Room attendant', 'Houseperson', 'Laundry attendant', 'Shift supervisor', 'Front desk agent'];
const SITES = ['Coastal Resort · Destin', 'Harbor Inn · Pensacola', 'Bayfront Suites · Panama City Beach', 'Gulf Breeze Hotel'];
const STATUSES: StoryPerson['status'][] = ['Active', 'Active', 'Active', 'Onboarding', 'On leave', 'Inactive'];

export const PEOPLE: StoryPerson[] = Array.from({ length: 60 }, (_, i) => {
  const first = FIRST[i % FIRST.length];
  const last = LAST[(i * 7) % LAST.length];
  const day = String((i % 27) + 1).padStart(2, '0');
  const month = String((i % 12) + 1).padStart(2, '0');
  return {
    id: `p-${String(i + 1).padStart(3, '0')}`,
    name: i === 4 ? 'Jean-Baptiste Santos-Villanueva de la Cruz' : `${first} ${last}`,
    email: `${first}.${last}`.toLowerCase().replace(/[^a-z.]/g, '') + '@example.com',
    role: ROLES[i % ROLES.length],
    site: SITES[i % SITES.length],
    status: STATUSES[i % STATUSES.length],
    hours: Math.round(((i * 37) % 44) * 10 + 5) / 10,
    hired: `2025-${month}-${day}`,
  };
});
