/**
 * Neutralises a caller-supplied value before it reaches an LLM prompt.
 *
 * Shared by every source of prompt variables — company profile fields and
 * template variable input alike. Both are user-controlled and flow into the
 * same prompt, so they get the same treatment; duplicating this logic per
 * module is how one copy quietly drifts and becomes the hole.
 *
 * This cannot make injection impossible on its own — the durable defences are
 * delimiting the data and instructing the model to treat it as data — but it
 * removes the characters used to break out of a delimited block.
 */

/**
 * C0 and C1 control characters - includes the newlines an attacker would use
 * to forge what looks like a new instruction line in the prompt.
 *
 * Built with `new RegExp` from escaped strings so this file stays pure ASCII:
 * literal control characters in source are invisible in review and get
 * silently mangled by editors and diff tools.
 */
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001F\\u007F-\\u009F]', 'g');

/**
 * Zero-width and bidirectional-override characters. Invisible to a human
 * reviewing the value, but still tokenised by the model and usable to disguise
 * injected text.
 */
const INVISIBLE_CHARS = new RegExp(
  '[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\uFEFF]',
  'g',
);

/** Characters that could terminate a delimited variable block in a prompt. */
const DELIMITER_CHARS = /[{}[\]<>]/g;

export const DEFAULT_MAX_VALUE_LENGTH = 500;

export function sanitizePromptValue(
  value: string,
  maxLength: number = DEFAULT_MAX_VALUE_LENGTH,
): string {
  return value
    .replace(CONTROL_CHARS, ' ')
    .replace(INVISIBLE_CHARS, '')
    .replace(DELIMITER_CHARS, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, maxLength)
    .trim();
}
