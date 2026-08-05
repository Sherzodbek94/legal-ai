'use client';

import type * as React from 'react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, Loader2, MessageSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { apiBaseUrl } from '@/lib/api-config';
import { readApiError } from '@/lib/read-api-error';
import { useHydrated } from '@/lib/use-hydrated';

/**
 * Uzbekistan mobile numbers are +998 followed by nine national digits.
 *
 * This formats the national part only; `+998` is rendered beside the field and
 * is not editable. Keeping the country code out of the value is what makes the
 * formatter unambiguous — when it lived inside the field, a user typing the
 * full `998 91 555 77 88` produced `+998 99 891 55 57`, because the leading
 * `998` the formatter had just written back was indistinguishable from the one
 * the user was still typing, and only one of them could be stripped.
 *
 * Formatted as the user types rather than validated after the fact: the shape
 * of the field tells them what is expected, so there is nothing to correct.
 */
function formatUzPhone(raw: string): string {
  let digits = raw.replace(/\D/g, '');

  // A pasted international number carries the country code. Only stripped when
  // there is more than a national number's worth of digits: `99 812 34 56` is
  // a real number on the 99 code, so the leading `998` cannot be assumed to be
  // a country code on its own.
  if (digits.length > 9 && digits.startsWith('998')) {
    digits = digits.slice(3);
  }

  digits = digits.slice(0, 9);

  return [
    digits.slice(0, 2),
    digits.slice(2, 5),
    digits.slice(5, 7),
    digits.slice(7, 9),
  ]
    .filter(Boolean)
    .join(' ');
}

/** The national digits plus the fixed country code the field does not hold. */
function toE164(nationalFormatted: string): string {
  return `+998${nationalFormatted.replace(/\D/g, '')}`;
}

/**
 * The phone field: a fixed `+998` beside an input that holds only the national
 * digits.
 *
 * A component rather than a `<div>` wrapped around `<Input>` inside `Field`,
 * because Field clones its child to attach `id`, `aria-describedby` and
 * `aria-invalid` — cloning a wrapper div puts the label's `for` target on the
 * div, and the input is then unlabelled. Those props arrive here and are
 * forwarded to the real input.
 */
function PhoneInput({
  value,
  onValueChange,
  invalid,
  ...field
}: {
  value: string;
  onValueChange: (next: string) => void;
  invalid: boolean;
} & React.ComponentPropsWithoutRef<'input'>) {
  return (
    // `focus-within` moves the focus ring to the wrapper so the prefix and the
    // input still read as one control.
    <div
      className={`flex items-center rounded-md border bg-background transition-[border-color,box-shadow] duration-150 focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 focus-within:ring-offset-background ${
        invalid ? 'animate-shake border-destructive' : 'border-input'
      }`}
    >
      <span
        aria-hidden="true"
        className="select-none py-2 pl-3 text-sm text-muted-foreground"
      >
        +998
      </span>
      <Input
        {...field}
        type="tel"
        inputMode="numeric"
        autoComplete="tel-national"
        value={value}
        onChange={(event) => onValueChange(formatUzPhone(event.target.value))}
        placeholder="90 123 45 67"
        // The wrapper draws the border and the focus ring for both halves; a
        // second set on the input would double them up.
        className="border-0 bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0"
      />
    </div>
  );
}

type Step = 'phone' | 'code';

/**
 * SMS one-time-code sign-in.
 *
 * Two steps in one card rather than two pages: the number stays visible while
 * the code is entered, so "did I mistype it" is answerable without going back
 * and losing the code that is already on its way.
 *
 * A correct code *is* the sign-in — the API mints a session directly, because
 * `User.phone` is unique and verified, so the number identifies exactly one
 * account and the SMS is the proof of possession.
 */
