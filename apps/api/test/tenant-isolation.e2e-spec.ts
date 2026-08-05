/**
 * Cross-tenant isolation.
 *
 * This suite exists because of a real defect: `GET /documents/:id` had no tenant
 * scoping and returned any company's document by id. It passed every unit test,
 * because a unit test asserts what the code does — not what a *second tenant* can
 * reach.
 *
 * Every case here creates two companies and checks that one cannot see the
 * other's data. A regression is far more likely than it sounds: it takes one
 * `where` clause losing a `companyId` during a refactor.
 *
 * Requires:  docker compose up -d postgres-test redis
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import * as bcrypt from 'bcryptjs';
import { GeneratedDocumentStatus, UserRole } from '@legaltech/database';
import { closeDb, createTestApp, db, readCookie, server, truncateAll } from './helpers';

const PASSWORD = 'CorrectHorse1!';

interface Tenant {
  companyId: string;
  userId: string;
  cookie: string;
}

describe('Tenant isolation (e2e)', () => {
  let app: INestApplication;
  let alpha: Tenant;
  let beta: Tenant;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  beforeEach(async () => {
    await truncateAll();
    alpha = await createTenant('alpha');
    beta = await createTenant('beta');
  });

  async function createTenant(slug: string): Promise<Tenant> {
    const company = await db().company.create({
      data: { name: `${slug} legal`, slug: `${slug}-${Date.now()}` },
    });

    const email = `owner@${slug}.uz`;
    const user = await db().user.create({
      data: {
        email,
        passwordHash: await bcrypt.hash(PASSWORD, 12),
        role: UserRole.USER,
        emailVerified: new Date(),
      },
    });

    await db().companyMember.create({
      data: { companyId: company.id, userId: user.id, role: 'OWNER', joinedAt: new Date() },
    });

    const login = await request(server(app))
      .post('/api/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);

    const access = readCookie(login.headers['set-cookie'], 'access_token')!;

    return { companyId: company.id, userId: user.id, cookie: `access_token=${access}` };
  }

  async function createDocument(tenant: Tenant, title: string) {
    return db().generatedDocument.create({
      data: {
        companyId: tenant.companyId,
        createdById: tenant.userId,
        title,
        status: GeneratedDocumentStatus.DRAFT,
        content: { type: 'doc', content: [] },
      },
      select: { id: true },
    });
  }

  // ---------------------------------------------------------------------------
  // Documents — the endpoint where the leak actually was
  // ---------------------------------------------------------------------------

  describe('documents', () => {
    it('does not return another tenant’s document by id', async () => {
      const secret = await createDocument(alpha, 'Alpha confidential merger');

      // Beta knows the id — they travel in URLs, audit logs, and notification
      // payloads — and must still be refused.
      await request(server(app))
        .get(`/api/documents/${secret.id}`)
        .set('Cookie', beta.cookie)
        .expect(404);
    });

    it('returns the owner’s own document', async () => {
      const own = await createDocument(alpha, 'Alpha own document');

      const response = await request(server(app))
        .get(`/api/documents/${own.id}`)
        .set('Cookie', alpha.cookie)
        .expect(200);

      expect(response.body.title).toBe('Alpha own document');
    });

    it('lists only the caller’s documents', async () => {
      await createDocument(alpha, 'Alpha one');
      await createDocument(alpha, 'Alpha two');
      await createDocument(beta, 'Beta one');

      const response = await request(server(app))
        .get('/api/documents')
        .set('Cookie', alpha.cookie)
        .expect(200);

      const titles = response.body.map((d: { title: string }) => d.title);
      expect(titles).toHaveLength(2);
      expect(titles).not.toContain('Beta one');
    });

    it('omits the document body from the list response', async () => {
      // The list endpoint returns full editor JSON per row without a projection,
      // which turns a list request into megabytes.
      await createDocument(alpha, 'Alpha one');

      const response = await request(server(app))
        .get('/api/documents')
        .set('Cookie', alpha.cookie)
        .expect(200);

      expect(response.body[0]).not.toHaveProperty('content');
      expect(response.body[0]).toHaveProperty('title');
    });

    it('refuses to export another tenant’s document', async () => {
      const secret = await createDocument(alpha, 'Alpha confidential');

      const response = await request(server(app))
        .get(`/api/documents/${secret.id}/export/pdf`)
        .set('Cookie', beta.cookie);

      // Anything but 200 is acceptable; what matters is that no bytes come back.
      expect(response.status).not.toBe(200);
    });
  });

  // ---------------------------------------------------------------------------
  // Billing
  // ---------------------------------------------------------------------------

  describe('billing', () => {
    it('reports each tenant’s own usage', async () => {
      const response = await request(server(app))
        .get('/api/billing/usage')
        .set('Cookie', alpha.cookie)
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
    });

    it('does not expose another tenant’s payment orders', async () => {
      const order = await db().paymentOrder.create({
        data: {
          companyId: alpha.companyId,
          amountCents: 19_900,
          currency: 'usd',
          description: 'Alpha order',
        },
        select: { id: true },
      });

      await request(server(app))
        .get(`/api/payments/orders/${order.id}`)
        .set('Cookie', beta.cookie)
        .expect(404);
    });
  });

  // ---------------------------------------------------------------------------
  // Company assets — seals and signatures
  // ---------------------------------------------------------------------------

  describe('company assets', () => {
    async function createAsset(tenant: Tenant) {
      return db().companyAsset.create({
        data: {
          companyId: tenant.companyId,
          type: 'SEAL',
          storageKey: `companies/${tenant.companyId}/seal/${Date.now()}.png`,
          contentType: 'image/png',
          sizeBytes: 1024,
          checksum: 'c'.repeat(64),
          uploadedById: tenant.userId,
        },
        select: { id: true },
      });
    }

    it('does not list another tenant’s seal, regardless of the :id in the URL', async () => {
      await createAsset(alpha);

      // Beta requests through alpha's own company id in the URL — the route
      // param must be ignored in favour of the caller's session tenant.
      const response = await request(server(app))
        .get(`/api/companies/${alpha.companyId}/assets`)
        .set('Cookie', beta.cookie)
        .expect(200);

      expect(response.body).toHaveLength(0);
    });

    it('lists the caller’s own seal', async () => {
      await createAsset(alpha);

      const response = await request(server(app))
        .get(`/api/companies/${alpha.companyId}/assets`)
        .set('Cookie', alpha.cookie)
        .expect(200);

      expect(response.body).toHaveLength(1);
    });

    it('refuses to delete another tenant’s seal via a foreign :id', async () => {
      const asset = await createAsset(alpha);

      await request(server(app))
        .delete(`/api/companies/${alpha.companyId}/assets/${asset.id}`)
        .set('Cookie', beta.cookie)
        .expect(404);

      const stillThere = await db().companyAsset.findUnique({ where: { id: asset.id } });
      expect(stillThere?.deletedAt).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Admin
  // ---------------------------------------------------------------------------

  describe('admin routes', () => {
    it('refuses an ordinary user', async () => {
      // Class-level @Roles('SUPER_ADMIN'). A tenant owner is not a platform
      // administrator, however senior they are inside their own company.
      await request(server(app))
        .get('/api/admin/dashboard')
        .set('Cookie', alpha.cookie)
        .expect(403);
    });

    it('refuses an unauthenticated caller', async () => {
      await request(server(app)).get('/api/admin/dashboard').expect(401);
    });
  });

  // ---------------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------------

  describe('search', () => {
    it('does not return another tenant’s indexed content', async () => {
      const scan = await db().scannedDocument.create({
        data: {
          companyId: alpha.companyId,
          storageKey: `companies/${alpha.companyId}/scans/secret.pdf`,
          originalName: 'secret.pdf',
          contentType: 'application/pdf',
          sizeBytes: 1024,
          checksum: 'a'.repeat(64),
          status: 'COMPLETED',
          languages: ['rus'],
          extractedText: 'СЕКРЕТНОЕ СОГЛАШЕНИЕ О СЛИЯНИИ',
        },
        select: { id: true },
      });

      await db().documentChunk.create({
        data: {
          companyId: alpha.companyId,
          scannedDocumentId: scan.id,
          chunkIndex: 0,
          content: 'СЕКРЕТНОЕ СОГЛАШЕНИЕ О СЛИЯНИИ',
          tokenCount: 10,
        },
      });

      const response = await request(server(app))
        .get('/api/search')
        .query({ q: 'СЕКРЕТНОЕ', mode: 'lexical' })
        .set('Cookie', beta.cookie)
        .expect(200);

      expect(response.body.hits).toHaveLength(0);
    });

    it('finds the tenant’s own content', async () => {
      // Also the first real exercise of the generated tsvector column and its
      // GIN index — neither has ever run outside a migration file.
      const scan = await db().scannedDocument.create({
        data: {
          companyId: alpha.companyId,
          storageKey: `companies/${alpha.companyId}/scans/own.pdf`,
          originalName: 'own.pdf',
          contentType: 'application/pdf',
          sizeBytes: 1024,
          checksum: 'b'.repeat(64),
          status: 'COMPLETED',
          languages: ['rus'],
          extractedText: 'ДОГОВОР ПОСТАВКИ ТОВАРА',
        },
        select: { id: true },
      });

      await db().documentChunk.create({
        data: {
          companyId: alpha.companyId,
          scannedDocumentId: scan.id,
          chunkIndex: 0,
          content: 'ДОГОВОР ПОСТАВКИ ТОВАРА',
          tokenCount: 10,
        },
      });

      const response = await request(server(app))
        .get('/api/search')
        .query({ q: 'ДОГОВОР', mode: 'lexical' })
        .set('Cookie', alpha.cookie)
        .expect(200);

      expect(response.body.hits.length).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Health — unauthenticated by design
  // ---------------------------------------------------------------------------

  describe('health and metrics', () => {
    it('serves liveness without credentials', async () => {
      await request(server(app)).get('/health/live').expect(200);
    });

    it('serves readiness, exercising the real Postgres and Redis checks', async () => {
      const response = await request(server(app)).get('/health/ready').expect(200);

      expect(response.body.details.postgres.status).toBe('up');
      expect(response.body.details.redis.status).toBe('up');
    });

    it('serves Prometheus metrics', async () => {
      const response = await request(server(app)).get('/metrics').expect(200);
      expect(response.text).toContain('http_requests_total');
    });
  });
});
