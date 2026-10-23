import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderAs } from '../pages/hrPack/harness';

vi.mock('@/lib/geoApi', () => ({ suggestAddresses: vi.fn() }));

import { suggestAddresses, type AddressSuggestResponse, type SuggestedAddress } from '@/lib/geoApi';
import { AddressAutocomplete, pickedFields } from '@/components/ui/AddressAutocomplete';
import { Field } from '@/components/ui/Field';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/Dialog';
import { timezoneForCounty, timezoneForState, zoneForPickedPlace } from '@/lib/stateTimezone';
import { SUPPORTED_TIMEZONES } from '@alto-people/shared';

/**
 * Address search wherever an address is typed: suggestions under the
 * street line, a pick fills the form's own boxes, the keyboard works the
 * list (combobox pattern), and where there is no type-ahead provider the
 * box is a plain text field with nothing to say about it.
 */

const FLAMINGO: SuggestedAddress = {
  label: '382 Flamingo Drive',
  address: '382 Flamingo Drive, Destin, Florida 32541',
  line1: '382 Flamingo Drive',
  line2: null,
  city: 'Destin',
  state: 'FL',
  zip: '32541',
  county: 'Okaloosa County',
  lat: 30.4012,
  lng: -86.5003,
  precision: 'exact',
};
const FLAMINGO_EAST: SuggestedAddress = {
  ...FLAMINGO,
  label: '382 Flamingo Road',
  address: '382 Flamingo Road, Miramar Beach, Florida 32550',
  line1: '382 Flamingo Road',
  city: 'Miramar Beach',
  zip: '32550',
  county: 'Walton County',
  lat: 30.38,
  lng: -86.36,
};

const answer = (r: AddressSuggestResponse) => vi.mocked(suggestAddresses).mockResolvedValue(r);
const found = (results: SuggestedAddress[], provider = 'mapbox') => answer({ available: true, provider, outage: false, results });

/** A home-address form the way the app's forms use it. */
function AddressForm({ initial = '', onSubmit = vi.fn() }: { initial?: string; onSubmit?: (v: Record<string, string>) => void }) {
  const [line1, setLine1] = useState(initial);
  const [line2, setLine2] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [zip, setZip] = useState('');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ line1, line2, city, state, zip });
      }}
    >
      <Field label="Street">
        {(p) => (
          <AddressAutocomplete
            {...p}
            value={line1}
            onChange={setLine1}
            onPick={(s) => {
              const f = pickedFields(s);
              setLine1(f.line1);
              if (f.line2) setLine2(f.line2);
              setCity(f.city);
              setState(f.state);
              setZip(f.zip);
            }}
          />
        )}
      </Field>
      <label>
        Line 2<input value={line2} onChange={(e) => setLine2(e.target.value)} />
      </label>
      <label>
        City<input value={city} onChange={(e) => setCity(e.target.value)} />
      </label>
      <label>
        State<input value={state} onChange={(e) => setState(e.target.value)} />
      </label>
      <label>
        ZIP<input value={zip} onChange={(e) => setZip(e.target.value)} />
      </label>
      <button type="submit">Save</button>
    </form>
  );
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  vi.mocked(suggestAddresses).mockReset();
});

