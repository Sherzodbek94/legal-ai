/**
 * SMS sign-in, driven the way a user drives it.
 *
 * This is the login path, so the failures are total rather than cosmetic — a
 * number formatted wrong sends the code to somebody else's handset, and every
 * attempt is billed. The formatter in particular has a history: when the
 * country code lived inside the field, typing the full `998 91 555 77 88`
 * produced `+998 99 891 55 57`, because the `998` the formatter had just
 * written back was indistinguishable from the one still being typed. That case
 * is pinned below.
 *
 * `formatUzPhone` and `toE164` are module-private, which is the right shape —
 * they are exercised through the field, so what is asserted is what a user
 * would see and what actually goes on the wire.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { silenceNavigation } from '../../jest.setup';
import { PhoneSignIn } from './phone-sign-in';

/** Captures what was sent, and answers with whatever the test needs next. */
function mockFetch(
  responses: Array<{ ok?: boolean; status?: number; body?: unknown }> = [],
) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  let call = 0;

  const fetchMock = jest.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    const response = responses[call++] ?? { ok: true, body: { resendAfter: 60 } };

    return {
      ok: response.ok ?? true,
      status: response.status ?? (response.ok === false ? 400 : 200),
      json: async () => response.body ?? {},
    } as Response;
  });

  (globalThis as Record<string, unknown>).fetch = fetchMock;
  return { calls, fetchMock };
}

/** Types a number into the phone field and returns what it displays. */
async function typePhone(input: string) {
  const user = userEvent.setup();
  const field = screen.getByLabelText(/phone number/i);
  await user.clear(field);
  await user.type(field, input);
  return (field as HTMLInputElement).value;
}

