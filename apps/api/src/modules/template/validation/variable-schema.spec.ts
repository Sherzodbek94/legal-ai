import {
  parseVariableSchema,
  VariableSchemaError,
  type VariableSchema,
} from './variable-schema';

const schemaWith = (...variables: unknown[]) => ({ version: 1, variables });

const issuesOf = (raw: unknown): string[] => {
  try {
    parseVariableSchema(raw);
    return [];
  } catch (error) {
    if (error instanceof VariableSchemaError) {
      return error.issues.map((issue) => issue.message);
    }
    throw error;
  }
};

describe('parseVariableSchema', () => {
  describe('happy path', () => {
    it('accepts a well-formed schema and normalises it', () => {
      const parsed: VariableSchema = parseVariableSchema(
        schemaWith(
          { key: 'contract_number', label: 'Contract number', type: 'string' },
          { key: 'signed_at', label: 'Signed at', type: 'date', required: true },
        ),
      );

      expect(parsed.version).toBe(1);
      expect(parsed.variables).toHaveLength(2);
      expect(parsed.variables[1]).toMatchObject({
        key: 'signed_at',
        type: 'date',
        required: true,
      });
    });

    it('falls back to the key when no label is given', () => {
      const parsed = parseVariableSchema(
        schemaWith({ key: 'party_name', type: 'string' }),
      );
      expect(parsed.variables[0].label).toBe('party_name');
    });

    it('treats a missing `required` as optional', () => {
      const parsed = parseVariableSchema(
        schemaWith({ key: 'note', type: 'text' }),
      );
      expect(parsed.variables[0].required).toBe(false);
    });

    it('defaults money to UZS', () => {
      const parsed = parseVariableSchema(
        schemaWith({ key: 'amount', type: 'money' }),
      );
      expect(parsed.variables[0].currency).toBe('UZS');
    });

    it('accepts bare strings as enum options', () => {
      const parsed = parseVariableSchema(
        schemaWith({ key: 'currency', type: 'enum', options: ['UZS', 'USD'] }),
      );
      expect(parsed.variables[0].options).toEqual([
        { value: 'UZS' },
        { value: 'USD' },
      ]);
    });

    it('keeps option labels when given as objects', () => {
      const parsed = parseVariableSchema(
        schemaWith({
          key: 'term',
          type: 'enum',
          options: [{ value: 'M12', label: '12 months' }],
        }),
      );
      expect(parsed.variables[0].options).toEqual([
        { value: 'M12', label: '12 months' },
      ]);
    });

    it('allows a negative minimum, for credits and adjustments', () => {
      const parsed = parseVariableSchema(
        schemaWith({ key: 'adjustment', type: 'money', min: -1000, max: 1000 }),
      );
      expect(parsed.variables[0].min).toBe(-1000);
    });
  });

  describe('structural validation', () => {
    it('rejects a non-object schema', () => {
      expect(() => parseVariableSchema('nope')).toThrow(VariableSchemaError);
    });

    it('rejects an unknown schema version', () => {
      expect(issuesOf({ version: 2, variables: [] })).toContain(
        'schema version must be 1',
      );
    });

    it('rejects variables that are not an array', () => {
      expect(issuesOf({ version: 1, variables: {} })).toContain(
        'variables must be an array',
      );
    });

    it('rejects a key that is not snake_case', () => {
      expect(issuesOf(schemaWith({ key: 'Contract-Number', type: 'string' }))).toEqual(
        [expect.stringContaining('must be snake_case')],
      );
    });

    it('rejects a duplicate key', () => {
      expect(
        issuesOf(
          schemaWith(
            { key: 'party', type: 'string' },
            { key: 'party', type: 'string' },
          ),
        ),
      ).toEqual([expect.stringContaining('duplicate variable key')]);
    });

    it('rejects an unknown type', () => {
      expect(issuesOf(schemaWith({ key: 'x', type: 'timestamp' }))).toEqual([
        expect.stringContaining('must be one of'),
      ]);
    });

    it('rejects an enum with no options', () => {
      expect(issuesOf(schemaWith({ key: 'x', type: 'enum', options: [] }))).toEqual(
        [expect.stringContaining('non-empty array')],
      );
    });

    it('rejects duplicate enum values', () => {
      expect(
        issuesOf(
          schemaWith({ key: 'x', type: 'enum', options: ['A', 'A'] }),
        ),
      ).toEqual([expect.stringContaining('duplicates value')]);
    });

    it('rejects minLength above maxLength', () => {
      expect(
        issuesOf(
          schemaWith({ key: 'x', type: 'string', minLength: 10, maxLength: 5 }),
        ),
      ).toEqual([expect.stringContaining('cannot exceed maxLength')]);
    });

    it('rejects min above max', () => {
      expect(
        issuesOf(schemaWith({ key: 'x', type: 'number', min: 10, max: 5 })),
      ).toEqual([expect.stringContaining('cannot exceed max')]);
    });

    it('rejects a currency that is not ISO 4217', () => {
      expect(
        issuesOf(schemaWith({ key: 'x', type: 'money', currency: 'sum' })),
      ).toEqual([expect.stringContaining('ISO 4217')]);
    });

    it('reports every problem at once, not just the first', () => {
      const issues = issuesOf(
        schemaWith(
          { key: 'Bad Key', type: 'string' },
          { key: 'ok', type: 'nonsense' },
        ),
      );
      expect(issues).toHaveLength(2);
    });

    it('caps maxLength at the absolute ceiling', () => {
      const parsed = parseVariableSchema(
        schemaWith({ key: 'body', type: 'text', maxLength: 999_999 }),
      );
      expect(parsed.variables[0].maxLength).toBe(10_000);
    });
  });

  describe('pattern safety', () => {
    it('accepts a simple anchored pattern', () => {
      const parsed = parseVariableSchema(
        schemaWith({ key: 'stir', type: 'string', pattern: '\\d{9}' }),
      );
      expect(parsed.variables[0].pattern).toBe('\\d{9}');
    });

    it('rejects a nested quantifier that risks catastrophic backtracking', () => {
      expect(
        issuesOf(schemaWith({ key: 'x', type: 'string', pattern: '(a+)+' })),
      ).toEqual([expect.stringContaining('catastrophic backtracking')]);
    });

    it('rejects adjacent unbounded quantifiers', () => {
      expect(
        issuesOf(schemaWith({ key: 'x', type: 'string', pattern: '\\d+\\s*\\d+' })),
      ).toEqual([expect.stringContaining('catastrophic backtracking')]);
    });

    it('rejects a pattern that is not a valid regular expression', () => {
      expect(
        issuesOf(schemaWith({ key: 'x', type: 'string', pattern: '[unclosed' })),
      ).toEqual([expect.stringContaining('not a valid regular expression')]);
    });

    it('rejects an over-long pattern', () => {
      expect(
        issuesOf(
          schemaWith({ key: 'x', type: 'string', pattern: 'a'.repeat(201) }),
        ),
      ).toEqual([expect.stringContaining('at most 200 characters')]);
    });
  });

  describe('size limits', () => {
    it('rejects a schema with more variables than a form can carry', () => {
      const variables = Array.from({ length: 201 }, (_, index) => ({
        key: `field_${index}`,
        type: 'string',
      }));
      expect(issuesOf({ version: 1, variables })).toContain(
        'a template may declare at most 200 variables',
      );
    });
  });
});