describe('suggest, then fill', () => {
  it('a pick fills street, city, state and ZIP, closes the list and says so', async () => {
    found([FLAMINGO, FLAMINGO_EAST]);
    const user = userEvent.setup();
    renderAs('HR_ADMINISTRATOR', <AddressForm />);
    const street = screen.getByLabelText('Street');
    await user.type(street, '382 Flam');

    const list = await screen.findByRole('listbox', { name: 'Address suggestions' });
    const options = within(list).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['382 Flamingo DriveDestin, FL 32541', '382 Flamingo RoadMiramar Beach, FL 32550']);
    expect(screen.getByRole('status')).toHaveTextContent('2 addresses found');
    // One request for the settled text, not one per keystroke.
    expect(suggestAddresses).toHaveBeenCalledTimes(1);
    expect(vi.mocked(suggestAddresses).mock.calls[0]![0]).toBe('382 Flam');

    await user.click(options[0]!);
    expect(street).toHaveValue('382 Flamingo Drive');
    expect(screen.getByLabelText('City')).toHaveValue('Destin');
    expect(screen.getByLabelText('State')).toHaveValue('FL');
    expect(screen.getByLabelText('ZIP')).toHaveValue('32541');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Address filled in');
    expect(street).toHaveFocus();
    // The street line a pick wrote is not looked up again.
    await pause(400);
    expect(suggestAddresses).toHaveBeenCalledTimes(1);
  });

  it('the unit typed with the street lands on line 2 — or on the street line when the form has no line 2', () => {
    const withUnit = { ...FLAMINGO, label: '382 Flamingo Drive Apt 2', line2: 'Apt 2' };
    expect(pickedFields(withUnit)).toEqual({ line1: '382 Flamingo Drive', line2: 'Apt 2', city: 'Destin', state: 'FL', zip: '32541' });
    expect(pickedFields(withUnit, { line2: false })).toMatchObject({ line1: '382 Flamingo Drive Apt 2', line2: null });
    // A part the provider didn't name empties the box rather than keeping the last address's.
    expect(pickedFields({ ...FLAMINGO, zip: null })).toMatchObject({ zip: '' });
  });

  it('Mapbox answers carry its name under the list; other providers don’t', async () => {
    found([FLAMINGO]);
    const user = userEvent.setup();
    const { unmount } = renderAs('HR_ADMINISTRATOR', <AddressForm />);
    await user.type(screen.getByLabelText('Street'), '382 Flam');
    await screen.findByRole('listbox');
    expect(screen.getByText('Address search by Mapbox')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('1 address found');
    unmount();

    found([FLAMINGO], 'test');
    renderAs('HR_ADMINISTRATOR', <AddressForm />);
    await user.type(screen.getByLabelText('Street'), '382 Flamingo');
    await screen.findByRole('listbox');
    expect(screen.queryByText('Address search by Mapbox')).toBeNull();
  });
});