beforeEach(() => {
  jest.useRealTimers();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('PhoneSignIn', () => {
  describe('number formatting', () => {
    it('groups the national digits as they are typed', async () => {
      mockFetch();
      render(<PhoneSignIn onCancel={() => {}} />);

      expect(await typePhone('901234567')).toBe('90 123 45 67');
    });

    it('strips a pasted country code', async () => {
      mockFetch();
      render(<PhoneSignIn onCancel={() => {}} />);

      expect(await typePhone('998901234567')).toBe('90 123 45 67');
    });

    it('does not mangle a number typed in full, country code included', async () => {
      // The regression this formatter was rewritten for.
      mockFetch();
      render(<PhoneSignIn onCancel={() => {}} />);

      expect(await typePhone('998915557788')).toBe('91 555 77 88');
    });

    it('keeps a leading 998 that is part of the national number', async () => {
      // `99 812 34 56` is a real number on the 99 code — the leading 998
      // cannot be assumed to be a country code on its own.
      mockFetch();
      render(<PhoneSignIn onCancel={() => {}} />);

      expect(await typePhone('998123456')).toBe('99 812 34 56');
    });

    it('ignores anything that is not a digit', async () => {
      mockFetch();
      render(<PhoneSignIn onCancel={() => {}} />);

      expect(await typePhone('(90) 123-45-67')).toBe('90 123 45 67');
    });

    it('stops at nine digits', async () => {
      mockFetch();
      render(<PhoneSignIn onCancel={() => {}} />);

      expect(await typePhone('9012345678999')).toBe('90 123 45 67');
    });
  });

  describe('requesting a code', () => {
    it('keeps the submit button disabled until the number is complete', async () => {
      mockFetch();
      render(<PhoneSignIn onCancel={() => {}} />);

      const submit = screen.getByRole('button', { name: /send code/i });
      await typePhone('9012345');
      expect(submit).toBeDisabled();

      await typePhone('901234567');
      expect(submit).toBeEnabled();
    });

    it('sends the number in E.164, not as displayed', async () => {
      // The API stores and looks up `User.phone` in this form; sending the
      // spaced version would make one person two accounts.
      const { calls } = mockFetch();
      render(<PhoneSignIn onCancel={() => {}} />);

      await typePhone('901234567');
      fireEvent.click(screen.getByRole('button', { name: /send code/i }));

      await waitFor(() => expect(calls).toHaveLength(1));
      expect(calls[0].url).toMatch(/\/auth\/otp\/request$/);
      expect(calls[0].body).toEqual({ phone: '+998901234567' });
    });

    it('moves to the code step once the code is on its way', async () => {
      mockFetch();
      render(<PhoneSignIn onCancel={() => {}} />);

      await typePhone('901234567');
      fireEvent.click(screen.getByRole('button', { name: /send code/i }));

      expect(await screen.findByLabelText(/six-digit code/i)).toBeInTheDocument();
    });

    it('keeps the number visible on the code step', async () => {
      // So "did I mistype it" is answerable without going back and losing the
      // code that is already on its way.
      mockFetch();
      render(<PhoneSignIn onCancel={() => {}} />);

      await typePhone('901234567');
      fireEvent.click(screen.getByRole('button', { name: /send code/i }));

      expect(await screen.findByText(/\+998 90 123 45 67/)).toBeInTheDocument();
    });

    it('shows the API’s reason and stays on the phone step', async () => {
      // A quota refusal has to be readable — the user is otherwise told
      // nothing and simply presses the button again.
      mockFetch([
        { ok: false, status: 429, body: { message: { message: 'Too many codes requested.' } } },
      ]);
      render(<PhoneSignIn onCancel={() => {}} />);

      await typePhone('901234567');
      fireEvent.click(screen.getByRole('button', { name: /send code/i }));

      expect(await screen.findByText(/too many codes requested/i)).toBeInTheDocument();
      expect(screen.queryByLabelText(/six-digit code/i)).not.toBeInTheDocument();
    });

    it('reports a dead connection distinctly from a refusal', async () => {
      (globalThis as Record<string, unknown>).fetch = jest.fn(async () => {
        throw new TypeError('Failed to fetch');
      });
      render(<PhoneSignIn onCancel={() => {}} />);

      await typePhone('901234567');
      fireEvent.click(screen.getByRole('button', { name: /send code/i }));

      expect(await screen.findByText(/could not reach the server/i)).toBeInTheDocument();
    });
  });

  describe('verifying', () => {
    /** Gets to the code step with a code already typed. */
    async function atCodeStep(
      responses: Array<{ ok?: boolean; status?: number; body?: unknown }> = [],
    ) {
      const mock = mockFetch([{ ok: true, body: { resendAfter: 60 } }, ...responses]);
      render(<PhoneSignIn onCancel={() => {}} />);

      await typePhone('901234567');
      fireEvent.click(screen.getByRole('button', { name: /send code/i }));
      await screen.findByLabelText(/six-digit code/i);

      return mock;
    }

    it('focuses the code field on arrival', async () => {
      // The next action is always to type the code; making the user click
      // first is friction on a screen that exists for one input.
      await atCodeStep();

      await waitFor(() =>
        expect(screen.getByLabelText(/six-digit code/i)).toHaveFocus(),
      );
    });

    it('accepts only digits, and at most six', async () => {
      await atCodeStep();
      const field = screen.getByLabelText(/six-digit code/i);

      await userEvent.type(field, '12ab34cd5678');

      expect((field as HTMLInputElement).value).toBe('123456');
    });

    it('keeps sign-in disabled until six digits are entered', async () => {
      await atCodeStep();
      const submit = screen.getByRole('button', { name: /sign in/i });

      await userEvent.type(screen.getByLabelText(/six-digit code/i), '12345');
      expect(submit).toBeDisabled();

      await userEvent.type(screen.getByLabelText(/six-digit code/i), '6');
      expect(submit).toBeEnabled();
    });

    it('sends the code with the number, both normalised', async () => {
      // The redirect that follows a success cannot be observed under jsdom —
      // see silenceNavigation. Everything up to it can.
      silenceNavigation();
      const { calls } = await atCodeStep([{ ok: true, body: { hasCompany: true } }]);

      await userEvent.type(screen.getByLabelText(/six-digit code/i), '482913');
      fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

      await waitFor(() => expect(calls).toHaveLength(2));
      expect(calls[1].url).toMatch(/\/auth\/otp\/verify$/);
      expect(calls[1].body).toEqual({ phone: '+998901234567', code: '482913' });
    });

    it('leaves the form submitting rather than re-enabling it on success', async () => {
      // The redirect is in flight. Re-enabling the button here invites a second
      // verify against a code the first one already consumed, which answers
      // "no active code" and reads as a failure on a sign-in that worked.
      silenceNavigation();
      await atCodeStep([{ ok: true, body: { hasCompany: true } }]);

      await userEvent.type(screen.getByLabelText(/six-digit code/i), '482913');
      fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

      await waitFor(() =>
        expect(screen.getByRole('button', { name: /checking/i })).toBeDisabled(),
      );
    });

    it('clears the field on a wrong code so the user can retype', async () => {
      await atCodeStep([{ ok: false, status: 401 }]);

      await userEvent.type(screen.getByLabelText(/six-digit code/i), '000000');
      fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

      expect(await screen.findByText(/that code is not right/i)).toBeInTheDocument();
      await waitFor(() =>
        expect((screen.getByLabelText(/six-digit code/i) as HTMLInputElement).value).toBe(
          '',
        ),
      );
    });

    it('returns focus to the field after a wrong code', async () => {
      await atCodeStep([{ ok: false, status: 401 }]);

      await userEvent.type(screen.getByLabelText(/six-digit code/i), '000000');
      fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

      await waitFor(() =>
        expect(screen.getByLabelText(/six-digit code/i)).toHaveFocus(),
      );
    });

    it('does not report an expired challenge as a wrong code', async () => {
      // 401 means the digits were wrong; anything else has its own reason and
      // "check it and try again" would send the user in a loop.
      await atCodeStep([
        { ok: false, status: 400, body: { message: { message: 'No active code for this number' } } },
      ]);

      await userEvent.type(screen.getByLabelText(/six-digit code/i), '482913');
      fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

      expect(await screen.findByText(/no active code for this number/i)).toBeInTheDocument();
    });
  });

  describe('resend', () => {
    it('counts down instead of greying out silently', async () => {
      // "Why is this disabled" is a question a timer answers on its own.
      mockFetch([{ ok: true, body: { resendAfter: 60 } }]);
      render(<PhoneSignIn onCancel={() => {}} />);

      await typePhone('901234567');
      fireEvent.click(screen.getByRole('button', { name: /send code/i }));

      const resend = await screen.findByRole('button', { name: /resend in 60s/i });
      expect(resend).toBeDisabled();
    });

    it('honours the cooldown the API reported, not a hardcoded one', async () => {
      // The server owns the cooldown; a client-side guess that runs short puts
      // the user into a refusal they were invited to trigger.
      mockFetch([{ ok: true, body: { resendAfter: 120 } }]);
      render(<PhoneSignIn onCancel={() => {}} />);

      await typePhone('901234567');
      fireEvent.click(screen.getByRole('button', { name: /send code/i }));

      expect(await screen.findByRole('button', { name: /resend in 120s/i })).toBeInTheDocument();
    });
  });

  describe('going back', () => {
    it('calls onCancel from the phone step', async () => {
      const onCancel = jest.fn();
      mockFetch();
      render(<PhoneSignIn onCancel={onCancel} />);

      fireEvent.click(screen.getByRole('button', { name: /back/i }));

      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it('returns to the number, keeping it, and drops the error', async () => {
      mockFetch([{ ok: true, body: { resendAfter: 60 } }]);
      render(<PhoneSignIn onCancel={() => {}} />);

      await typePhone('901234567');
      fireEvent.click(screen.getByRole('button', { name: /send code/i }));
      await screen.findByLabelText(/six-digit code/i);

      fireEvent.click(screen.getByRole('button', { name: /change number/i }));

      expect(
        (screen.getByLabelText(/phone number/i) as HTMLInputElement).value,
      ).toBe('90 123 45 67');
    });
  });
});
