import { applyDecorators } from '@nestjs/common';
import { Matches, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * Uzbekistan business registry identifiers.
 *
 * These are *format* checks. None of them prove the identifier is registered or
 * belongs to the submitting company — that requires a lookup against the tax
 * authority (soliq.uz) or the servicing bank, which is out of scope here.
 */

/** STIR / ИНН — taxpayer identification number. Exactly 9 digits. */
export const STIR_REGEX = /^\d{9}$/;

/** MFO — servicing bank branch code. Exactly 5 digits. */
export const MFO_REGEX = /^\d{5}$/;

/** Settlement account number. Exactly 20 digits. */
export const BANK_ACCOUNT_REGEX = /^\d{20}$/;

/**
 * OKED / ОКЭД — economic activity classifier, derived from NACE Rev. 2.
 * The fully-qualified code is 5 digits (e.g. 69101, "activities of legal
 * advisers"). Shorter 2-4 digit values are parent groupings, not valid
 * primary-activity codes, so they are rejected.
 */
export const OKED_REGEX = /^\d{5}$/;

/** Strips spaces, dashes, and non-breaking spaces users paste from documents. */
function normalizeDigits(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return value.replace(/[\s -]/g, '');
}

const normalize = () => Transform(({ value }) => normalizeDigits(value));

export function IsStir() {
  return applyDecorators(
    normalize(),
    MaxLength(9),
    Matches(STIR_REGEX, { message: 'STIR must be exactly 9 digits' }),
  );
}

export function IsMfo() {
  return applyDecorators(
    normalize(),
    MaxLength(5),
    Matches(MFO_REGEX, { message: 'MFO must be exactly 5 digits' }),
  );
}

export function IsBankAccount() {
  return applyDecorators(
    normalize(),
    MaxLength(20),
    Matches(BANK_ACCOUNT_REGEX, {
      message: 'Bank account must be exactly 20 digits',
    }),
  );
}

export function IsOked() {
  return applyDecorators(
    normalize(),
    MaxLength(5),
    Matches(OKED_REGEX, { message: 'OKED must be exactly 5 digits' }),
  );
}
