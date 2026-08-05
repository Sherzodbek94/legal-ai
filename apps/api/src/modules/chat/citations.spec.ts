import {
  checkCitations,
  isUngrounded,
  stripInvented,
  type ResolvedCitation,
} from './citations';

const source = (n: number, overrides: Partial<ResolvedCitation> = {}): ResolvedCitation => ({
  token: `S${n}`,
  kind: 'corpus',
  refId: `chunk_${n}`,
  citation: `Fuqarolik kodeksi, ${340 + n}-modda`,
  url: null,
  superseded: false,
  ...overrides,
});

const SUPPLIED = [source(1), source(2), source(3)];

describe('checkCitations', () => {
  it('resolves the sources an answer referred to', () => {
    const check = checkCitations('Bu shunday [S1]. Yana [S3].', SUPPLIED);

    expect(check.cited.map((c) => c.token)).toEqual(['S1', 'S3']);
    expect(check.invented).toEqual([]);
  });

  it('catches a source the model was never given', () => {
    // The whole reason sources are numbered rather than named. A model that
    // invents "347-modda" produces something a lawyer cannot distinguish from
    // a real citation; a model that invents [S9] is caught by counting.
    const check = checkCitations('Qoida shunday [S9].', SUPPLIED);

    expect(check.invented).toEqual(['S9']);
    expect(check.cited).toEqual([]);
  });

  it('separates the real citations from the invented ones', () => {
    const check = checkCitations('Birinchi [S1], ikkinchi [S7].', SUPPLIED);

    expect(check.cited.map((c) => c.token)).toEqual(['S1']);
    expect(check.invented).toEqual(['S7']);
  });

  it('reports sources that went unused', () => {
    const check = checkCitations('Faqat [S2].', SUPPLIED);

    expect(check.unused).toEqual(['S1', 'S3']);
  });

  it('counts a repeated citation once', () => {
    const check = checkCitations('[S1] va yana [S1].', SUPPLIED);

    expect(check.cited).toHaveLength(1);
  });

  it('orders sources numerically, not lexically', () => {
    const many = Array.from({ length: 12 }, (_, i) => source(i + 1));
    const check = checkCitations('[S10] [S2] [S1]', many);

    expect(check.cited.map((c) => c.token)).toEqual(['S1', 'S2', 'S10']);
  });

  it('finds nothing in an answer with no citations', () => {
    const check = checkCitations('Menimcha bu shunday.', SUPPLIED);

    expect(check.cited).toEqual([]);
    expect(check.invented).toEqual([]);
  });

  it('does not resume mid-string on a second call', () => {
    // The token pattern is module-level and global.
    const answer = 'Bu shunday [S1].';

    expect(checkCitations(answer, SUPPLIED).cited).toHaveLength(1);
    expect(checkCitations(answer, SUPPLIED).cited).toHaveLength(1);
  });
});

describe('stripInvented', () => {
  it('removes a reference that resolves to nothing', () => {
    // Left in place it renders as a footnote marker pointing at nothing, which
    // reads as though a source exists and the UI failed to show it.
    expect(stripInvented('Qoida shunday [S9].', ['S9'])).toBe('Qoida shunday.');
  });

  it('keeps the real citations around it', () => {
    expect(stripInvented('Birinchi [S1], ikkinchi [S7].', ['S7'])).toBe(
      'Birinchi [S1], ikkinchi.',
    );
  });

  it('leaves an answer with nothing invented untouched', () => {
    expect(stripInvented('Bu shunday [S1].', [])).toBe('Bu shunday [S1].');
  });

  it('does not leave doubled spaces behind', () => {
    expect(stripInvented('Bir [S9] ikki', ['S9'])).toBe('Bir ikki');
  });
});

describe('isUngrounded', () => {
  it('is true when nothing was retrieved', () => {
    const check = checkCitations('Javob.', []);

    expect(isUngrounded(check, 0)).toBe(true);
  });

  it('is true when sources were supplied but none cited', () => {
    // Same thing to a reader: the answer is the model's own opinion, and that
    // has to be visible rather than inferred from an empty source list.
    const check = checkCitations('Menimcha bu shunday.', SUPPLIED);

    expect(isUngrounded(check, SUPPLIED.length)).toBe(true);
  });

  it('is false when the answer rests on a real source', () => {
    const check = checkCitations('Bu shunday [S2].', SUPPLIED);

    expect(isUngrounded(check, SUPPLIED.length)).toBe(false);
  });

  it('is true when every citation was invented', () => {
    const check = checkCitations('Bu shunday [S9].', SUPPLIED);

    expect(isUngrounded(check, SUPPLIED.length)).toBe(true);
  });
});
