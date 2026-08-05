/**
 * Reading a template's variable contract.
 *
 * The value comes out of a JSON column that an older release may have written,
 * so the property under test is tolerance: an unreadable schema must render as
 * "no variables" and let the API reject the submission with a precise reason.
 * A throw here would take down the page where the form belongs.
 */
import { parseSchema } from './variable-schema';

const VALID = {
  version: 1,
  variables: [
    { key: 'contract_no', label: 'Shartnoma raqami', type: 'string', required: true },
    { key: 'amount', label: 'Summa', type: 'money', currency: 'UZS' },
  ],
};

describe('parseSchema', () => {
  it('reads a well-formed schema', () => {
    expect(parseSchema(VALID)).toHaveLength(2);
    expect(parseSchema(VALID)[0]).toMatchObject({ key: 'contract_no', type: 'string' });
  });

  it('preserves the order the template declared', () => {
    // The form renders in array order; re-ordering would move fields under the
    // user between releases.
    expect(parseSchema(VALID).map((variable) => variable.key)).toEqual([
      'contract_no',
      'amount',
    ]);
  });

  it.each([null, undefined, 'a string', 42, true])(
    'returns an empty list for %p rather than throwing',
    (raw) => {
      expect(parseSchema(raw)).toEqual([]);
    },
  );

  it('returns an empty list when variables is missing', () => {
    expect(parseSchema({ version: 1 })).toEqual([]);
  });

  it('returns an empty list when variables is not an array', () => {
    expect(parseSchema({ version: 1, variables: { key: 'x' } })).toEqual([]);
  });

  it('drops entries without a key or label, keeping the rest', () => {
    // Partial tolerance beats all-or-nothing: one malformed entry written by an
    // older release should not blank out a form with nine good fields.
    const parsed = parseSchema({
      version: 1,
      variables: [
        { key: 'good', label: 'Good' },
        { key: 'no-label' },
        { label: 'no key' },
        null,
        'not an object',
        { key: 42, label: 'wrong type' },
      ],
    });

    expect(parsed).toHaveLength(1);
    expect(parsed[0].key).toBe('good');
  });

  it('accepts an empty variable list', () => {
    // A template with no variables is a legitimate template.
    expect(parseSchema({ version: 1, variables: [] })).toEqual([]);
  });

  it('passes through fields it does not know about', () => {
    // The API is the authority on the contract; a field added there must not
    // require a release here to survive the round trip.
    const [parsed] = parseSchema({
      version: 1,
      variables: [{ key: 'k', label: 'L', type: 'string', somethingNew: 'kept' }],
    });

    expect(parsed).toMatchObject({ somethingNew: 'kept' });
  });
});
