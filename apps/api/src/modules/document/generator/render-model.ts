/**
 * The normalised input both renderers take.
 *
 * Built once by DocumentExportService and handed to either the PDF or the DOCX
 * renderer, so the two formats cannot drift on what a document actually says —
 * the same watermark, the same signature blocks, the same verification code.
 */
import type { TipTapNode } from './tiptap-node';

export type ExportFormat = 'pdf' | 'docx';

export interface WatermarkOptions {
  /** Short — it is repeated across the page and must stay legible. */
  text: string;
  /** 0–1. Light enough to read through, dark enough to survive photocopying. */
  opacity: number;
  /** Degrees, counter-clockwise. */
  angle: number;
  /** Tile across the page rather than a single centred mark. */
  repeat: boolean;
}

export const DEFAULT_WATERMARK: Omit<WatermarkOptions, 'text'> = {
  opacity: 0.12,
  angle: -35,
  repeat: true,
};

/**
 * A place for a signature, and optionally the signature itself.
 *
 * A block with no image is the normal case: the document is printed, signed by
 * hand, and stamped. Filling `signatureImage`/`sealImage` is what turns it into
 * a pre-sealed document, which is why those come from short-lived presigned
 * URLs and never from a public path.
 */
export interface SignatureBlock {
  /** The party's role in the instrument — "Supplier", "Employer", "Director". */
  role: string;
  partyName: string;
  signatoryName?: string;
  signatoryPosition?: string;
  /** PNG/JPEG bytes of a scanned signature, when pre-applied. */
  signatureImage?: Buffer;
  /** PNG/JPEG bytes of the corporate seal. */
  sealImage?: Buffer;
  /** Renders the "M.P." seal marker even when no seal image is supplied. */
  requiresSeal?: boolean;
  /** Left blank for hand-dating when absent. */
  signedAt?: Date;
}

export interface VerificationMark {
  /** Public URL a verifier opens. */
  url: string;
  /** The HMAC token embedded in that URL, shown as text for manual entry. */
  token: string;
  /** PNG bytes of the QR code encoding `url`. */
  qrPng: Buffer;
}

export interface DocumentRenderModel {
  documentId: string;
  title: string;
  /** Issuing company, printed in the header. */
  companyName: string;
  /** Document body as editor JSON. */
  content: TipTapNode;
  generatedAt: Date;
  /** Absent for an approved document; present for anything else. */
  watermark?: WatermarkOptions;
  signatures: SignatureBlock[];
  verification?: VerificationMark;
  /** Rendered in the footer alongside the page number. */
  referenceNumber?: string;
}

export function buildWatermark(
  text: string,
  overrides: Partial<Omit<WatermarkOptions, 'text'>> = {},
): WatermarkOptions {
  return { text, ...DEFAULT_WATERMARK, ...overrides };
}
