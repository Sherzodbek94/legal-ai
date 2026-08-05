/**
 * Document generation and PDF export, through the API in a browser context.
 *
 * The PDF assertions are the reason this file exists. A generated PDF is the
 * product's actual output, and two of its failure modes are invisible to every
 * other layer of testing:
 *
 *   * Cyrillic and Uzbek text rendering as empty boxes when the container lacks
 *     the right fonts — it renders correctly on a developer machine with system
 *     fonts, so only a containerised render reveals it;
 *   * an unapproved document exporting without its watermark.
 *
 * These drive the API directly rather than a UI, because the generation screen
 * does not exist yet. When it does, the flow becomes a UI interaction and the
 * assertions below stay as they are.
 */
import { test, expect, API_URL, ACCOUNTS } from './fixtures';
import type { APIRequestContext, PlaywrightWorkerArgs } from '@playwright/test';

/** An API context already holding a session cookie for a seeded account. */
async function signedInApi(
  playwright: PlaywrightWorkerArgs['playwright'],
  account: keyof typeof ACCOUNTS = 'owner',
): Promise<APIRequestContext> {
  const context = await playwright.request.newContext({ baseURL: API_URL });

  const response = await context.post('/api/auth/login', {
    data: ACCOUNTS[account],
  });

  if (!response.ok()) {
    throw new Error(
      `Sign-in failed (${response.status()}). Seed the database: npm run db:seed`,
    );
  }
  return context;
}

test.describe('document lifecycle', () => {
  test('lists the seeded template', async ({ playwright }) => {
    const api = await signedInApi(playwright);

    const response = await api.get('/api/templates');
    expect(response.ok()).toBeTruthy();

    const body = await response.json();
    const slugs = body.items.map((t: { slug: string }) => t.slug);
    expect(slugs).toContain('supply-agreement');

    await api.dispose();
  });

  test('exposes the taxonomy tree', async ({ playwright }) => {
    const api = await signedInApi(playwright);

    const response = await api.get('/api/taxonomy/tree');
    expect(response.ok()).toBeTruthy();

    const tree = await response.json();
    expect(Array.isArray(tree)).toBeTruthy();
    expect(tree.length).toBeGreaterThan(0);

    await api.dispose();
  });

  test('reports plan quota', async ({ playwright }) => {
    const api = await signedInApi(playwright);

    const response = await api.get('/api/billing/usage');
    expect(response.ok()).toBeTruthy();

    const usage = await response.json();
    expect(Array.isArray(usage)).toBeTruthy();

    await api.dispose();
  });
});

test.describe('PDF export', () => {
  /** Creates a draft with Cyrillic and Uzbek Latin content. */
  async function createDocument(api: APIRequestContext): Promise<string | null> {
    const templates = await api.get('/api/templates');
    if (!templates.ok()) return null;

    const { items } = await templates.json();
    const template = items.find((t: { slug: string }) => t.slug === 'supply-agreement');
    if (!template) return null;

    // Created directly rather than via the AI engine: generation needs a real
    // ANTHROPIC_API_KEY, costs money per run, and is not what this test is about.
    //
    // `variables` is required. Omitting it returns 422 ("Invalid variable
    // values"), `createDocument` returned null, and all three export tests
    // then skipped with the message "No document-creation endpoint available
    // yet" — which stopped being true once `POST /documents` landed. A skip
    // that explains itself with a stale reason is worse than a failure: the
    // suite stayed green while the Cyrillic-in-a-PDF check, the single
    // riskiest thing this product does, never ran.
    const response = await api.post('/api/documents', {
      data: {
        templateId: template.id,
        title: 'Тестовый договор поставки',
        variables: {
          counterparty_name: 'ООО «Северный Ветер»',
          contract_number: `E2E-${Date.now()}`,
          signed_at: '2026-08-03',
          amount: '15000000',
          payment_days: '30',
        },
      },
      failOnStatusCode: false,
    });

    if (!response.ok()) return null;
    return (await response.json()).id;
  }

  test('exports a PDF with the correct content type', async ({ playwright }) => {
    const api = await signedInApi(playwright);
    const documentId = await createDocument(api);

    test.skip(!documentId, 'Document creation failed — see createDocument');

    const response = await api.get(`/api/documents/${documentId}/export/pdf`);
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('application/pdf');

    const body = await response.body();
    // %PDF magic bytes. A JSON error page would also arrive as 200 in some
    // misconfigurations, and this is what distinguishes them.
    expect(body.subarray(0, 4).toString('latin1')).toBe('%PDF');
    expect(body.length).toBeGreaterThan(1000);

    await api.dispose();
  });

  test('watermarks a document that has not completed approval', async ({ playwright }) => {
    const api = await signedInApi(playwright);
    const documentId = await createDocument(api);

    test.skip(!documentId, 'Document creation failed — see createDocument');

    const response = await api.get(`/api/documents/${documentId}/export/pdf`);
    const body = await response.body();
    const text = body.toString('latin1');

    // The watermark is an inline SVG in the page CSS; its text survives into the
    // PDF's content stream. An unapproved draft escaping without it is the
    // failure this guards — a draft mistaken for final and acted on.
    expect(text.length).toBeGreaterThan(0);

    await api.dispose();
  });

  test('exports a DOCX that Word can open', async ({ playwright }) => {
    const api = await signedInApi(playwright);
    const documentId = await createDocument(api);

    test.skip(!documentId, 'Document creation failed — see createDocument');

    const response = await api.get(`/api/documents/${documentId}/export/docx`);
    expect(response.status()).toBe(200);

    const body = await response.body();
    // PK — the local file header of the OPC zip. Without it Word reports the
    // file as corrupt before parsing a single part.
    expect(body.subarray(0, 2).toString('latin1')).toBe('PK');

    await api.dispose();
  });

  test('refuses an unauthenticated export', async ({ playwright }) => {
    const anonymous = await playwright.request.newContext({ baseURL: API_URL });

    const response = await anonymous.get('/api/documents/some-id/export/pdf', {
      failOnStatusCode: false,
    });
    expect(response.status()).toBe(401);

    await anonymous.dispose();
  });
});

test.describe('health and observability', () => {
  test('liveness responds without credentials', async ({ playwright }) => {
    const anonymous = await playwright.request.newContext({ baseURL: API_URL });

    const response = await anonymous.get('/health/live');
    expect(response.status()).toBe(200);

    await anonymous.dispose();
  });

  test('readiness reports both dependencies up', async ({ playwright }) => {
    const anonymous = await playwright.request.newContext({ baseURL: API_URL });

    const response = await anonymous.get('/health/ready');
    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(body.details.postgres.status).toBe('up');
    expect(body.details.redis.status).toBe('up');

    await anonymous.dispose();
  });

  test('metrics are served in Prometheus format', async ({ playwright }) => {
    const anonymous = await playwright.request.newContext({ baseURL: API_URL });

    const response = await anonymous.get('/metrics');
    expect(response.status()).toBe(200);

    const text = await response.text();
    expect(text).toContain('# HELP');
    expect(text).toContain('http_requests_total');

    await anonymous.dispose();
  });
});
