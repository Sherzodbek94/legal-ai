/**
 * Builds the complete HTML page Chromium prints.
 *
 * Everything is inlined — CSS, fonts sizing, images as data URIs. The page is
 * loaded with `setContent` and never allowed to reach the network: a document
 * that silently fetches a remote stylesheet would render differently depending
 * on whether the fetch succeeded, and a legal document that renders
 * differently on different days is not a document.
 */
import { escapeHtml, tiptapToHtml } from './tiptap-to-html';
import type { DocumentRenderModel, SignatureBlock } from './render-model';

/** A4 with margins wide enough for a filing punch and a court stamp. */
const PAGE_CSS = `
@page {
  size: A4;
  margin: 22mm 18mm 24mm 24mm;
}
`;

function dataUri(image: Buffer, mime = 'image/png'): string {
  return `data:${mime};base64,${image.toString('base64')}`;
}

/**
 * The watermark layer.
 *
 * Painted as a repeating background on a fixed, non-interactive overlay rather
 * than as page content: content-flow watermarks shift with the text and end up
 * half on one page and half on the next. `position: fixed` in Chromium's print
 * context repeats the element on every printed page, which is exactly what a
 * watermark has to do.
 *
 * The mark is drawn in an inline SVG so the rotation is baked into the image
 * and does not depend on CSS transform support in the print pipeline.
 */
