import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TemplateModule } from '../template/template.module';
import { CompanyModule } from '../company/company.module';
import { AiEngineModule } from '../ai-engine/ai-engine.module';
import { DocumentController } from './document.controller';
import { DocumentService } from './document.service';
import { DocumentEditService } from './editing/document-edit.service';
import { DocumentCreationService } from './creation/document-creation.service';
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
 *
 * Creation pulls in three modules because a document is assembled from all of
 * them: the published template version supplies the body and its variable
 * contract, the company profile pre-fills the declared fields, and the AI engine
 * drafts when asked. Billing is not imported — BillingModule is @Global, so the
 * quota decorator on the route resolves without it.
 */
@Module({
  imports: [ConfigModule, TemplateModule, CompanyModule, AiEngineModule],
  controllers: [DocumentController, VerificationController],
  providers: [
    DocumentService,
    DocumentEditService,
    DocumentCreationService,
    BrowserService,
    PdfRenderer,
    DocxRenderer,
    DocumentExportService,
    VerificationTokenService,
  ],
  exports: [
    DocumentService,
    DocumentCreationService,
    DocumentExportService,
    VerificationTokenService,
  ],
})
export class DocumentModule {}
