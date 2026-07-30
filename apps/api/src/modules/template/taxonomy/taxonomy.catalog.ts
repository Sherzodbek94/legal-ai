/**
 * The platform-wide template taxonomy.
 *
 * This file defines the *classification scheme* — not the templates. The
 * catalogue is expected to hold several thousand template documents; they are
 * rows in `document_templates` hanging off the leaves declared here, imported
 * per tenant rather than hardcoded. Keeping the two separate is what lets the
 * legal team add templates without a deploy, while the shape of the tree stays
 * reviewable in version control.
 *
 * Three roots, following how Uzbek legal practice actually files paperwork:
 *   * CONTRACT       — civil-law agreements between parties.
 *   * HR_ORDER       — internal personnel orders (buyruq / приказ).
 *   * CORPORATE_ACT  — constitutive and governance instruments.
 *
 * Localisation: `nameRu` is populated for roots and groups, which is what the
 * navigation tree renders. Leaf labels are resolved from the translation
 * catalogue at render time rather than duplicated here, so a wording fix does
 * not require a migration.
 */
import { TemplateCategoryKind } from '@legaltech/database';

export interface TaxonomyNode {
  /** Unique among siblings; forms one segment of the materialized path. */
  slug: string;
  name: string;
  nameRu?: string;
  nameUz?: string;
  description?: string;
  children?: TaxonomyNode[];
}

export interface TaxonomyRoot extends TaxonomyNode {
  kind: TemplateCategoryKind;
}

/** Shorthand for a leaf, which is the overwhelming majority of the tree. */
const leaf = (slug: string, name: string): TaxonomyNode => ({ slug, name });

