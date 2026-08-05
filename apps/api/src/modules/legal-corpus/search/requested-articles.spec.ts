import { requestedArticles } from './corpus-search.service';

describe('requestedArticles', () => {
  describe('citation forms a lawyer actually types', () => {
    it.each([
      ['347-modda', ['347']],
      ['347-moddasi', ['347']],
      ['347-moddasida nazarda tutilgan', ['347']],
      ['347-модда', ['347']],
      ['статья 347', ['347']],
      ['Article 12', ['12']],
    ])('reads %s', (query, expected) => {
      expect(requestedArticles(query)).toEqual(expected);
    });

    it('keeps the suffix of an inserted article', () => {
      // 347-1 was inserted between 347 and 348 by amendment; it is a different
      // provision, and returning 347 for it would be the wrong article.
      expect(requestedArticles('347-1-modda')).toEqual(['347-1']);
    });

    it('reads several from one query', () => {
      expect(requestedArticles('347-modda va 348-modda')).toEqual(['347', '348']);
    });

    it('does not repeat one mentioned twice', () => {
      expect(requestedArticles('347-modda, 347-moddasi')).toEqual(['347']);
    });
  });

  describe('what it deliberately ignores', () => {
    it('ignores a bare number', () => {
      // Far more often a sum of money, a year, or a contract number than an
      // article reference. Treating it as one would reorder ordinary searches
      // around a coincidence.
      expect(requestedArticles('347')).toEqual([]);
      expect(requestedArticles('12000000 so‘m')).toEqual([]);
      expect(requestedArticles('2026 yil')).toEqual([]);
    });

    it('finds nothing in an ordinary query', () => {
      expect(requestedArticles('hisobga olish yo‘li bilan tugatish')).toEqual([]);
    });

    it('handles an empty query', () => {
      expect(requestedArticles('')).toEqual([]);
    });
  });
});
