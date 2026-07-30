import {
  RRF_K,
  distanceToSimilarity,
  fuseRankings,
  groupByDocument,
  rrfContribution,
  type RankedResult,
} from './rank-fusion';

const ranked = (...ids: string[]): RankedResult[] =>
  ids.map((id, index) => ({ id, score: 1 - index * 0.1 }));

describe('rrfContribution', () => {
  it('is 1/(k+rank)', () => {
    expect(rrfContribution(1)).toBeCloseTo(1 / (RRF_K + 1));
    expect(rrfContribution(10)).toBeCloseTo(1 / (RRF_K + 10));
  });

  it('decreases with rank', () => {
    expect(rrfContribution(1)).toBeGreaterThan(rrfContribution(2));
    expect(rrfContribution(2)).toBeGreaterThan(rrfContribution(50));
  });

  it('ignores an invalid rank rather than returning a negative score', () => {
    expect(rrfContribution(0)).toBe(0);
    expect(rrfContribution(-1)).toBe(0);
  });

  it('flattens as k grows, sharpens as k shrinks', () => {
    const flatGap = rrfContribution(1, 1000) - rrfContribution(2, 1000);
    const sharpGap = rrfContribution(1, 1) - rrfContribution(2, 1);
    expect(sharpGap).toBeGreaterThan(flatGap);
  });
});

describe('fuseRankings', () => {
  it('ranks a result found by both retrievers above ones found by only one', () => {
    // The whole point of hybrid retrieval: agreement between two independent
    // methods is stronger evidence than one method's top hit.
    const fused = fuseRankings(
      ranked('lexical-only', 'both'),
      ranked('semantic-only', 'both'),
    );

    expect(fused[0].id).toBe('both');
    expect(fused[0].matchedBoth).toBe(true);
  });

  it('lets a mid-ranked agreement beat a single-retriever top hit', () => {
    // 'agreed' is 5th in both lists; 'lexical-top' is 1st in one and absent from
    // the other. With k=60 the two mid contributions sum higher.
    const lexical = ranked('lexical-top', 'a', 'b', 'c', 'agreed');
    const semantic = ranked('s1', 's2', 's3', 's4', 'agreed');

    const fused = fuseRankings(lexical, semantic);
    expect(fused[0].id).toBe('agreed');
  });

  it('records each retriever’s rank and score', () => {
    const fused = fuseRankings(ranked('x', 'y'), ranked('y', 'x'));
    const x = fused.find((result) => result.id === 'x')!;

    expect(x.lexicalRank).toBe(1);
    expect(x.semanticRank).toBe(2);
    expect(x.lexicalScore).toBeCloseTo(1);
    expect(x.semanticScore).toBeCloseTo(0.9);
  });

  it('marks a single-retriever result as not matching both', () => {
    const fused = fuseRankings(ranked('only'), []);
    expect(fused[0].matchedBoth).toBe(false);
    expect(fused[0].semanticRank).toBeNull();
    expect(fused[0].semanticScore).toBeNull();
  });

  it('works with one retriever returning nothing', () => {
    expect(fuseRankings(ranked('a', 'b'), [])).toHaveLength(2);
    expect(fuseRankings([], ranked('a', 'b'))).toHaveLength(2);
    expect(fuseRankings([], [])).toHaveLength(0);
  });

  it('is unaffected by the scale of the incoming scores', () => {
    // RRF uses positions only. A retriever whose scores are 1000x larger must not
    // dominate — which is exactly what breaks when scores are naively summed.
    const normal = fuseRankings(ranked('a', 'b'), ranked('b', 'a'));
    const inflated = fuseRankings(
      [
        { id: 'a', score: 1_000_000 },
        { id: 'b', score: 999_999 },
      ],
      ranked('b', 'a'),
    );

    expect(inflated.map((result) => result.id)).toEqual(
      normal.map((result) => result.id),
    );
  });

  describe('weights', () => {
    it('lets semantic outweigh lexical', () => {
      const fused = fuseRankings(ranked('lex'), ranked('sem'), {
        lexical: 1,
        semantic: 3,
      });
      expect(fused[0].id).toBe('sem');
    });

    it('reduces a retriever to nothing at weight zero', () => {
      const fused = fuseRankings(ranked('lex'), ranked('sem'), {
        lexical: 0,
        semantic: 1,
      });
      const lex = fused.find((result) => result.id === 'lex')!;
      expect(lex.rrfScore).toBe(0);
      expect(fused[0].id).toBe('sem');
    });

    it('still records the rank of a zero-weighted retriever', () => {
      // The result should be explainable even when it contributed no score.
      const fused = fuseRankings(ranked('lex'), [], { lexical: 0 });
      expect(fused[0].lexicalRank).toBe(1);
    });
  });

  it('breaks ties deterministically, so pagination is stable', () => {
    // Identical positions in both lists produce identical scores; without an
    // explicit tie-break the order would depend on Map insertion.
    const first = fuseRankings(ranked('b', 'a'), ranked('a', 'b'));
    const second = fuseRankings(ranked('a', 'b'), ranked('b', 'a'));

    expect(first.map((result) => result.id)).toEqual(
      second.map((result) => result.id),
    );
  });
});

describe('distanceToSimilarity', () => {
  it('maps identical vectors to 1', () => {
    expect(distanceToSimilarity(0)).toBe(1);
  });

  it('maps orthogonal vectors to 0.5', () => {
    expect(distanceToSimilarity(1)).toBe(0.5);
  });

  it('maps opposite vectors to 0', () => {
    expect(distanceToSimilarity(2)).toBe(0);
  });

  it('clamps values outside the expected range', () => {
    // Floating-point error in pgvector can return a hair outside [0, 2]; a
    // similarity of 1.0000001 would look like a bug in the UI.
    expect(distanceToSimilarity(-0.0001)).toBe(1);
    expect(distanceToSimilarity(2.0001)).toBe(0);
  });
});

describe('groupByDocument', () => {
  const result = (id: string, rrfScore: number) => ({ id, rrfScore });

  it('collapses several chunks of one document into a single hit', () => {
    // Otherwise a long document repeating a clause occupies the whole first page
    // and buries every other document.
    const grouped = groupByDocument(
      [result('c1', 0.9), result('c2', 0.8), result('c3', 0.7)],
      (chunk) => (chunk.id === 'c3' ? 'doc2' : 'doc1'),
    );

    expect(grouped).toHaveLength(2);
    expect(grouped[0].documentId).toBe('doc1');
    expect(grouped[0].chunks).toHaveLength(2);
  });

  it('gives a document its best chunk’s score', () => {
    const grouped = groupByDocument(
      [result('c1', 0.9), result('c2', 0.5)],
      () => 'doc1',
    );
    expect(grouped[0].score).toBe(0.9);
    expect(grouped[0].best.id).toBe('c1');
  });

  it('orders documents by their best chunk', () => {
    const grouped = groupByDocument(
      [result('a1', 0.5), result('b1', 0.9)],
      (chunk) => (chunk.id.startsWith('a') ? 'docA' : 'docB'),
    );
    expect(grouped.map((group) => group.documentId)).toEqual(['docB', 'docA']);
  });

  it('caps the supporting chunks it carries', () => {
    const grouped = groupByDocument(
      [
        result('c1', 0.9),
        result('c2', 0.8),
        result('c3', 0.7),
        result('c4', 0.6),
        result('c5', 0.5),
      ],
      () => 'doc1',
      2,
    );
    expect(grouped[0].chunks).toHaveLength(2);
  });

  it('handles an empty result set', () => {
    expect(groupByDocument([], () => 'doc')).toEqual([]);
  });
});
