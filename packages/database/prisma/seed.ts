/**
 * Development seed.
 *
 * Creates enough for someone to sign in and exercise the product immediately:
 * a company with realistic Uzbek registry details, three users covering the roles
 * that behave differently, an active subscription, and the platform taxonomy.
 *
 *     npm run db:seed
 *
 * Idempotent — every write is an upsert keyed on a natural identifier, so
 * running it repeatedly converges rather than duplicating or failing.
 *
 * REFUSES TO RUN AGAINST PRODUCTION. It writes known-password accounts, which is
 * exactly what a seed is for and exactly what must never reach a real
 * deployment.
 */
import { randomBytes } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import {
  CompanyMemberRole,
  PrismaClient,
  SubscriptionPlan,
  SubscriptionStatus,
  TemplateCategoryKind,
  TemplateStatus,
  UserRole,
} from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Password for every seeded account.
 *
 * Deliberately obvious. A seed that generates random passwords and prints them
 * is a seed nobody can use twice, and one that quietly reuses a plausible-looking
 * password is one that eventually gets tried in production.
 */
const DEMO_PASSWORD = 'DemoPassw0rd!';

/** bcrypt cost, matching AuthService. */
const BCRYPT_ROUNDS = 12;

async function main() {
  assertNotProduction();

  console.log('Seeding development data…\n');

  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, BCRYPT_ROUNDS);

  // --- Company -------------------------------------------------------------
  const company = await prisma.company.upsert({
    where: { slug: 'acme-legal' },
    update: {},
    create: {
      name: 'Acme Legal',
      slug: 'acme-legal',
      legalName: 'ACME LEGAL MCHJ',
      // Format-valid placeholders: 9-digit STIR, 5-digit OKED and MFO, 20-digit
      // account. The validators in company/validators reject anything else, so
      // wrong-shaped values here would make the seeded company unsaveable
      // through the API afterwards.
      stir: '301234567',
      oked: '69101',
      mfo: '00440',
      bankAccount: '20208000900001234567',
      bankName: 'Ipoteka Bank',
      legalAddress: "Toshkent sh., Yunusobod t., Amir Temur ko'chasi 12",
      phone: '+998712001020',
      email: 'info@acme-legal.uz',
      directorName: 'Aziz Karimov',
      directorPosition: 'Bosh direktor',
      accountantName: 'Nodira Yusupova',
    },
  });
  console.log(`  company        ${company.name} (${company.id})`);

  // --- Users ---------------------------------------------------------------
  const owner = await prisma.user.upsert({
    where: { email: 'owner@acme-legal.uz' },
    update: {},
    create: {
      email: 'owner@acme-legal.uz',
      name: 'Aziz Karimov',
      passwordHash,
      role: UserRole.USER,
      emailVerified: new Date(),
    },
  });

  const attorney = await prisma.user.upsert({
    where: { email: 'attorney@acme-legal.uz' },
    update: {},
    create: {
      email: 'attorney@acme-legal.uz',
      name: 'Dilnoza Rahimova',
      passwordHash,
      role: UserRole.USER,
      emailVerified: new Date(),
    },
  });

  // Needed to reach /admin at all — every route there requires SUPER_ADMIN.
  const admin = await prisma.user.upsert({
    where: { email: 'admin@legaltech.uz' },
    update: {},
    create: {
      email: 'admin@legaltech.uz',
      name: 'Platform Administrator',
      passwordHash,
      role: UserRole.SUPER_ADMIN,
      emailVerified: new Date(),
    },
  });

  // Two members, because the approval chain requires an approver who is not the
  // submitter — a single-user company cannot complete a document.
  for (const [user, role] of [
    [owner, CompanyMemberRole.OWNER],
    [attorney, CompanyMemberRole.ATTORNEY],
  ] as const) {
    await prisma.companyMember.upsert({
      where: { companyId_userId: { companyId: company.id, userId: user.id } },
      update: { role },
      create: { companyId: company.id, userId: user.id, role, joinedAt: new Date() },
    });
  }
  console.log(`  users          owner, attorney, super-admin`);

  // --- Subscription --------------------------------------------------------
  const now = new Date();
  const periodEnd = new Date(now);
  periodEnd.setMonth(periodEnd.getMonth() + 1);

  // BUSINESS rather than FREE: the Free plan caps AI generations at 5, which is
  // enough to hit a quota wall while still exploring the product.
  await prisma.subscription.upsert({
    where: { companyId: company.id },
    update: {},
    create: {
      companyId: company.id,
      plan: SubscriptionPlan.BUSINESS,
      status: SubscriptionStatus.ACTIVE,
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
    },
  });
  console.log(`  subscription   BUSINESS, active until ${periodEnd.toISOString().slice(0, 10)}`);

  // --- Taxonomy ------------------------------------------------------------
  // A representative slice, not the full 288-leaf catalogue — the API exposes
  // POST /taxonomy/seed for that, and it needs a SUPER_ADMIN token. This is
  // enough to create a template against.
  const taxonomy = await seedTaxonomySlice();
  console.log(`  taxonomy       ${taxonomy.length} categories`);

  // --- Template ------------------------------------------------------------
  const leaf = taxonomy.find((category) => category.slug === 'supply-of-goods');
  if (leaf) await seedTemplate(company.id, owner.id, leaf.id);

  // --- Notification preferences --------------------------------------------
  // Without a row the defaults apply (in-app + email), which is correct — this
  // exists so the preferences screen has something to render.
  await prisma.notificationPreference.upsert({
    where: { userId: owner.id },
    update: {},
    create: {
      userId: owner.id,
      enabledChannels: ['EMAIL'],
      timezone: 'Asia/Tashkent',
    },
  });

  // --- Coupon --------------------------------------------------------------
  await prisma.coupon.upsert({
    where: { code: 'WELCOME20' },
    update: {},
    create: {
      code: 'WELCOME20',
      description: '20% off the first month',
      discountType: 'PERCENTAGE',
      percentOff: 20,
      duration: 'ONCE',
      firstTimeOnly: true,
      active: true,
    },
  });
  console.log(`  coupon         WELCOME20`);

  console.log(`
Done.

  Sign in at http://localhost:3000

    Owner        owner@acme-legal.uz      ${DEMO_PASSWORD}
    Attorney     attorney@acme-legal.uz   ${DEMO_PASSWORD}
    Super admin  admin@legaltech.uz       ${DEMO_PASSWORD}   -> /admin

  The attorney exists so approvals can be completed: a document cannot be
  approved by the person who submitted it.
`);
}