export const TEMPLATE_TAXONOMY: TaxonomyRoot[] = [
  // -------------------------------------------------------------------------
  // Contracts
  // -------------------------------------------------------------------------
  {
    kind: TemplateCategoryKind.CONTRACT,
    slug: 'contracts',
    name: 'Contracts',
    nameRu: 'Договоры',
    nameUz: 'Shartnomalar',
    description: 'Civil-law agreements concluded between two or more parties.',
    children: [
      {
        slug: 'sale-purchase',
        name: 'Sale and purchase',
        nameRu: 'Купля-продажа',
        children: [
          leaf('goods-sale', 'Sale of goods'),
          leaf('supply-of-goods', 'Supply of goods'),
          leaf('retail-sale', 'Retail sale'),
          leaf('real-estate-sale', 'Sale of real estate'),
          leaf('vehicle-sale', 'Sale of a vehicle'),
          leaf('equipment-sale', 'Sale of equipment'),
          leaf('business-sale', 'Sale of an enterprise as a going concern'),
          leaf('energy-supply', 'Energy and utilities supply'),
          leaf('state-procurement-supply', 'Supply under state procurement'),
          leaf('barter', 'Barter and exchange'),
          leaf('instalment-sale', 'Sale by instalments'),
          leaf('preliminary-sale', 'Preliminary sale agreement'),
        ],
      },
      {
        slug: 'lease',
        name: 'Lease and use',
        nameRu: 'Аренда и пользование',
        children: [
          leaf('premises-lease', 'Lease of non-residential premises'),
          leaf('residential-lease', 'Lease of residential premises'),
          leaf('land-lease', 'Lease of a land plot'),
          leaf('equipment-lease', 'Lease of equipment'),
          leaf('vehicle-lease', 'Lease of a vehicle'),
          leaf('vehicle-lease-with-crew', 'Lease of a vehicle with crew'),
          leaf('financial-lease', 'Financial lease (leasing)'),
          leaf('sublease', 'Sublease'),
          leaf('gratuitous-use', 'Gratuitous use (loan for use)'),
          leaf('coworking', 'Workplace and coworking use'),
        ],
      },
      {
        slug: 'services',
        name: 'Services',
        nameRu: 'Оказание услуг',
        children: [
          leaf('consulting', 'Consulting services'),
          leaf('legal-services', 'Legal services'),
          leaf('audit', 'Audit services'),
          leaf('accounting', 'Accounting and bookkeeping services'),
          leaf('marketing', 'Marketing and advertising services'),
          leaf('it-services', 'IT services'),
          leaf('software-development', 'Software development services'),
          leaf('education', 'Educational services'),
          leaf('medical', 'Medical services'),
          leaf('security', 'Security services'),
          leaf('cleaning', 'Cleaning and maintenance services'),
          leaf('outstaffing', 'Outstaffing and personnel provision'),
          leaf('translation', 'Translation services'),
          leaf('recruitment', 'Recruitment services'),
        ],
      },
      {
        slug: 'works',
        name: 'Works and construction',
        nameRu: 'Подряд и строительство',
        children: [
          leaf('general-contracting', 'General construction contracting'),
          leaf('subcontracting', 'Construction subcontracting'),
          leaf('design-survey', 'Design and survey works'),
          leaf('repair-works', 'Repair and finishing works'),
          leaf('installation', 'Installation and commissioning'),
          leaf('turnkey', 'Turnkey construction'),
          leaf('rd-works', 'Research and development works'),
          leaf('household-works', 'Household works'),
          leaf('technical-supervision', 'Technical supervision'),
        ],
      },
      {
        slug: 'transport',
        name: 'Transport and logistics',
        nameRu: 'Перевозка и логистика',
        children: [
          leaf('cargo-carriage', 'Carriage of goods'),
          leaf('passenger-carriage', 'Carriage of passengers'),
          leaf('freight-forwarding', 'Freight forwarding'),
          leaf('chartering', 'Chartering'),
          leaf('international-carriage', 'International carriage (CMR)'),
          leaf('warehousing', 'Warehousing and storage'),
          leaf('customs-brokerage', 'Customs brokerage'),
        ],
      },
      {
        slug: 'finance',
        name: 'Finance and security',
        nameRu: 'Финансы и обеспечение',
        children: [
          leaf('loan', 'Interest-bearing loan'),
          leaf('interest-free-loan', 'Interest-free loan'),
          leaf('credit-line', 'Credit line'),
          leaf('pledge', 'Pledge'),
          leaf('real-estate-mortgage', 'Mortgage of real estate'),
          leaf('surety', 'Surety'),
          leaf('bank-guarantee', 'Bank guarantee'),
          leaf('factoring', 'Factoring'),
          leaf('assignment-of-claim', 'Assignment of claim (cession)'),
          leaf('debt-transfer', 'Transfer of debt'),
          leaf('settlement-netting', 'Netting of mutual claims'),
          leaf('debt-restructuring', 'Debt restructuring'),
          leaf('bank-account', 'Bank account'),
        ],
      },
      {
        slug: 'intermediary',
        name: 'Intermediary and distribution',
        nameRu: 'Посреднические и дистрибуция',
        children: [
          leaf('agency', 'Agency'),
          leaf('commission', 'Commission'),
          leaf('brokerage', 'Brokerage'),
          leaf('distribution', 'Distribution'),
          leaf('dealership', 'Dealership'),
          leaf('franchising', 'Franchising (commercial concession)'),
          leaf('trust-management', 'Trust management of property'),
        ],
      },
      {
        slug: 'intellectual-property',
        name: 'Intellectual property',
        nameRu: 'Интеллектуальная собственность',
        children: [
          leaf('trademark-license', 'Trademark licence'),
          leaf('trademark-assignment', 'Trademark assignment'),
          leaf('patent-license', 'Patent licence'),
          leaf('patent-assignment', 'Patent assignment'),
          leaf('copyright-assignment', 'Assignment of copyright'),
          leaf('software-license', 'Software licence'),
          leaf('saas-subscription', 'SaaS subscription'),
          leaf('know-how', 'Know-how transfer'),
          leaf('publishing', 'Publishing agreement'),
          leaf('commissioned-work', 'Author commission (work for hire)'),
          leaf('domain-transfer', 'Domain name transfer'),
        ],
      },
      {
        slug: 'cooperation',
        name: 'Cooperation and investment',
        nameRu: 'Сотрудничество и инвестиции',
        children: [
          leaf('joint-activity', 'Joint activity (simple partnership)'),
          leaf('investment', 'Investment agreement'),
          leaf('shareholders-agreement', 'Shareholders agreement'),
          leaf('convertible-loan', 'Convertible loan'),
          leaf('memorandum-of-understanding', 'Memorandum of understanding'),
          leaf('letter-of-intent', 'Letter of intent'),
          leaf('cooperation-framework', 'Framework cooperation agreement'),
        ],
      },
      {
        slug: 'confidentiality',
        name: 'Confidentiality and data',
        nameRu: 'Конфиденциальность и данные',
        children: [
          leaf('nda-mutual', 'Mutual non-disclosure agreement'),
          leaf('nda-unilateral', 'Unilateral non-disclosure agreement'),
          leaf('non-compete', 'Non-competition undertaking'),
          leaf('non-solicitation', 'Non-solicitation undertaking'),
          leaf('data-processing', 'Personal data processing agreement'),
          leaf('trade-secret-undertaking', 'Trade secret undertaking'),
        ],
      },
      {
        slug: 'foreign-trade',
        name: 'Foreign trade',
        nameRu: 'Внешнеэкономическая деятельность',
        children: [
          leaf('export-contract', 'Export contract'),
          leaf('import-contract', 'Import contract'),
          leaf('tolling', 'Tolling (processing of supplied raw materials)'),
          leaf('international-services', 'Cross-border services'),
          leaf('foreign-agency', 'Foreign agency and representation'),
          leaf('incoterms-annex', 'Incoterms delivery annex'),
        ],
      },
      {
        slug: 'insurance',
        name: 'Insurance',
        nameRu: 'Страхование',
        children: [
          leaf('property-insurance', 'Property insurance'),
          leaf('liability-insurance', 'Civil liability insurance'),
          leaf('cargo-insurance', 'Cargo insurance'),
          leaf('professional-liability-insurance', 'Professional liability insurance'),
          leaf('personal-insurance', 'Personal insurance'),
        ],
      },
      {
        slug: 'individuals',
        name: 'Contracts with individuals',
        nameRu: 'Договоры с физическими лицами',
        children: [
          leaf('civil-law-services', 'Civil-law services with an individual'),
          leaf('author-order', 'Author order with an individual'),
          leaf('self-employed-services', 'Services of a self-employed person'),
          leaf('individual-lease', 'Lease from an individual'),
        ],
      },
      {
        slug: 'ancillary',
        name: 'Ancillary instruments',
        nameRu: 'Сопутствующие документы',
        description:
          'Attach to a parent contract rather than standing on their own.',
        children: [
          leaf('supplementary-agreement', 'Supplementary agreement'),
          leaf('specification', 'Specification'),
          leaf('annex', 'Annex'),
          leaf('protocol-of-disagreements', 'Protocol of disagreements'),
          leaf('protocol-of-reconciliation', 'Protocol of reconciliation'),
          leaf('acceptance-act', 'Act of acceptance'),
          leaf('reconciliation-act', 'Act of reconciliation of settlements'),
          leaf('termination-agreement', 'Termination agreement'),
          leaf('unilateral-termination-notice', 'Unilateral termination notice'),
          leaf('claim-letter', 'Pre-action claim letter'),
          leaf('penalty-calculation', 'Penalty calculation'),
        ],
      },
    ],
  },

  // -------------------------------------------------------------------------
  // HR orders
  // -------------------------------------------------------------------------
  {
    kind: TemplateCategoryKind.HR_ORDER,
    slug: 'hr-orders',
    name: 'HR orders',
    nameRu: 'Кадровые приказы',
    nameUz: 'Kadrlar buyruqlari',
    description:
      'Internal personnel orders issued by the employer under the Labour Code.',
    children: [
      {
        slug: 'hiring',
        name: 'Hiring',
        nameRu: 'Приём на работу',
        children: [
          leaf('employment-order', 'Order on hiring'),
          leaf('probation-period', 'Order on a probation period'),
          leaf('fixed-term-hiring', 'Order on fixed-term employment'),
          leaf('part-time-hiring', 'Order on part-time employment'),
          leaf('secondary-employment', 'Order on secondary employment'),
          leaf('combination-of-duties', 'Order on combination of duties'),
          leaf('remote-work', 'Order on remote work'),
          leaf('internship', 'Order on an internship'),
          leaf('foreign-employee-hiring', 'Order on hiring a foreign national'),
          leaf('probation-result', 'Order on the result of a probation period'),
        ],
      },
      {
        slug: 'transfers',
        name: 'Transfers and changes',
        nameRu: 'Переводы и изменения',
        children: [
          leaf('permanent-transfer', 'Order on a permanent transfer'),
          leaf('temporary-transfer', 'Order on a temporary transfer'),
          leaf('position-change', 'Order on a change of position'),
          leaf('department-change', 'Order on a change of department'),
          leaf('salary-change', 'Order on a change of salary'),
          leaf('schedule-change', 'Order on a change of working schedule'),
          leaf('relocation', 'Order on relocation to another locality'),
          leaf('name-change-record', 'Order on a change of employee surname'),
          leaf('contract-terms-change', 'Order on changing employment terms'),
        ],
      },
      {
        slug: 'dismissal',
        name: 'Dismissal',
        nameRu: 'Увольнение',
        children: [
          leaf('by-agreement', 'Dismissal by agreement of the parties'),
          leaf('own-request', 'Dismissal at the employee request'),
          leaf('employer-initiative', 'Dismissal at the employer initiative'),
          leaf('redundancy', 'Dismissal on redundancy'),
          leaf('term-expiry', 'Dismissal on expiry of the term'),
          leaf('disciplinary-dismissal', 'Dismissal for a disciplinary breach'),
          leaf('probation-failure', 'Dismissal for failing probation'),
          leaf('retirement', 'Dismissal on retirement'),
          leaf('health-grounds', 'Dismissal on health grounds'),
          leaf('death-of-employee', 'Termination on the death of an employee'),
          leaf('transfer-to-another-employer', 'Dismissal by transfer to another employer'),
        ],
      },
      {
        slug: 'leave',
        name: 'Leave',
        nameRu: 'Отпуска',
        children: [
          leaf('annual-paid-leave', 'Order on annual paid leave'),
          leaf('additional-leave', 'Order on additional leave'),
          leaf('unpaid-leave', 'Order on unpaid leave'),
          leaf('maternity-leave', 'Order on maternity leave'),
          leaf('childcare-leave', 'Order on childcare leave'),
          leaf('study-leave', 'Order on study leave'),
          leaf('leave-recall', 'Order on recall from leave'),
          leaf('leave-postponement', 'Order on postponement of leave'),
          leaf('leave-compensation', 'Order on monetary compensation for leave'),
          leaf('leave-schedule', 'Order approving the leave schedule'),
        ],
      },
      {
        slug: 'business-trips',
        name: 'Business trips',
        nameRu: 'Командировки',
        children: [
          leaf('domestic-trip', 'Order on a domestic business trip'),
          leaf('foreign-trip', 'Order on a foreign business trip'),
          leaf('group-trip', 'Order on a group business trip'),
          leaf('trip-extension', 'Order on extension of a business trip'),
          leaf('trip-cancellation', 'Order on cancellation of a business trip'),
          leaf('trip-expenses', 'Order on business trip expenses'),
          leaf('trip-assignment', 'Business trip assignment'),
        ],
      },
      {
        slug: 'discipline',
        name: 'Discipline',
        nameRu: 'Дисциплина',
        children: [
          leaf('remark', 'Order imposing a remark'),
          leaf('reprimand', 'Order imposing a reprimand'),
          leaf('severe-reprimand', 'Order imposing a severe reprimand'),
          leaf('penalty-removal', 'Order removing a disciplinary penalty'),
          leaf('investigation-commission', 'Order forming an investigation commission'),
          leaf('removal-from-duty', 'Order on removal from duty'),
          leaf('explanatory-note-request', 'Request for a written explanation'),
          leaf('misconduct-act', 'Act recording misconduct'),
        ],
      },
      {
        slug: 'remuneration',
        name: 'Remuneration',
        nameRu: 'Оплата труда',
        children: [
          leaf('bonus', 'Order on a bonus'),
          leaf('one-time-payment', 'Order on a one-time payment'),
          leaf('material-aid', 'Order on material aid'),
          leaf('salary-indexation', 'Order on salary indexation'),
          leaf('allowance', 'Order on a salary allowance'),
          leaf('overtime-payment', 'Order on payment for overtime'),
          leaf('deduction', 'Order on a deduction from wages'),
          leaf('bonus-deprivation', 'Order on deprivation of a bonus'),
        ],
      },
      {
        slug: 'working-time',
        name: 'Working time',
        nameRu: 'Рабочее время',
        children: [
          leaf('overtime-work', 'Order on overtime work'),
          leaf('weekend-work', 'Order on work on a day off'),
          leaf('holiday-work', 'Order on work on a public holiday'),
          leaf('night-shift', 'Order on night work'),
          leaf('shift-schedule', 'Order approving a shift schedule'),
          leaf('reduced-hours', 'Order on reduced working hours'),
          leaf('idle-time', 'Order on idle time'),
          leaf('summarised-accounting', 'Order on summarised accounting of working time'),
          leaf('timesheet', 'Working time sheet'),
        ],
      },
      {
        slug: 'personnel-records',
        name: 'Personnel records',
        nameRu: 'Кадровое делопроизводство',
        children: [
          leaf('staffing-table', 'Order approving the staffing table'),
          leaf('staffing-change', 'Order on a change to the staffing table'),
          leaf('job-description', 'Order approving a job description'),
          leaf('personal-card', 'Employee personal card'),
          leaf('employment-record-entry', 'Entry in the employment record book'),
          leaf('personnel-nomenclature', 'Order approving the file nomenclature'),
          leaf('employment-certificate', 'Employment certificate'),
        ],
      },
      {
        slug: 'delegation',
        name: 'Duties and delegation',
        nameRu: 'Возложение обязанностей',
        children: [
          leaf('acting-appointment', 'Order on appointment of an acting officer'),
          leaf('duty-assignment', 'Order assigning additional duties'),
          leaf('responsible-person', 'Order appointing a responsible person'),
          leaf('signature-right', 'Order granting the right of signature'),
          leaf('materially-responsible-person', 'Order on a materially responsible person'),
          leaf('safety-responsible', 'Order appointing a person responsible for safety'),
        ],
      },
    ],
  },

  // -------------------------------------------------------------------------
  // Corporate acts
  // -------------------------------------------------------------------------
  {
    kind: TemplateCategoryKind.CORPORATE_ACT,
    slug: 'corporate-acts',
    name: 'Corporate acts',
    nameRu: 'Корпоративные акты',
    nameUz: 'Korporativ hujjatlar',
    description:
      'Constitutive, governance, and structural instruments of a legal entity.',
    children: [
      {
        slug: 'formation',
        name: 'Formation',
        nameRu: 'Учреждение',
        children: [
          leaf('founding-decision', 'Decision of the sole founder'),
          leaf('founding-protocol', 'Protocol of the founding meeting'),
          leaf('foundation-agreement', 'Foundation agreement'),
          leaf('charter-llc', 'Charter of a limited liability company'),
          leaf('charter-jsc', 'Charter of a joint-stock company'),
          leaf('charter-unitary', 'Charter of a unitary enterprise'),
          leaf('registration-application', 'Application for state registration'),
          leaf('legal-address-confirmation', 'Confirmation of the legal address'),
        ],
      },
      {
        slug: 'charter-amendments',
        name: 'Charter amendments',
        nameRu: 'Изменения в устав',
        children: [
          leaf('charter-new-edition', 'Charter in a new edition'),
          leaf('charter-amendment', 'Amendment to the charter'),
          leaf('name-change', 'Decision on a change of name'),
          leaf('address-change', 'Decision on a change of legal address'),
          leaf('activity-change', 'Decision on a change of activities (OKED)'),
        ],
      },
      {
        slug: 'general-meeting',
        name: 'General meeting',
        nameRu: 'Общее собрание',
        children: [
          leaf('annual-meeting-protocol', 'Protocol of the annual general meeting'),
          leaf('extraordinary-meeting-protocol', 'Protocol of an extraordinary meeting'),
          leaf('meeting-notice', 'Notice of a general meeting'),
          leaf('meeting-agenda', 'Agenda of a general meeting'),
          leaf('absentee-ballot', 'Absentee voting ballot'),
          leaf('sole-participant-decision', 'Decision of the sole participant'),
          leaf('voting-results-protocol', 'Protocol of voting results'),
          leaf('meeting-power-of-attorney', 'Power of attorney to attend a meeting'),
        ],
      },
      {
        slug: 'supervisory-board',
        name: 'Supervisory board',
        nameRu: 'Наблюдательный совет',
        children: [
          leaf('board-formation', 'Decision forming the supervisory board'),
          leaf('board-protocol', 'Protocol of a supervisory board meeting'),
          leaf('board-regulations', 'Regulations on the supervisory board'),
          leaf('board-member-election', 'Election of a board member'),
          leaf('audit-commission', 'Formation of the audit commission'),
        ],
      },
      {
        slug: 'executive-body',
        name: 'Executive body',
        nameRu: 'Исполнительный орган',
        children: [
          leaf('director-appointment', 'Decision appointing the director'),
          leaf('director-dismissal', 'Decision dismissing the director'),
          leaf('director-contract', 'Employment contract with the director'),
          leaf('director-powers-extension', 'Extension of the director powers'),
          leaf('executive-regulations', 'Regulations on the executive body'),
          leaf('management-company-transfer', 'Transfer of powers to a management company'),
        ],
      },
      {
        slug: 'capital',
        name: 'Charter capital and participation',
        nameRu: 'Уставный капитал и доли',
        children: [
          leaf('capital-increase', 'Decision on an increase of charter capital'),
          leaf('capital-decrease', 'Decision on a decrease of charter capital'),
          leaf('share-transfer', 'Transfer of a participatory share'),
          leaf('share-buyback', 'Buyback of a participatory share'),
          leaf('participant-admission', 'Admission of a new participant'),
          leaf('participant-exit', 'Exit of a participant'),
          leaf('share-pledge', 'Pledge of a participatory share'),
          leaf('share-inheritance', 'Inheritance of a participatory share'),
          leaf('dividend-decision', 'Decision on distribution of profit'),
          leaf('share-valuation-act', 'Act of valuation of a contribution in kind'),
        ],
      },
      {
        slug: 'reorganisation',
        name: 'Reorganisation',
        nameRu: 'Реорганизация',
        children: [
          leaf('merger', 'Reorganisation by merger'),
          leaf('accession', 'Reorganisation by accession'),
          leaf('division', 'Reorganisation by division'),
          leaf('spin-off', 'Reorganisation by spin-off'),
          leaf('transformation', 'Reorganisation by transformation'),
          leaf('transfer-act', 'Transfer act'),
          leaf('separation-balance-sheet', 'Separation balance sheet'),
          leaf('creditor-notice-reorganisation', 'Notice to creditors on reorganisation'),
        ],
      },
      {
        slug: 'liquidation',
        name: 'Liquidation and insolvency',
        nameRu: 'Ликвидация и банкротство',
        children: [
          leaf('liquidation-decision', 'Decision on voluntary liquidation'),
          leaf('liquidation-commission', 'Appointment of the liquidation commission'),
          leaf('creditor-notice-liquidation', 'Notice to creditors on liquidation'),
          leaf('interim-liquidation-balance', 'Interim liquidation balance sheet'),
          leaf('final-liquidation-balance', 'Final liquidation balance sheet'),
          leaf('bankruptcy-filing', 'Application for insolvency'),
          leaf('creditor-claim-register', 'Register of creditor claims'),
        ],
      },
      {
        slug: 'subdivisions',
        name: 'Branches and representative offices',
        nameRu: 'Филиалы и представительства',
        children: [
          leaf('branch-establishment', 'Decision establishing a branch'),
          leaf('representative-office', 'Decision establishing a representative office'),
          leaf('branch-regulations', 'Regulations on a branch'),
          leaf('subdivision-head-appointment', 'Appointment of the head of a subdivision'),
          leaf('subdivision-closure', 'Decision closing a subdivision'),
          leaf('separate-subdivision-registration', 'Registration of a separate subdivision'),
        ],
      },
      {
        slug: 'powers-of-attorney',
        name: 'Powers of attorney',
        nameRu: 'Доверенности',
        children: [
          leaf('general-poa', 'General power of attorney'),
          leaf('special-poa', 'Special power of attorney'),
          leaf('one-time-poa', 'One-time power of attorney'),
          leaf('court-representation-poa', 'Power of attorney for court representation'),
          leaf('goods-receipt-poa', 'Power of attorney to receive goods'),
          leaf('tax-representation-poa', 'Power of attorney for tax representation'),
          leaf('substitution-poa', 'Power of attorney by way of substitution'),
          leaf('poa-revocation', 'Revocation of a power of attorney'),
        ],
      },
      {
        slug: 'internal-regulations',
        name: 'Internal regulations',
        nameRu: 'Локальные акты',
        children: [
          leaf('internal-labour-rules', 'Internal labour regulations'),
          leaf('accounting-policy', 'Accounting policy'),
          leaf('document-flow-regulation', 'Document flow regulation'),
          leaf('trade-secret-regulation', 'Trade secret regulation'),
          leaf('personal-data-policy', 'Personal data processing policy'),
          leaf('anti-corruption-policy', 'Anti-corruption policy'),
          leaf('dividend-policy', 'Dividend policy'),
          leaf('procurement-regulation', 'Procurement regulation'),
          leaf('remuneration-regulation', 'Remuneration and bonus regulation'),
          leaf('information-security-policy', 'Information security policy'),
        ],
      },
    ],
  },
];

