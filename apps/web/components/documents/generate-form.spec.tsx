/**
 * The compact / extended split on the generation form.
 *
 * The shipped employment contract declares 31 variables, 30 of them required —
 * a wall a drafter has to get through before papering a routine hire. Most are
 * statutory or house-standard figures identical on every contract; a handful
 * are the particulars of this hire. The `advanced` flag is that distinction,
 * and this is where it becomes a shorter form.
 *
 * The property that makes it safe: the API refuses to mark a variable advanced
 * unless it is optional or carries a default, so a drafter who never opens the
 * disclosure still submits successfully. The failure this guards against is the
 * opposite one — a hidden field that *did* fail, rendering its error inside a
 * closed disclosure, so the form appears to have been rejected for no reason.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { VariableDefinition } from '@/lib/variable-schema';
import { GenerateForm } from './generate-form';

jest.mock('react-dom', () => {
  const actual = jest.requireActual('react-dom');
  return {
    ...actual,
    useFormState: (_action: unknown, initial: unknown) => [
      (globalThis as { __formState?: unknown }).__formState ?? initial,
      jest.fn(),
    ],
    useFormStatus: () => ({ pending: false }),
  };
});

function setState(state: unknown) {
  (globalThis as { __formState?: unknown }).__formState = state;
}

const ESSENTIAL: VariableDefinition[] = [
  { key: 'job_position', label: 'Lavozim', type: 'string', required: true },
  { key: 'monthly_salary', label: 'Oylik ish haqi', type: 'money', required: true },
];

const ADVANCED: VariableDefinition[] = [
  {
    key: 'annual_leave_days',
    label: "Yillik ta'til kunlari",
    type: 'integer',
    required: true,
    defaultValue: 21,
    advanced: true,
  },
  {
    key: 'termination_notice_days',
    label: 'Xabar berish muddati',
    type: 'integer',
    required: true,
    defaultValue: 14,
    advanced: true,
  },
];

function renderForm(definitions: VariableDefinition[]) {
  render(
    <GenerateForm
      definitions={definitions}
      companyDefaults={{}}
      templateName="Mehnat shartnomasi"
      aiAvailable
      counterpartyLookupAvailable={false}
      action={jest.fn()}
    />,
  );
}

beforeEach(() => {
  setState({});
});

describe('GenerateForm', () => {
  describe('the compact form', () => {
    it('shows the essential fields directly', () => {
      renderForm([...ESSENTIAL, ...ADVANCED]);

      expect(screen.getByLabelText(/lavozim/i)).toBeVisible();
      expect(screen.getByLabelText(/oylik ish haqi/i)).toBeVisible();
    });

    it('puts the standard terms behind a closed disclosure', () => {
      // Present in the DOM — so they still submit with their defaults — but
      // not in the drafter's way.
      renderForm([...ESSENTIAL, ...ADVANCED]);

      const disclosure = screen.getByText(/already filled in/i).closest('details');
      expect(disclosure).not.toHaveAttribute('open');
      expect(screen.getByLabelText(/yillik ta'til/i)).toBeInTheDocument();
    });

    it('says how many fields are already set', () => {
      // "2 fields — your company details" reads as reassurance; a bare
      // "Already filled in" reads as more work waiting.
      renderForm([...ESSENTIAL, ...ADVANCED]);

      expect(screen.getByText(/2 fields — your company details/i)).toBeInTheDocument();
    });

    it('opens on request', async () => {
      renderForm([...ESSENTIAL, ...ADVANCED]);

      await userEvent.click(screen.getByText(/already filled in/i));

      expect(screen.getByText(/already filled in/i).closest('details')).toHaveAttribute(
        'open',
      );
    });

    it('offers no disclosure when every field is essential', () => {
      // An empty "Already filled in" panel is a promise of hidden complexity
      // that isn't there.
      renderForm(ESSENTIAL);

      expect(screen.queryByText(/already filled in/i)).not.toBeInTheDocument();
    });
  });

  describe('when the server rejects a hidden field', () => {
    it('opens the disclosure so the error is visible', () => {
      // Otherwise the error renders inside a closed panel and the form looks
      // rejected for no stated reason.
      setState({ fieldErrors: { annual_leave_days: 'must be at least 15' } });
      renderForm([...ESSENTIAL, ...ADVANCED]);

      expect(screen.getByText(/already filled in/i).closest('details')).toHaveAttribute(
        'open',
      );
      expect(screen.getByText(/must be at least 15/i)).toBeVisible();
    });

    it('stays closed when only an essential field failed', () => {
      setState({ fieldErrors: { job_position: 'is required' } });
      renderForm([...ESSENTIAL, ...ADVANCED]);

      expect(
        screen.getByText(/already filled in/i).closest('details'),
      ).not.toHaveAttribute('open');
    });
  });

  describe('prefilled values', () => {
    it('fills a field from the company profile', () => {
      // The point of the profile: a drafter should never retype their own
      // registered details.
      render(
        <GenerateForm
          definitions={[
            { key: 'company_tin', label: 'STIR', type: 'string', required: true },
          ]}
          companyDefaults={{ company_tin: '301234567' }}
          templateName="Mehnat shartnomasi"
          aiAvailable
          counterpartyLookupAvailable={false}
          action={jest.fn()}
        />,
      );

      expect((screen.getByLabelText(/stir/i) as HTMLInputElement).value).toBe(
        '301234567',
      );
    });

    it('shows a schema default as a placeholder, not a value', () => {
      // Pre-filling would make "left alone" indistinguishable from
      // "deliberately set to the same number".
      renderForm([
        {
          key: 'weekly_working_hours',
          label: 'Haftalik ish soati',
          type: 'number',
          defaultValue: 40,
        },
      ]);

      const field = screen.getByLabelText(/haftalik ish soati/i) as HTMLInputElement;
      expect(field.value).toBe('');
      expect(field.placeholder).toBe('40');
    });
  });
});

/**
 * Collapsing what the company profile already answered.
 *
 * Across the shipped templates this is six to eight fields each — the
 * drafter's own STIR, address, bank details and director. Nobody reviews their
 * own registered particulars to paper a hire, and putting them first is most
 * of why a routine document feels like a form-filling exercise.
 *
 * The decision is per render rather than per schema because it depends on
 * whether the value actually arrived. An incomplete profile is the case that
 * matters: hiding a required field that came back blank produces a form that
 * cannot be submitted and does not say why.
 */
