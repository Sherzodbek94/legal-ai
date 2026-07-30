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