/** A taxonomy node flattened into the row shape `template_categories` stores. */
export interface FlatTaxonomyNode {
  kind: TemplateCategoryKind;
  slug: string;
  name: string;
  nameRu?: string;
  nameUz?: string;
  description?: string;
  /** Materialized path, leading and trailing slash included. */
  path: string;
  /** Path of the parent, or null at a root. */
  parentPath: string | null;
  depth: number;
  sortOrder: number;
  isLeaf: boolean;
}

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Depth-first walk producing rows in parent-before-child order, which is the
 * order they must be inserted in for `parentId` to resolve.
 *
 * Throws on a malformed slug or a duplicate path rather than letting a typo
 * reach the database, where it would surface as a confusing constraint error
 * during seeding.
 */
export function flattenTaxonomy(
  roots: TaxonomyRoot[] = TEMPLATE_TAXONOMY,
): FlatTaxonomyNode[] {
  const rows: FlatTaxonomyNode[] = [];
  const seen = new Set<string>();

  const visit = (
    node: TaxonomyNode,
    kind: TemplateCategoryKind,
    parentPath: string | null,
    depth: number,
    sortOrder: number,
  ) => {
    if (!SLUG_PATTERN.test(node.slug)) {
      throw new Error(
        `Taxonomy slug "${node.slug}" must be lowercase alphanumeric segments separated by hyphens`,
      );
    }

    const path = `${parentPath ?? '/'}${node.slug}/`;

    if (seen.has(path)) {
      throw new Error(`Duplicate taxonomy path: ${path}`);
    }
    seen.add(path);

    rows.push({
      kind,
      slug: node.slug,
      name: node.name,
      nameRu: node.nameRu,
      nameUz: node.nameUz,
      description: node.description,
      path,
      parentPath,
      depth,
      sortOrder,
      isLeaf: !node.children?.length,
    });

    node.children?.forEach((child, index) =>
      visit(child, kind, path, depth + 1, index),
    );
  };

  roots.forEach((root, index) => visit(root, root.kind, null, 0, index));

  return rows;
}

/** Leaves are where templates hang; interior nodes are navigation only. */
export function taxonomyLeafPaths(
  roots: TaxonomyRoot[] = TEMPLATE_TAXONOMY,
): string[] {
  return flattenTaxonomy(roots)
    .filter((node) => node.isLeaf)
    .map((node) => node.path);
}
