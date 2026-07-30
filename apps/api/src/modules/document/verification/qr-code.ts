/**
 * QR encoding for the printed verification mark.
 *
 * Kept as a plain function rather than a Nest provider: it has no dependencies
 * and both renderers need it, so injecting it would only add ceremony.
 */
import QRCode from 'qrcode';

export interface QrOptions {
  /** Pixel width of the square image. */
  width?: number;
  /** Quiet-zone width, in modules. */
  margin?: number;
}

/**
 * Error correction level Q (25%).
 *
 * Higher than the usual default because these codes are printed on paper that
 * gets stamped, stapled, folded, and photocopied before anyone scans it. Q
 * survives a corporate seal landing on a corner of the code; M often does not.
 */
const ERROR_CORRECTION = 'Q' as const;

export async function renderQrPng(
  text: string,
  options: QrOptions = {},
): Promise<Buffer> {
  return QRCode.toBuffer(text, {
    type: 'png',
    errorCorrectionLevel: ERROR_CORRECTION,
    width: options.width ?? 320,
    margin: options.margin ?? 1,
    color: {
      dark: '#000000ff',
      // Opaque white, not transparent: a transparent QR over the watermark
      // layer is unscannable.
      light: '#ffffffff',
    },
  });
}