function watermarkCss(model: DocumentRenderModel): string {
  const { watermark } = model;
  if (!watermark) return '';

  const text = escapeHtml(watermark.text.slice(0, 40));
  const opacity = Math.min(1, Math.max(0, watermark.opacity));

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="300">
    <text x="50%" y="50%" fill="#d02f2f" fill-opacity="${opacity}"
          font-family="Helvetica, Arial, sans-serif" font-size="46" font-weight="700"
          text-anchor="middle" dominant-baseline="middle"
          transform="rotate(${watermark.angle} 210 150)">${text}</text>
  </svg>`;

  const encoded = Buffer.from(svg, 'utf8').toString('base64');

  return `
.watermark {
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  z-index: 9999;
  pointer-events: none;
  background-image: url("data:image/svg+xml;base64,${encoded}");
  background-repeat: ${watermark.repeat ? 'repeat' : 'no-repeat'};
  background-position: center;
}
`;
}

const BASE_CSS = `
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: "Times New Roman", Times, serif;
  font-size: 11.5pt;
  line-height: 1.5;
  color: #111;
}
.doc-header {
  border-bottom: 1px solid #999;
  padding-bottom: 6mm;
  margin-bottom: 8mm;
}
.doc-header .company { font-size: 10pt; letter-spacing: .04em; text-transform: uppercase; color: #444; }
.doc-header h1 { font-size: 16pt; margin: 3mm 0 0; }
.doc-header .meta { font-size: 9pt; color: #555; margin-top: 2mm; }

.doc-body p { margin: 0 0 3mm; text-align: justify; }
.doc-body h1, .doc-body h2, .doc-body h3 { margin: 6mm 0 3mm; }
.doc-body h1 { font-size: 14pt; }
.doc-body h2 { font-size: 12.5pt; }
.doc-body h3 { font-size: 11.5pt; }
.doc-body ul, .doc-body ol { margin: 0 0 3mm; padding-left: 8mm; }
.doc-body li { margin-bottom: 1.5mm; }
.doc-body blockquote {
  margin: 0 0 3mm; padding-left: 5mm; border-left: 2px solid #ccc; color: #333;
}
.doc-body pre {
  font-family: "Courier New", monospace; font-size: 9.5pt;
  background: #f6f6f6; padding: 3mm; white-space: pre-wrap;
}
.doc-body hr { border: none; border-top: 1px solid #bbb; margin: 5mm 0; }
.doc-body table {
  width: 100%; border-collapse: collapse; margin: 0 0 4mm; font-size: 10.5pt;
}
.doc-body th, .doc-body td { border: 1px solid #888; padding: 2mm; vertical-align: top; }
.doc-body th { background: #f0f0f0; font-weight: 700; }

/* Signatures must not be orphaned from the text they attest to. */
.signatures {
  margin-top: 12mm;
  page-break-inside: avoid;
  break-inside: avoid;
}
.signature-grid { display: flex; flex-wrap: wrap; gap: 10mm; }
.signature-block {
  flex: 1 1 45%;
  min-width: 70mm;
  page-break-inside: avoid;
  break-inside: avoid;
}
.signature-block .role {
  font-size: 9.5pt; text-transform: uppercase; letter-spacing: .05em;
  color: #444; border-bottom: 1px solid #333; padding-bottom: 1.5mm; margin-bottom: 3mm;
}
.signature-block .party { font-weight: 700; margin-bottom: 1mm; }
.signature-block .position { font-size: 10pt; color: #333; }
.signature-area {
  position: relative;
  height: 26mm;
  margin-top: 4mm;
  border-bottom: 1px solid #333;
}
.signature-area img.signature { max-height: 22mm; max-width: 55mm; }
.signature-area img.seal {
  position: absolute; right: 0; bottom: 0; max-height: 26mm; max-width: 26mm; opacity: .85;
}
.signature-area .seal-marker {
  position: absolute; right: 2mm; bottom: 6mm;
  width: 22mm; height: 22mm; border: 1px dashed #999; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 8pt; color: #999;
}
.signature-block .caption {
  display: flex; justify-content: space-between;
  font-size: 8.5pt; color: #666; margin-top: 1.5mm;
}

.verification {
  margin-top: 10mm; padding-top: 4mm; border-top: 1px solid #ccc;
  display: flex; gap: 5mm; align-items: center;
  page-break-inside: avoid; break-inside: avoid;
}
.verification img { width: 26mm; height: 26mm; }
.verification .text { font-size: 8.5pt; color: #555; line-height: 1.4; }
.verification .token {
  font-family: "Courier New", monospace; font-size: 8pt;
  word-break: break-all; color: #333;
}
`;

function renderSignatureBlock(block: SignatureBlock): string {
  const signature = block.signatureImage
    ? `<img class="signature" src="${dataUri(block.signatureImage)}" alt="" />`
    : '';

  const seal = block.sealImage
    ? `<img class="seal" src="${dataUri(block.sealImage)}" alt="" />`
    : block.requiresSeal
      ? '<div class="seal-marker">M.P.</div>'
      : '';

  const signedAt = block.signedAt
    ? escapeHtml(block.signedAt.toISOString().slice(0, 10))
    : '&#95;&#95;&#95;&#95; / &#95;&#95;&#95;&#95; / 20&#95;&#95;';

  return `
<div class="signature-block">
  <div class="role">${escapeHtml(block.role)}</div>
  <div class="party">${escapeHtml(block.partyName)}</div>
  ${block.signatoryPosition ? `<div class="position">${escapeHtml(block.signatoryPosition)}</div>` : ''}
  <div class="signature-area">${signature}${seal}</div>
  <div class="caption">
    <span>${escapeHtml(block.signatoryName ?? '')}</span>
    <span>${signedAt}</span>
  </div>
</div>`;
}

function renderVerification(model: DocumentRenderModel): string {
  const { verification } = model;
  if (!verification) return '';

  return `
<div class="verification">
  <img src="${dataUri(verification.qrPng)}" alt="Verification QR code" />
  <div class="text">
    <div><strong>Verify this document</strong></div>
    <div>Scan the code or open ${escapeHtml(verification.url.split('?')[0])}</div>
    <div class="token">${escapeHtml(verification.token)}</div>
  </div>
</div>`;
}

export function buildDocumentHtml(model: DocumentRenderModel): string {
  const body = tiptapToHtml(model.content);

  const signatures = model.signatures.length
    ? `<section class="signatures">
         <div class="signature-grid">${model.signatures.map(renderSignatureBlock).join('')}</div>
       </section>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(model.title)}</title>
<style>${PAGE_CSS}${BASE_CSS}${watermarkCss(model)}</style>
</head>
<body>
${model.watermark ? '<div class="watermark"></div>' : ''}
<header class="doc-header">
  <div class="company">${escapeHtml(model.companyName)}</div>
  <h1>${escapeHtml(model.title)}</h1>
  <div class="meta">
    ${model.referenceNumber ? `No. ${escapeHtml(model.referenceNumber)} &middot; ` : ''}
    ${escapeHtml(model.generatedAt.toISOString().slice(0, 10))}
  </div>
</header>
<main class="doc-body">${body}</main>
${signatures}
${renderVerification(model)}
</body>
</html>`;
}

/** Running footer, rendered by Chromium's print pipeline rather than the page. */
export function buildFooterHtml(model: DocumentRenderModel): string {
  const reference = model.referenceNumber
    ? `${escapeHtml(model.referenceNumber)} &middot; `
    : '';

  return `<div style="width:100%;font-family:Helvetica,Arial,sans-serif;font-size:7pt;color:#777;padding:0 18mm;display:flex;justify-content:space-between;">
    <span>${reference}${escapeHtml(model.title)}</span>
    <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
  </div>`;
}
