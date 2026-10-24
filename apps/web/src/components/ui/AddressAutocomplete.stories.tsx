import * as React from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, screen, userEvent, within } from 'storybook/test';
import type { SuggestedAddress } from '@/lib/geoApi';
import { AddressAutocomplete, pickedFields } from './AddressAutocomplete';
import { Field } from './Field';
import { Input } from './Input';

const SUGGESTIONS: SuggestedAddress[] = [
  { label: '1200 Scenic Gulf Dr', address: '1200 Scenic Gulf Dr, Destin, FL 32550', line1: '1200 Scenic Gulf Dr', line2: null, city: 'Destin', state: 'FL', zip: '32550', county: 'Okaloosa County', lat: 30.3857, lng: -86.4176, precision: 'exact' },
  { label: '1200 Scenic Hwy', address: '1200 Scenic Hwy, Pensacola, FL 32503', line1: '1200 Scenic Hwy', line2: null, city: 'Pensacola', state: 'FL', zip: '32503', county: 'Escambia County', lat: 30.4469, lng: -87.1913, precision: 'exact' },
  { label: '1200 Scenic Ave Apt 2', address: '1200 Scenic Ave Apt 2, Panama City Beach, FL 32413', line1: '1200 Scenic Ave', line2: 'Apt 2', city: 'Panama City Beach', state: 'FL', zip: '32413', county: 'Bay County', lat: 30.1766, lng: -85.8055, precision: 'approximate' },
];

/** The street box inside a small address form: a pick fills the rest. */
function AddressForm() {
  const [line1, setLine1] = React.useState('');
  const [city, setCity] = React.useState('');
  const [state, setState] = React.useState('');
  const [zip, setZip] = React.useState('');
  return (
    <div className="grid max-w-lg gap-3">
      <Field label="Street address">
        {(f) => (
          <AddressAutocomplete
            {...f}
            value={line1}
            onChange={setLine1}
            onPick={(s) => {
              const f = pickedFields(s, { line2: false });
              setLine1(f.line1);
              setCity(f.city);
              setState(f.state);
              setZip(f.zip);
            }}
          />
        )}
      </Field>
      <div className="grid grid-cols-3 gap-3">
        <Field label="City">{(f) => <Input {...f} value={city} onChange={(e) => setCity(e.target.value)} />}</Field>
        <Field label="State">{(f) => <Input {...f} value={state} onChange={(e) => setState(e.target.value)} />}</Field>
        <Field label="ZIP">{(f) => <Input {...f} value={zip} onChange={(e) => setZip(e.target.value)} />}</Field>
      </div>
    </div>
  );
}

const meta = {
  title: 'Kit/AddressAutocomplete',
  component: AddressForm,
  parameters: {
    api: [{ path: /^\/geo\/address-suggest\?q=/, body: { available: true, provider: 'mapbox', outage: false, results: SUGGESTIONS } }],
  },
} satisfies Meta<typeof AddressForm>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Type four characters and the suggestions open; a pick fills city, state and ZIP. */
export const Suggestions: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByRole('combobox', { name: 'Street address' }), '1200 Scenic');
    const list = await screen.findByRole('listbox');
    await expect(within(list).getAllByRole('option')).toHaveLength(3);
    await userEvent.click(within(list).getByRole('option', { name: /Pensacola/ }));
    await expect(canvas.getByLabelText('City')).toHaveValue('Pensacola');
    await expect(canvas.getByLabelText('ZIP')).toHaveValue('32503');
  },
};

/** The list stays open on screen, for looking at (and for axe). */
export const OpenList: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.type(within(canvasElement).getByRole('combobox'), '1200 Scenic');
    await screen.findByRole('listbox');
    await userEvent.keyboard('{ArrowDown}');
  },
};

/** No type-ahead provider (dev without a key): a plain text box, nothing to explain. */
export const NoProvider: Story = {
  parameters: {
    api: [{ path: /^\/geo\/address-suggest\?q=/, body: { available: false, reason: 'not_configured', results: [] } }],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByLabelText('Street address'), '1200 Scenic');
    await expect(await canvas.findByRole('textbox', { name: 'Street address' })).toBeInTheDocument();
  },
};
