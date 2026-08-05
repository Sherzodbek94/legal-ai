/**
 * Counterparty prefill from the state business registry.
 *
 * One rule carries this component: nothing is written into the contract until
 * somebody confirms it. A STIR that reaches a signed contract wrong is a
 * liability rather than a typo, so an automatic apply — or an apply that fires
 * twice — is the failure worth guarding against, not a mislaid label.
 *
 * The rest is about not misleading the drafter: a registry outage must not read
 * as "this company does not exist", a liquidated counterparty must be
 * impossible to miss, and fields the register cannot supply have to be named
 * rather than left silently blank.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CounterpartyLookup } from './counterparty-lookup';

const ENTITY = {
  legalName: 'Sifat Qurilish MChJ',
  stir: '305123456',
  legalAddress: 'Toshkent, Chilonzor 12',
  directorName: 'Aziz Karimov',
  status: 'ACTIVE' as const,
};

const FOUND = {
  found: true,
  source: 'iHamkor',
  retrievedAt: '2026-08-05T10:00:00Z',
  entity: ENTITY,
  variables: {
    counterparty_name: 'Sifat Qurilish MChJ',
    counterparty_stir: '305123456',
  },
};

function mockFetch(response: { status?: number; body?: unknown; reject?: boolean }) {
  const urls: string[] = [];

  (globalThis as Record<string, unknown>).fetch = jest.fn(async (url: string) => {
    urls.push(url);
    if (response.reject) throw new TypeError('Failed to fetch');

    const status = response.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => response.body ?? {},
    } as Response;
  });

  return urls;
}

function renderLookup(
  { missingFromRegistry = [] as string[] } = {},
) {
  const onApply = jest.fn();
  render(
    <CounterpartyLookup onApply={onApply} missingFromRegistry={missingFromRegistry} />,
  );
  return { onApply };
}

/** Fills the STIR field and presses the button. */
async function lookUp(stir = '305123456') {
  const user = userEvent.setup();
  await user.clear(screen.getByLabelText(/counterparty stir/i));
  await user.type(screen.getByLabelText(/counterparty stir/i), stir);
  fireEvent.click(screen.getByRole('button', { name: /look up/i }));
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('CounterpartyLookup', () => {
  describe('the STIR field', () => {
    it('accepts only digits, and at most nine', async () => {
      mockFetch({ body: FOUND });
      renderLookup();

      const field = screen.getByLabelText(/counterparty stir/i);
      await userEvent.type(field, '30a5-12 3456789');

      expect((field as HTMLInputElement).value).toBe('305123456');
    });

    it('keeps the button disabled until nine digits are entered', async () => {
      mockFetch({ body: FOUND });
      renderLookup();

      const button = screen.getByRole('button', { name: /look up/i });
      await userEvent.type(screen.getByLabelText(/counterparty stir/i), '30512');
      expect(button).toBeDisabled();

      await userEvent.type(screen.getByLabelText(/counterparty stir/i), '3456');
      expect(button).toBeEnabled();
    });

    it('runs the lookup on Enter instead of submitting the form around it', async () => {
      // This field lives inside the generate form. Enter in a text input
      // submits the form it belongs to, which would generate a document from a
      // half-filled draft.
      const urls = mockFetch({ body: FOUND });
      renderLookup();

      await userEvent.type(screen.getByLabelText(/counterparty stir/i), '305123456');
      fireEvent.keyDown(screen.getByLabelText(/counterparty stir/i), { key: 'Enter' });

      await waitFor(() => expect(urls).toHaveLength(1));
    });

    it('ignores Enter before the STIR is complete', async () => {
      const urls = mockFetch({ body: FOUND });
      renderLookup();

      await userEvent.type(screen.getByLabelText(/counterparty stir/i), '3051');
      fireEvent.keyDown(screen.getByLabelText(/counterparty stir/i), { key: 'Enter' });

      expect(urls).toHaveLength(0);
    });
  });

  describe('nothing is applied without confirmation', () => {
    it('does not fill anything on a successful lookup', async () => {
      // THE rule. The result is shown; a separate action writes it in.
      const { onApply } = renderLookup();
      mockFetch({ body: FOUND });

      await lookUp();
      expect(await screen.findByText('Sifat Qurilish MChJ')).toBeInTheDocument();

      expect(onApply).not.toHaveBeenCalled();
    });

    it('fills the fields only when the drafter confirms', async () => {
      const { onApply } = renderLookup();
      mockFetch({ body: FOUND });

      await lookUp();
      fireEvent.click(await screen.findByRole('button', { name: /use these details/i }));

      expect(onApply).toHaveBeenCalledWith(FOUND.variables);
    });

    it('cannot be applied twice', async () => {
      // A second apply would silently overwrite edits the drafter made after
      // the first one.
      const { onApply } = renderLookup();
      mockFetch({ body: FOUND });

      await lookUp();
      const apply = await screen.findByRole('button', { name: /use these details/i });
      fireEvent.click(apply);

      expect(await screen.findByRole('button', { name: /applied/i })).toBeDisabled();
      expect(onApply).toHaveBeenCalledTimes(1);
    });
  });

  describe('registry status', () => {
    it('warns on a liquidated counterparty', async () => {
      renderLookup();
      mockFetch({
        body: { ...FOUND, entity: { ...ENTITY, status: 'LIQUIDATED' } },
      });

      await lookUp();

      expect(await screen.findByText(/check before signing/i)).toBeInTheDocument();
      expect(screen.getByText(/reports this company as liquidated/i)).toBeInTheDocument();
    });

    it('warns on a suspended one', async () => {
      renderLookup();
      mockFetch({ body: { ...FOUND, entity: { ...ENTITY, status: 'SUSPENDED' } } });

      await lookUp();

      expect(await screen.findByText(/check before signing/i)).toBeInTheDocument();
    });

    it('warns when the registry did not report a status', async () => {
      // "We could not establish whether this company is trading" is
      // information; hiding it leaves the row looking as clean as a confirmed
      // active one.
      renderLookup();
      mockFetch({ body: { ...FOUND, entity: { ...ENTITY, status: 'UNKNOWN' } } });

      await lookUp();

      expect(await screen.findByText(/check before signing/i)).toBeInTheDocument();
      // Once in the detail row and once in the warning, which is the point:
      // the status is stated plainly and then called out.
      expect(
        screen.getByText(/reports this company as status not reported/i),
      ).toBeInTheDocument();
    });

    it('stays quiet on an active one', async () => {
      renderLookup();
      mockFetch({ body: FOUND });

      await lookUp();
      await screen.findByText('Sifat Qurilish MChJ');

      expect(screen.queryByText(/check before signing/i)).not.toBeInTheDocument();
    });

    it('still allows applying a liquidated counterparty', async () => {
      // A warning, not a block: naming a liquidated company in a document is
      // sometimes exactly what is required.
      const { onApply } = renderLookup();
      mockFetch({ body: { ...FOUND, entity: { ...ENTITY, status: 'LIQUIDATED' } } });

      await lookUp();
      fireEvent.click(await screen.findByRole('button', { name: /use these details/i }));

      expect(onApply).toHaveBeenCalled();
    });
  });

  describe('what the registry cannot supply', () => {
    it('names the fields that still have to come from the counterparty', async () => {
      // Bank details are not in the public register. Left unmentioned they
      // stay blank on a document that otherwise looks complete.
      renderLookup({ missingFromRegistry: ['counterparty_bank_account', 'counterparty_mfo'] });
      mockFetch({ body: FOUND });

      await lookUp();

      expect(
        await screen.findByText(/counterparty_bank_account, counterparty_mfo/),
      ).toBeInTheDocument();
    });

    it('says nothing when the registry covers every declared field', async () => {
      renderLookup({ missingFromRegistry: [] });
      mockFetch({ body: FOUND });

      await lookUp();
      await screen.findByText('Sifat Qurilish MChJ');

      expect(screen.queryByText(/not published in the register/i)).not.toBeInTheDocument();
    });
  });

  describe('failures', () => {
    it('distinguishes an outage from a company that does not exist', async () => {
      // Telling someone their correct STIR does not exist sends them off
      // editing a right answer.
      renderLookup();
      mockFetch({ status: 503 });

      await lookUp();

      expect(await screen.findByRole('alert')).toHaveTextContent(
        /registry could not be reached/i,
      );
    });

    it('reports a STIR the registry has no record of', async () => {
      renderLookup();
      mockFetch({ body: { found: false, stir: '305123456' } });

      await lookUp();

      expect(await screen.findByRole('alert')).toHaveTextContent(
        /no company is registered under stir 305123456/i,
      );
    });

    it('offers nothing to apply when nothing was found', async () => {
      const { onApply } = renderLookup();
      mockFetch({ body: { found: false, stir: '305123456' } });

      await lookUp();
      await screen.findByRole('alert');

      expect(
        screen.queryByRole('button', { name: /use these details/i }),
      ).not.toBeInTheDocument();
      expect(onApply).not.toHaveBeenCalled();
    });

    it('reports a rejected STIR', async () => {
      renderLookup();
      mockFetch({ status: 400 });

      await lookUp();

      expect(await screen.findByRole('alert')).toHaveTextContent(/valid stir/i);
    });

    it('reports a dead connection distinctly', async () => {
      renderLookup();
      mockFetch({ reject: true });

      await lookUp();

      expect(await screen.findByRole('alert')).toHaveTextContent(
        /could not reach the server/i,
      );
    });

    it('clears a previous result before searching again', async () => {
      // Leaving the old company on screen under a new STIR invites applying
      // the wrong one.
      renderLookup();
      mockFetch({ body: FOUND });
      await lookUp();
      await screen.findByText('Sifat Qurilish MChJ');

      mockFetch({ status: 503 });
      await lookUp('305999999');

      await waitFor(() =>
        expect(screen.queryByText('Sifat Qurilish MChJ')).not.toBeInTheDocument(),
      );
    });
  });
});
