import {
  extractJson,
  findFirstJsonValue,
  repairTrailingCommas,
  stripCodeFences,
} from './json-extraction';

describe('stripCodeFences', () => {
  it('strips a ```json fence', () => {
    expect(stripCodeFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('strips a bare ``` fence', () => {
    expect(stripCodeFences('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('leaves unfenced text untouched', () => {
    expect(stripCodeFences('{"a":1}')).toBe('{"a":1}');
  });

  it('does not strip a fence that is only opened', () => {
    const input = '```json\n{"a":1}';
    expect(stripCodeFences(input)).toBe(input);
  });
});

describe('findFirstJsonValue', () => {
  it('finds a plain object', () => {
    expect(findFirstJsonValue('{"a":1}')).toBe('{"a":1}');
  });

  it('finds an array', () => {
    expect(findFirstJsonValue('[1,2,3]')).toBe('[1,2,3]');
  });

  it('skips a conversational preamble', () => {
    expect(findFirstJsonValue('Here is the document:\n{"a":1}')).toBe('{"a":1}');
  });

  it('ignores trailing commentary after the value', () => {
    expect(findFirstJsonValue('{"a":1}\n\nLet me know if you need changes.')).toBe(
      '{"a":1}',
    );
  });

  it('handles nested objects', () => {
    const input = '{"a":{"b":{"c":1}}}';
    expect(findFirstJsonValue(input)).toBe(input);
  });

  it('does not stop at a brace inside a string literal', () => {
    // A legal template body legitimately contains placeholder braces.
    const input = '{"body":"Payment due on {{date}} per clause 3"}';
    expect(findFirstJsonValue(input)).toBe(input);
  });

  it('does not stop at an escaped quote inside a string', () => {
    const input = '{"body":"the \\"Agreement\\" means {this}"}';
    expect(findFirstJsonValue(input)).toBe(input);
  });

  it('returns null when the value is truncated', () => {
    expect(findFirstJsonValue('{"a":1')).toBeNull();
  });

  it('returns null when there is no JSON at all', () => {
    expect(findFirstJsonValue('I cannot help with that request.')).toBeNull();
  });

  it('picks whichever opener comes first', () => {
    expect(findFirstJsonValue('text [1] then {"a":1}')).toBe('[1]');
  });
});

describe('repairTrailingCommas', () => {
  it('removes a trailing comma before a closing brace', () => {
    expect(repairTrailingCommas('{"a":1,}')).toBe('{"a":1}');
  });

  it('removes a trailing comma before a closing bracket', () => {
    expect(repairTrailingCommas('[1,2,]')).toBe('[1,2]');
  });

  it('removes trailing commas separated by whitespace', () => {
    expect(repairTrailingCommas('{"a":1,\n  }')).toBe('{"a":1\n  }');
  });

  it('preserves legitimate separating commas', () => {
    expect(repairTrailingCommas('{"a":1,"b":2}')).toBe('{"a":1,"b":2}');
  });

  it('does not touch commas inside string values', () => {
    const input = '{"body":"Tashkent, Uzbekistan,"}';
    expect(repairTrailingCommas(input)).toBe(input);
  });
});

describe('extractJson', () => {
  it('parses clean JSON', () => {
    const result = extractJson<{ a: number }>('{"a":1}');
    expect(result).toEqual({ ok: true, value: { a: 1 }, repaired: false });
  });

  it('parses a fully fenced payload', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({
      ok: true,
      value: { a: 1 },
      repaired: false,
    });
  });

  it('parses a fenced payload that also has a preamble', () => {
    // The fence strip only matches a fully fenced string; the brace scan
    // recovers the value when a preamble precedes the fence.
    expect(extractJson('Here you go:\n```json\n{"a":1}\n```')).toEqual({
      ok: true,
      value: { a: 1 },
      repaired: false,
    });
  });

  it('repairs a trailing comma and flags it', () => {
    const result = extractJson('{"a":1,}');
    expect(result).toEqual({ ok: true, value: { a: 1 }, repaired: true });
  });

  it('reports empty input', () => {
    expect(extractJson('')).toMatchObject({ ok: false, error: 'empty-input' });
    expect(extractJson('   ')).toMatchObject({ ok: false, error: 'empty-input' });
    expect(extractJson(null)).toMatchObject({ ok: false, error: 'empty-input' });
    expect(extractJson(undefined)).toMatchObject({
      ok: false,
      error: 'empty-input',
    });
  });

  it('reports prose with no JSON (a refusal)', () => {
    const result = extractJson('I cannot assist with that request.');
    expect(result).toMatchObject({ ok: false, error: 'no-json-found' });
  });

  it('reports a truncated response', () => {
    const result = extractJson('{"title":"Contract","sections":[');
    expect(result).toMatchObject({ ok: false, error: 'no-json-found' });
  });

  it('reports irreparably malformed JSON', () => {
    const result = extractJson('{"a": }');
    expect(result).toMatchObject({ ok: false, error: 'malformed-json' });
  });

  it('preserves non-ASCII content', () => {
    const result = extractJson<{ title: string }>(
      '{"title":"Шартнома лойиҳаси"}',
    );
    expect(result.ok && result.value.title).toBe('Шартнома лойиҳаси');
  });
});
