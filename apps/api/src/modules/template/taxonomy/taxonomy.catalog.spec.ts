import { TemplateCategoryKind } from '@legaltech/database';
import {
  flattenTaxonomy,
  taxonomyLeafPaths,
  TEMPLATE_TAXONOMY,
  type TaxonomyRoot,
} from './taxonomy.catalog';

describe('template taxonomy', () => {
  const flat = flattenTaxonomy();

  describe('shape of the shipped catalogue', () => {
    it('declares exactly the three top-level branches', () => {
      expect(TEMPLATE_TAXONOMY.map((root) => root.kind)).toEqual([
        TemplateCategoryKind.CONTRACT,
        TemplateCategoryKind.HR_ORDER,
        TemplateCategoryKind.CORPORATE_ACT,
      ]);
    });

    it('gives every node a unique path', () => {
      const paths = flat.map((node) => node.path);
      expect(new Set(paths).size).toBe(paths.length);
    });

    it('emits parents before their children, so parentId always resolves', () => {
      const seen = new Set<string>();
      for (const node of flat) {
        if (node.parentPath !== null) {
          expect(seen.has(node.parentPath)).toBe(true);
        }
        seen.add(node.path);
      }
    });

    it('propagates the root kind down every branch', () => {
      const contracts = flat.filter((node) => node.path.startsWith('/contracts/'));
      expect(contracts.length).toBeGreaterThan(0);
      expect(
        contracts.every((node) => node.kind === TemplateCategoryKind.CONTRACT),
      ).toBe(true);
    });

    it('nests exactly three levels: root, group, leaf', () => {
      expect(Math.max(...flat.map((node) => node.depth))).toBe(2);
    });

    it('files every template-bearing leaf at the deepest level', () => {
      const leaves = flat.filter((node) => node.isLeaf);
      expect(leaves.every((leaf) => leaf.depth === 2)).toBe(true);
    });

    /**
     * The catalogue is sized to classify a library of several thousand
     * templates. This asserts the classification scheme is broad enough for
     * that, not that the templates themselves exist — those are rows in
     * `document_templates`, imported per tenant.
     */
    it('provides enough leaves to file 3000+ templates at a workable density', () => {
      const leafCount = taxonomyLeafPaths().length;
      expect(leafCount).toBeGreaterThanOrEqual(200);
      // Under ~20 templates per leaf, browsing stays usable.
      expect(leafCount * 20).toBeGreaterThanOrEqual(3000);
    });
  });

  describe('path construction', () => {
    it('wraps paths in slashes so a prefix match cannot span siblings', () => {
      const lease = flat.find((node) => node.slug === 'lease');
      expect(lease?.path).toBe('/contracts/lease/');
      // The trailing slash is what stops this matching.
      expect('/contracts/lease-financing/'.startsWith('/contracts/lease/')).toBe(
        false,
      );
    });

    it('records the parent path of a leaf', () => {
      const sublease = flat.find((node) => node.slug === 'sublease');
      expect(sublease?.parentPath).toBe('/contracts/lease/');
      expect(sublease?.depth).toBe(2);
    });

    it('leaves roots without a parent', () => {
      const roots = flat.filter((node) => node.depth === 0);
      expect(roots).toHaveLength(3);
      expect(roots.every((root) => root.parentPath === null)).toBe(true);
    });

    it('numbers siblings by their declared order', () => {
      const groups = flat.filter(
        (node) => node.depth === 1 && node.path.startsWith('/hr-orders/'),
      );
      expect(groups.map((group) => group.sortOrder)).toEqual(
        groups.map((_, index) => index),
      );
    });
  });

  describe('rejects a malformed catalogue', () => {
    it('throws on a slug that is not kebab-case', () => {
      const bad: TaxonomyRoot[] = [
        {
          kind: TemplateCategoryKind.CONTRACT,
          slug: 'Contracts_Root',
          name: 'Bad',
        },
      ];
      expect(() => flattenTaxonomy(bad)).toThrow(/must be lowercase/);
    });

    it('throws on two siblings sharing a slug', () => {
      const bad: TaxonomyRoot[] = [
        {
          kind: TemplateCategoryKind.CONTRACT,
          slug: 'contracts',
          name: 'Contracts',
          children: [
            { slug: 'lease', name: 'Lease' },
            { slug: 'lease', name: 'Lease again' },
          ],
        },
      ];
      expect(() => flattenTaxonomy(bad)).toThrow(/Duplicate taxonomy path/);
    });
  });
});
