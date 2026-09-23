import { describe, expect, it } from 'vitest';
import { splitUnit } from '../../lib/geocode.js';

/**
 * Riders in apartments type their unit, because the driver needs it — and
 * Nominatim misreads it: "…Unit B" finds nothing, "…Apt 2" drops to the
 * bare street, "…#2" comes back as house number 2, graded exact. So the
 * lookup gets the building and the address keeps the unit.
 */
describe('splitUnit', () => {
  it.each([
    ['382 Flamingo Dr Apt 2', '382 Flamingo Dr', 'Apt 2'],
    ['382 Flamingo Dr #2', '382 Flamingo Dr', '#2'],
    ['382 Flamingo Dr Unit B', '382 Flamingo Dr', 'Unit B'],
    ['382 Flamingo Dr, Apt 2, Destin FL', '382 Flamingo Dr, Destin FL', 'Apt 2'],
    ['Apt 4B, 302 17th St Niceville', '302 17th St Niceville', 'Apt 4B'],
    ['9 Main St Bldg 3 Apt 204', '9 Main St', 'Bldg 3 Apt 204'],
    ['12 Oak St Apt. #7', '12 Oak St', 'Apt. #7'],
    ['apto. 7, 12 Oak St', '12 Oak St', 'apto. 7'],
    ['Hwy 98 Lot 12', 'Hwy 98', 'Lot 12'],
  ])('%s → the building, and the unit kept', (q, street, unit) => {
    expect(splitUnit(q)).toEqual({ street, unit });
  });

  it.each(['123 Lot Rd', '55 Suite Dr', '10 Unity Ave', '400 Ste Genevieve Ave', '1500 NW 7th Ave'])(
    'leaves a street that only contains one of the words alone: %s',
    (q) => {
      expect(splitUnit(q)).toEqual({ street: q, unit: null });
    },
  );
});