export function PhoneSignIn({ onCancel }: { onCancel: () => void }) {
  const hydrated = useHydrated();
  const [step, setStep] = useState<Step>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resendIn, setResendIn] = useState(0);
  const [shake, setShake] = useState(0);

  const codeRef = useRef<HTMLInputElement>(null);

  // Focus the code field as soon as the step changes — the user's next action
  // is always to type the code, and making them click first is friction on a
  // screen that exists for one input.
  useEffect(() => {
    if (step === 'code') codeRef.current?.focus();
  }, [step]);

  useEffect(() => {
    if (resendIn <= 0) return;
    const timer = window.setTimeout(() => setResendIn((n) => n - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [resendIn]);

  const phoneComplete = phone.replace(/\D/g, '').length === 9;

  async function requestCode(event?: FormEvent) {
    event?.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch(`${apiBaseUrl}/auth/otp/request`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone: toE164(phone) }),
      });

      if (!response.ok) {
        setError(await readApiError(response, 'Could not send the code.'));
        setShake((n) => n + 1);
        setSubmitting(false);
        return;
      }

      const body = (await response.json()) as { resendAfter?: number };
      setResendIn(body.resendAfter ?? 60);
      setStep('code');
      setCode('');
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setSubmitting(false);
    }
  }

  async function verify(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch(`${apiBaseUrl}/auth/otp/verify`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone: toE164(phone), code }),
      });

      if (!response.ok) {
        setError(
          response.status === 401
            ? 'That code is not right. Check it and try again.'
            : await readApiError(response, 'Could not verify the code.'),
        );
        // A wrong code is the one error worth a physical cue: the field is
        // already focused and the user is about to retype into it.
        setShake((n) => n + 1);
        setCode('');
        codeRef.current?.focus();
        setSubmitting(false);
        return;
      }

      const body = (await response.json()) as { hasCompany?: boolean };
      // Full navigation: the session cookie was just set, and every server
      // component downstream reads it from a fresh request.
      window.location.href = body.hasCompany ? '/dashboard' : '/onboarding';
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
      setSubmitting(false);
    }
  }

  return (
    <div className="animate-expand-in space-y-4">
      {step === 'phone' ? (
        <form onSubmit={requestCode} noValidate className="space-y-4">
          <Field
            label="Phone number"
            htmlFor="otp-phone"
            hint="We text a six-digit code. Standard rates apply."
            error={error ?? undefined}
            required
          >
            <PhoneInput
              value={phone}
              onValueChange={setPhone}
              invalid={Boolean(error)}
              // `key` on the shake counter restarts the animation on every
              // failure; without it a second failure plays nothing.
              key={`phone-${shake}`}
            />
          </Field>

          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={onCancel} disabled={submitting}>
              <ArrowLeft aria-hidden="true" />
              Back
            </Button>
            <Button
              type="submit"
              className="flex-1"
              disabled={submitting || !phoneComplete || !hydrated}
            >
              {submitting ? (
                <>
                  <Loader2 className="animate-spin" aria-hidden="true" />
                  Sending…
                </>
              ) : (
                <>
                  <MessageSquare aria-hidden="true" />
                  Send code
                </>
              )}
            </Button>
          </div>
        </form>
      ) : (
        <form onSubmit={verify} noValidate className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Code sent to{' '}
            <span className="font-medium text-foreground">+998 {phone}</span>.
          </p>

          <Field
            label="Six-digit code"
            htmlFor="otp-code"
            error={error ?? undefined}
            required
          >
            <Input
              ref={codeRef}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
              placeholder="000000"
              key={`code-${shake}`}
              className={`text-center text-lg tracking-[0.4em] ${error ? 'animate-shake' : ''}`}
            />
          </Field>

          <Button
            type="submit"
            className="w-full"
            disabled={submitting || code.length !== 6 || !hydrated}
          >
            {submitting ? (
              <>
                <Loader2 className="animate-spin" aria-hidden="true" />
                Checking…
              </>
            ) : (
              'Sign in'
            )}
          </Button>

          <div className="flex items-center justify-between text-xs">
            <button
              type="button"
              onClick={() => {
                setStep('phone');
                setError(null);
              }}
              className="text-muted-foreground underline-offset-4 hover:underline"
            >
              Change number
            </button>

            {/* Counts down rather than disabling silently: "why is this
                greyed out" is a question a timer answers on its own. */}
            <button
              type="button"
              disabled={resendIn > 0 || submitting}
              onClick={() => void requestCode()}
              className="text-muted-foreground underline-offset-4 hover:underline disabled:no-underline disabled:opacity-60"
            >
              {resendIn > 0 ? `Resend in ${resendIn}s` : 'Resend code'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