/**
 * Refuses to seed a production database.
 *
 * Checks both NODE_ENV and the connection string, because NODE_ENV is trivially
 * unset when someone runs this against a production URL from their laptop —
 * which is the exact scenario worth guarding.
 */
function assertNotProduction(): void {
  const url = process.env.DATABASE_URL ?? '';

  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed: NODE_ENV is production');
  }

  const looksRemote =
    url && !/@(localhost|127\.0\.0\.1|postgres|host\.docker\.internal)[:/]/.test(url);

  if (looksRemote && process.env.ALLOW_REMOTE_SEED !== 'true') {
    throw new Error(
      'Refusing to seed: DATABASE_URL does not point at localhost. ' +
        'Set ALLOW_REMOTE_SEED=true if this is genuinely intended.',
    );
  }
}

/** Three roots plus one usable branch, with correct materialized paths. */
async function seedTaxonomySlice() {
  const nodes: {
    slug: string;
    name: string;
    kind: TemplateCategoryKind;
    path: string;
    parentPath: string | null;
    depth: number;
    sortOrder: number;
  }[] = [
    { slug: 'contracts', name: 'Contracts', kind: TemplateCategoryKind.CONTRACT, path: '/contracts/', parentPath: null, depth: 0, sortOrder: 0 },
    { slug: 'hr-orders', name: 'HR orders', kind: TemplateCategoryKind.HR_ORDER, path: '/hr-orders/', parentPath: null, depth: 0, sortOrder: 1 },
    { slug: 'corporate-acts', name: 'Corporate acts', kind: TemplateCategoryKind.CORPORATE_ACT, path: '/corporate-acts/', parentPath: null, depth: 0, sortOrder: 2 },
    { slug: 'sale-purchase', name: 'Sale and purchase', kind: TemplateCategoryKind.CONTRACT, path: '/contracts/sale-purchase/', parentPath: '/contracts/', depth: 1, sortOrder: 0 },
    { slug: 'supply-of-goods', name: 'Supply of goods', kind: TemplateCategoryKind.CONTRACT, path: '/contracts/sale-purchase/supply-of-goods/', parentPath: '/contracts/sale-purchase/', depth: 2, sortOrder: 0 },
    { slug: 'hiring', name: 'Hiring', kind: TemplateCategoryKind.HR_ORDER, path: '/hr-orders/hiring/', parentPath: '/hr-orders/', depth: 1, sortOrder: 0 },
    { slug: 'employment-order', name: 'Order on hiring', kind: TemplateCategoryKind.HR_ORDER, path: '/hr-orders/hiring/employment-order/', parentPath: '/hr-orders/hiring/', depth: 2, sortOrder: 0 },
  ];

  const idByPath = new Map<string, string>();
  const created: { id: string; slug: string }[] = [];

  // Depth order matters: a child needs its parent's generated id.
  for (const node of nodes.sort((a, b) => a.depth - b.depth)) {
    const existing = await prisma.templateCategory.findFirst({
      where: { companyId: null, path: node.path },
      select: { id: true },
    });

    const id =
      existing?.id ??
      (
        await prisma.templateCategory.create({
          data: {
            companyId: null,
            parentId: node.parentPath ? idByPath.get(node.parentPath) : null,
            kind: node.kind,
            slug: node.slug,
            name: node.name,
            path: node.path,
            depth: node.depth,
            sortOrder: node.sortOrder,
          },
          select: { id: true },
        })
      ).id;

    idByPath.set(node.path, id);
    created.push({ id, slug: node.slug });
  }

  return created;
}

