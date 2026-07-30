/**
 * Metric label normalisation.
 *
 * Prometheus creates one time series per distinct label combination. Labelling
 * with a raw URL therefore creates a series per document id — unbounded
 * cardinality, which exhausts the scrape target's memory and then the Prometheus
 * server's. It is usually discovered as an OOM in the monitoring stack during the
 * incident the monitoring was meant to explain.
 *
 * These tests pin the one function standing between the two.
 */
import { normalizeRoute } from './metrics.service';

describe('normalizeRoute', () => {
  describe('with a matched route', () => {
    it('uses the route pattern verbatim', () => {
      // Express has already collapsed the id into `:id`; nothing more to do.
      expect(normalizeRoute('/documents/:id/export/:format', '/documents/clx123/export/pdf'))
        .toBe('/documents/:id/export/:format');
    });

    it('prefers the pattern even when the raw path looks clean', () => {
      expect(normalizeRoute('/health/ready', '/health/ready')).toBe('/health/ready');
    });
  });

  describe('without a matched route', () => {
    it('collapses a cuid', () => {
      // The id format this schema uses throughout.
      expect(normalizeRoute(undefined, '/documents/clx1a2b3c4d5e6f7g8h9i0j')).toBe(
        '/documents/:id',
      );
    });

    it('collapses a uuid', () => {
      expect(
        normalizeRoute(undefined, '/orders/3f2504e0-4f89-11d3-9a0c-0305e82c3301'),
      ).toBe('/orders/:id');
    });

    it('collapses a numeric id', () => {
      expect(normalizeRoute(undefined, '/payments/click/900001')).toBe(
        '/payments/click/:id',
      );
    });

    it('collapses anything long enough to be a token or hash', () => {
      // Verification tokens appear in URLs and are unbounded in value.
      const token = 'a'.repeat(64);
      expect(normalizeRoute(undefined, `/verify/${token}`)).toBe('/verify/:id');
    });

    it('collapses several ids in one path', () => {
      expect(
        normalizeRoute(undefined, '/companies/clx1a2b3c4d5e6f7g8h9i0j/assets/12345'),
      ).toBe('/companies/:id/assets/:id');
    });

    it('keeps ordinary path segments', () => {
      expect(normalizeRoute(undefined, '/billing/plans')).toBe('/billing/plans');
    });

    it('strips the query string', () => {
      // Query values are user-controlled and would be unbounded.
      expect(normalizeRoute(undefined, '/search?q=supply+contract&limit=20')).toBe(
        '/search',
      );
    });

    it('bounds cardinality for a scan of random paths', () => {
      // The property that actually matters: an attacker probing thousands of
      // URLs must not create thousands of series.
      const labels = new Set<string>();
      for (let i = 0; i < 500; i++) {
        labels.add(normalizeRoute(undefined, `/documents/clx${'a'.repeat(20)}${i}`));
      }
      expect(labels.size).toBe(1);
    });

    it('handles the root path', () => {
      expect(normalizeRoute(undefined, '/')).toBe('/');
    });

    it('handles an empty path without producing an empty label', () => {
      expect(normalizeRoute(undefined, '')).toBe('/');
    });

    it('does not collapse short alphanumeric segments that are real routes', () => {
      // `pdf` and `docx` are format names, not ids; collapsing them would merge
      // two endpoints whose latency profiles differ by an order of magnitude.
      expect(normalizeRoute(undefined, '/documents/export/pdf')).toBe(
        '/documents/export/pdf',
      );
      expect(normalizeRoute(undefined, '/payments/payme')).toBe('/payments/payme');
    });
  });
});
