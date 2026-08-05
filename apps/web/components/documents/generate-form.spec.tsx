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

      const disclosure = screen.getByText(/additional terms/i).closest('details');
      expect(disclosure).not.toHaveAttribute('open');
      expect(screen.getByLabelText(/yillik ta'til/i)).toBeInTheDocument();
    });

    it('says how many fields are already set', () => {
      // "2 standard fields, already set" reads as reassurance; a bare
      // "Additional terms" reads as more work waiting.
      renderForm([...ESSENTIAL, ...ADVANCED]);

      expect(screen.getByText(/2 standard fields, already set/i)).toBeInTheDocument();
    });

    it('opens on request', async () => {
      renderForm([...ESSENTIAL, ...ADVANCED]);

      await userEvent.click(screen.getByText(/additional terms/i));

      expect(screen.getByText(/additional terms/i).closest('details')).toHaveAttribute(
        'open',
      );
    });

    it('offers no disclosure when every field is essential', () => {
      // An empty "Additional terms" panel is a promise of hidden complexity
      // that isn't there.
      renderForm(ESSENTIAL);

      expect(screen.queryByText(/additional terms/i)).not.toBeInTheDocument();
    });
  });

  describe('when the server rejects a hidden field', () => {
    it('opens the disclosure so the error is visible', () => {
      // Otherwise the error renders inside a closed panel and the form looks
      // rejected for no stated reason.
      setState({ fieldErrors: { annual_leave_days: 'must be at least 15' } });
      renderForm([...ESSENTIAL, ...ADVANCED]);

      expect(screen.getByText(/additional terms/i).closest('details')).toHaveAttribute(
        'open',
      );
      expect(screen.getByText(/must be at least 15/i)).toBeVisible();
    });

    it('stays closed when only an essential field failed', () => {
      setState({ fieldErrors: { job_position: 'is required' } });
      renderForm([...ESSENTIAL, ...ADVANCED]);

      expect(
        screen.getByText(/additional terms/i).closest('details'),
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