/** A published template with a real variable schema and approval chain. */
async function seedTemplate(companyId: string, userId: string, categoryId: string) {
  const existing = await prisma.documentTemplate.findFirst({
    where: { companyId, slug: 'supply-agreement' },
    select: { id: true },
  });
  if (existing) return;

  /**
   * Every placeholder below is declared in `variableSchema`, and every declared
   * variable appears here.
   *
   * The two must agree in both directions. A placeholder the schema omits can
   * never be filled — validation rejects values for undeclared keys — so it
   * renders as a blank line in every document generated from this template. A
   * declared variable that appears nowhere in the body asks the user for
   * information that then goes unused.
   */
  const content = {
    type: 'doc',
    content: [
      {
        type: 'heading',
        attrs: { level: 1 },
        content: [{ type: 'text', text: 'ТОВАР ЕТКАЗИБ БЕРИШ ШАРТНОМАСИ' }],
      },
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: '№ {{contract_number}} от {{signed_at}}',
          },
        ],
      },
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: 'Настоящий договор заключён между {{company_legal_name}} (далее — Поставщик) и {{counterparty_name}} (далее — Покупатель).',
          },
        ],
      },
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: 'Общая сумма договора составляет {{amount}}. Оплата производится в течение {{payment_days}} банковских дней с момента поставки.',
          },
        ],
      },
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: 'Реквизиты Поставщика: ИНН {{company_stir}}, адрес: {{company_legal_address}}.',
          },
        ],
      },
    ],
  };

  /**
   * `company_*` keys are filled from the company profile automatically — see
   * DocumentCreationService — so they are declared but optional. The rest are
   * asked of whoever generates the document.
   */
  const variableSchema = {
    version: 1,
    variables: [
      { key: 'counterparty_name', label: 'Контрагент', type: 'string', required: true, maxLength: 200 },
      { key: 'contract_number', label: 'Номер договора', type: 'string', required: true, maxLength: 50 },
      { key: 'signed_at', label: 'Дата подписания', type: 'date', required: true },
      { key: 'amount', label: 'Сумма', type: 'money', currency: 'UZS', min: 0 },
      {
        key: 'payment_days',
        label: 'Срок оплаты (дней)',
        type: 'integer',
        min: 1,
        max: 180,
        defaultValue: 10,
      },
      { key: 'company_legal_name', label: 'Поставщик (из профиля)', type: 'string', maxLength: 200 },
      { key: 'company_stir', label: 'ИНН поставщика (из профиля)', type: 'string', maxLength: 20 },
      { key: 'company_legal_address', label: 'Адрес поставщика (из профиля)', type: 'string', maxLength: 300 },
    ],
  };

  const approvalChain = [
    { order: 1, role: CompanyMemberRole.ATTORNEY, label: 'Legal review' },
    { order: 2, role: CompanyMemberRole.OWNER, label: 'Authorised signatory' },
  ];

  const template = await prisma.documentTemplate.create({
    data: {
      companyId,
      categoryId,
      name: 'Товар етказиб бериш шартномаси',
      slug: 'supply-agreement',
      description: 'Namuna: tovar yetkazib berish shartnomasi',
      content,
      status: TemplateStatus.PUBLISHED,
      version: 1,
    },
    select: { id: true },
  });

  const version = await prisma.templateVersion.create({
    data: {
      templateId: template.id,
      version: 1,
      status: TemplateStatus.PUBLISHED,
      publishedAt: new Date(),
      content,
      variableSchema,
      approvalChain,
      changeNote: 'Seeded',
      createdById: userId,
    },
    select: { id: true },
  });

  await prisma.documentTemplate.update({
    where: { id: template.id },
    data: { currentVersionId: version.id },
  });

  console.log(`  template       supply-agreement (published v1)`);
}

main()
  .catch((error) => {
    console.error('\nSeed failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
