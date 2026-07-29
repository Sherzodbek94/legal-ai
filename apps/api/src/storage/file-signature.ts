/**
 * Magic-byte sniffing for the narrow set of formats we accept.
 *
 * A client-supplied `Content-Type` or file extension is an assertion, not
 * evidence — trusting either is how a polyglot or a renamed executable ends up
 * in the bucket. This inspects the actual leading bytes instead.
 *
 * Hand-rolled rather than using `file-type`: that package has been ESM-only
 * since v17 and this service compiles to CommonJS. The accepted set is small
 * enough that a table is clearer than an interop shim.
 */

export type DetectedMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'application/pdf';

interface Signature {
  mime: DetectedMime;
  offset: number;
  bytes: number[];
  /** Extra predicate for containers whose prefix alone is ambiguous. */
  verify?: (buf: Buffer) => boolean;
}

const SIGNATURES: Signature[] = [
  { mime: 'image/png', offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'image/jpeg', offset: 0, bytes: [0xff, 0xd8, 0xff] },
  {
    mime: 'image/webp',
    offset: 0,
    bytes: [0x52, 0x49, 0x46, 0x46], // "RIFF"
    // RIFF is a generic container (AVI, WAV); require the WEBP form type.
    verify: (buf) => buf.length >= 12 && buf.toString('ascii', 8, 12) === 'WEBP',
  },
  { mime: 'application/pdf', offset: 0, bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] }, // "%PDF-"
];

function matches(buf: Buffer, sig: Signature): boolean {
  if (buf.length < sig.offset + sig.bytes.length) return false;
  for (let i = 0; i < sig.bytes.length; i++) {
    if (buf[sig.offset + i] !== sig.bytes[i]) return false;
  }
  return sig.verify ? sig.verify(buf) : true;
}

/** Returns the detected MIME type, or null if the bytes match nothing allowed. */
export function detectMimeType(buf: Buffer): DetectedMime | null {
  for (const sig of SIGNATURES) {
    if (matches(buf, sig)) return sig.mime;
  }
  return null;
}

/**
 * SVG is deliberately absent from the accepted list: it is XML, can carry
 * <script>, and would execute if ever served from our origin. Raster only.
 */
export const SEAL_SIGNATURE_MIMES: DetectedMime[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
];