describe('GenerateForm — profile-filled fields', () => {
  const COMPANY: VariableDefinition[] = [
    { key: 'company_tin', label: 'Ish beruvchi STIR', type: 'string', required: true },
    {
      key: 'company_bank_account',
      label: 'Ish beruvchi hisob raqami',
      type: 'string',
      required: true,
    },
  ];

  function renderWith(defaults: Record<string, string>) {
    render(
      <GenerateForm
        definitions={[...ESSENTIAL, ...COMPANY]}
        companyDefaults={defaults}
        templateName="Mehnat shartnomasi"
        aiAvailable
        counterpartyLookupAvailable={false}
        action={jest.fn()}
      />,
    );
  }

  it('collapses a required field the profile answered', () => {
    renderWith({ company_tin: '301234567', company_bank_account: '20208000900001234567' });

    expect(screen.getByText(/already filled in/i).closest('details')).not.toHaveAttribute(
      'open',
    );
    // Still submitted — collapsed, not dropped.
    expect((screen.getByLabelText(/stir/i) as HTMLInputElement).value).toBe('301234567');
  });

  it('leaves the hire particulars in front of the drafter', () => {
    renderWith({ company_tin: '301234567', company_bank_account: '2020' });

    const disclosure = screen.getByText(/already filled in/i).closest('details');
    expect(disclosure).not.toContainElement(screen.getByLabelText(/lavozim/i));
    expect(disclosure).toContainElement(screen.getByLabelText(/stir/i));
  });

  it('keeps a field the profile could not answer out front', () => {
    // The incomplete-profile case. A blank required field belongs where the
    // drafter can see what is missing.
    renderWith({ company_tin: '301234567' });

    const disclosure = screen.getByText(/already filled in/i).closest('details');
    expect(disclosure).not.toContainElement(screen.getByLabelText(/hisob raqami/i));
  });

  it.each(['', '   '])('treats %p as unanswered', (value) => {
    renderWith({ company_tin: value, company_bank_account: '20208000900001234567' });

    const disclosure = screen.getByText(/already filled in/i).closest('details');
    expect(disclosure).not.toContainElement(screen.getByLabelText(/stir/i));
  });

  it('offers no disclosure when the profile answered nothing', () => {
    renderWith({});

    expect(screen.queryByText(/already filled in/i)).not.toBeInTheDocument();
  });

  it('opens itself when the server rejects a collapsed profile field', () => {
    setState({ fieldErrors: { company_tin: 'must be 9 digits' } });
    renderWith({ company_tin: '30123', company_bank_account: '2020' });

    expect(screen.getByText(/already filled in/i).closest('details')).toHaveAttribute(
      'open',
    );
  });
});