/**
 * The `advanced` flag — what the compact form is allowed to hide.
 *
 * The shipped employment contract declares 31 variables, 30 required. Most are
 * statutory or house-standard figures identical on every contract; a handful
 * are the particulars of this hire. Splitting them is what makes the form
 * fillable — but only if hiding a field never makes the form unsubmittable.
 */
describe('advanced variables', () => {
  const schema = (variable: Record<string, unknown>) =>
    parseVariableSchema({ version: 1, variables: [variable] }).variables[0];

  const issuesFor = (variable: Record<string, unknown>) => {
    try {
      parseVariableSchema({ version: 1, variables: [variable] });
      return [];
    } catch (error) {
      return (error as VariableSchemaError).issues;
    }
  };

  it('marks an optional variable advanced', () => {
    expect(
      schema({ key: 'probation_months', label: 'Sinov', type: 'integer' }).advanced,
    ).toBeUndefined();

    expect(
      schema({
        key: 'probation_months',
        label: 'Sinov',
        type: 'integer',
        advanced: true,
      }).advanced,
    ).toBe(true);
  });

  it('marks a required variable advanced when it has a default to fall back on', () => {
    // Required *and* hidden is fine as long as leaving it alone still submits.
    expect(
      schema({
        key: 'annual_leave_days',
        label: "Yillik ta'til",
        type: 'integer',
        required: true,
        defaultValue: 21,
        advanced: true,
      }).advanced,
    ).toBe(true);
  });

  it('refuses to hide a required variable with nothing to fall back on', () => {
    // Otherwise the compact form silently omits a field the API will demand,
    // and the drafter gets a rejection naming a variable they never saw.
    const issues = issuesFor({
      key: 'monthly_salary',
      label: 'Oylik ish haqi',
      type: 'money',
      required: true,
      advanced: true,
    });

    expect(issues).toHaveLength(1);
    expect(issues[0].path).toBe('variables[0].advanced');
    expect(issues[0].message).toMatch(/required with no defaultValue/);
  });

  it('rejects rather than quietly downgrading to advanced: false', () => {
    // An author who wrote `advanced: true` believes the field needs no
    // attention. Accepting the schema with the flag dropped would leave them
    // with a form they think is compact and is not.
    expect(() =>
      parseVariableSchema({
        version: 1,
        variables: [
          { key: 'x', label: 'X', type: 'string', required: true, advanced: true },
        ],
      }),
    ).toThrow(VariableSchemaError);
  });

  it('ignores a non-true advanced value rather than guessing', () => {
    for (const advanced of [false, 'yes', 1, null]) {
      expect(
        schema({ key: 'x', label: 'X', type: 'string', advanced }).advanced,
      ).toBeUndefined();
    }
  });

  it('lets a required enum with a default be advanced', () => {
    // The shape most house-standard clauses take: a fixed set of answers, one
    // of which is the usual one.
    const variable = schema({
      key: 'contract_duration_type',
      label: 'Shartnoma muddati turi',
      type: 'enum',
      required: true,
      options: [
        { value: 'muddatsiz', label: 'Muddatsiz' },
        { value: 'muddatli', label: 'Muddatli' },
      ],
      defaultValue: 'muddatsiz',
      advanced: true,
    });

    expect(variable.advanced).toBe(true);
    expect(variable.options).toHaveLength(2);
  });
});