describe('the keyboard', () => {
  it('↓ and ↑ walk the list, Enter takes the highlighted address and does not submit the form', async () => {
    found([FLAMINGO, FLAMINGO_EAST]);
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    renderAs('HR_ADMINISTRATOR', <AddressForm onSubmit={onSubmit} />);
    const street = screen.getByRole('combobox', { name: 'Street' });
    expect(street).toHaveAttribute('aria-expanded', 'false');
    await user.type(street, '382 Flam');
    await screen.findByRole('listbox');
    expect(street).toHaveAttribute('aria-expanded', 'true');
    expect(street).not.toHaveAttribute('aria-activedescendant');

    await user.keyboard('{ArrowDown}');
    const [first, second] = screen.getAllByRole('option');
    expect(street).toHaveAttribute('aria-activedescendant', first!.id);
    expect(first).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowDown}');
    expect(street).toHaveAttribute('aria-activedescendant', second!.id);
    await user.keyboard('{ArrowDown}');
    expect(street).toHaveAttribute('aria-activedescendant', first!.id);
    await user.keyboard('{ArrowUp}');
    expect(street).toHaveAttribute('aria-activedescendant', second!.id);

    await user.keyboard('{Enter}');
    expect(street).toHaveValue('382 Flamingo Road');
    expect(screen.getByLabelText('City')).toHaveValue('Miramar Beach');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(street).toHaveAttribute('aria-expanded', 'false');
  });

  it('Enter with nothing highlighted is the form’s', async () => {
    found([FLAMINGO]);
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    renderAs('HR_ADMINISTRATOR', <AddressForm onSubmit={onSubmit} />);
    await user.type(screen.getByLabelText('Street'), '382 Flam');
    await screen.findByRole('listbox');
    await user.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ line1: '382 Flam', city: '' }));
  });

  it('Escape closes the list, not the dialog around it; a second Escape is the dialog’s', async () => {
    found([FLAMINGO]);
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    renderAs(
      'HR_ADMINISTRATOR',
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>New location</DialogTitle>
          <AddressForm />
        </DialogContent>
      </Dialog>,
    );
    await user.type(screen.getByLabelText('Street'), '382 Flam');
    await screen.findByRole('listbox');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Street')).toHaveValue('382 Flam');
    await user.keyboard('{Escape}');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe('falling back to plain fields', () => {
  it('with no type-ahead provider it becomes a plain text box after one answer, and stops asking', async () => {
    answer({ available: false, reason: 'not_configured', results: [] });
    const user = userEvent.setup();
    renderAs('HR_ADMINISTRATOR', <AddressForm />);
    await user.type(screen.getByLabelText('Street'), '382 Flamingo');
    await waitFor(() => expect(suggestAddresses).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole('combobox')).toBeNull());
    expect(screen.getByRole('textbox', { name: 'Street' })).toHaveValue('382 Flamingo');
    await user.type(screen.getByLabelText('Street'), ' Drive');
    await pause(400);
    expect(suggestAddresses).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('listbox')).toBeNull();
    // No noise: nothing announced, nothing printed.
    expect(screen.getByRole('status')).toHaveTextContent('');
    expect(screen.queryByText(/suggest|unavailable|mapbox/i)).toBeNull();
  });

  it('a provider outage shows nothing — the person types the address in', async () => {
    answer({ available: true, provider: 'mapbox', outage: true, results: [] });
    const user = userEvent.setup();
    renderAs('HR_ADMINISTRATOR', <AddressForm />);
    await user.type(screen.getByLabelText('Street'), '382 Flamingo');
    await waitFor(() => expect(suggestAddresses).toHaveBeenCalled());
    await pause(50);
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('');
  });

  it('asks nothing for a saved address the form opened on, or for fewer than four characters', async () => {
    found([FLAMINGO]);
    const user = userEvent.setup();
    renderAs('HR_ADMINISTRATOR', <AddressForm initial="12 Main Street" />);
    await pause(400);
    expect(suggestAddresses).not.toHaveBeenCalled();
    const street = screen.getByLabelText('Street');
    await user.clear(street);
    await user.type(street, '12 ');
    await pause(400);
    expect(suggestAddresses).not.toHaveBeenCalled();
  });
});

describe('the zone follows a picked place', () => {
  it('a county settles a two-zone state; a new state brings its own zone; the same state leaves a hand-set zone alone', () => {
    // Destin is in Florida's Central-time Panhandle, not Eastern.
    expect(zoneForPickedPlace(FLAMINGO, { state: '', timezone: 'America/New_York' })).toBe('America/Chicago');
    expect(zoneForPickedPlace(FLAMINGO, { state: 'FL', timezone: 'America/New_York' })).toBe('America/Chicago');
    const miami = { state: 'FL', county: 'Miami-Dade County' };
    expect(zoneForPickedPlace(miami, { state: 'TX', timezone: 'America/Chicago' })).toBe('America/New_York');
    expect(zoneForPickedPlace(miami, { state: 'FL', timezone: 'America/Chicago' })).toBe('America/Chicago');
    expect(timezoneForCounty('TX', 'El Paso County')).toBe('America/Denver');
    expect(timezoneForCounty('IN', 'La Porte County')).toBe('America/Chicago');
    expect(timezoneForCounty('TN', 'Knox County')).toBe('America/New_York');
    expect(timezoneForCounty('FL', 'Gulf County')).toBeNull();
  });

  it('only ever answers a zone the zone picker offers', () => {
    const states = ['AL', 'AK', 'AZ', 'CA', 'CO', 'FL', 'HI', 'ID', 'IN', 'MI', 'NY', 'TN', 'TX', 'WA'];
    for (const st of states) expect(SUPPORTED_TIMEZONES as readonly string[]).toContain(timezoneForState(st));
    expect(timezoneForState('MI')).toBe('America/New_York');
    expect(timezoneForState('PR')).toBeNull();
  });
});
