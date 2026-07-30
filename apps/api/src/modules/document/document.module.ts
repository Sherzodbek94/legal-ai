import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DocumentController } from './document.controller';
import { DocumentService } from './document.service';
import { BrowserService } from './generator/browser.service';
import { PdfRenderer } from './generator/pdf.renderer';
import { DocxRenderer } from './generator/docx.renderer';
import { DocumentExportService } from './generator/document-export.service';
import { VerificationTokenService } from './verification/verification-token.service';
import { VerificationController } from './verification/verification.controller';

/**
 * Document Generator Engine.
 *
 * Renders a stored document to PDF (Chromium) or DOCX (native Word XML), both
 * from the same render model, and issues the HMAC verification code printed on
 * the output.
 *
 * BrowserService holds the Chromium process, so it is a singleton here and
 * closes on module destroy — the app must not leave an orphaned browser behind
 * on shutdown.
 */
@Module({
  imports: [ConfigModule],
  controllers: [DocumentController, VerificationController],
  providers: [
    DocumentService,
    BrowserService,
    PdfRenderer,
    DocxRenderer,
    DocumentExportService,
    VerificationTokenService,
  ],
  exports: [DocumentService, DocumentExportService, VerificationTokenService],
})
export class DocumentModule {}
