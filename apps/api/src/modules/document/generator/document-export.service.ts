import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Readable } from 'node:stream';
import {
  CompanyAssetType,
  GeneratedDocumentStatus,
  type Company,
} from '@legaltech/database';
import { PrismaService } from '../../../prisma/prisma.service';
import { S3StorageService } from '../../../storage/s3-storage.service';
import { PdfRenderer } from './pdf.renderer';
import { DocxRenderer } from './docx.renderer';
import { VerificationTokenService } from '../verification/verification-token.service';
import { renderQrPng } from '../verification/qr-code';
import {
  buildWatermark,
  type DocumentRenderModel,
  type ExportFormat,
  type SignatureBlock,
} from './render-model';
import type { TipTapNode } from './tiptap-node';
import type { ExportDocumentQuery } from '../dto/export.dto';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';

export interface ExportResult {
  stream: Readable;
  filename: string;
  contentType: string;
}

const CONTENT_TYPE: Record<ExportFormat, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

/**
 * Watermark applied to anything that has not cleared its approval chain.
 *
 * The failure this prevents is mundane and expensive: a draft circulated by
 * email, mistaken for final, and acted on. Marking it is not decoration.
 */
const UNAPPROVED_WATERMARK = 'DRAFT — NOT APPROVED';

@Injectable()
export class DocumentExportService {
  private readonly logger = new Logger(DocumentExportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: S3StorageService,
    private readonly pdf: PdfRenderer,
    private readonly docx: DocxRenderer,
    private readonly verification: VerificationTokenService,
  ) {}

  async export(
    documentId: string,
    format: ExportFormat,
    query: ExportDocumentQuery,
    user: AuthenticatedUser,
  ): Promise<ExportResult> {
    const model = await this.buildRenderModel(documentId, query, user);

    const stream =
      format === 'pdf'
        ? await this.pdf.renderToStream(model)
        : await this.docx.toStream(model);

    return {
      stream,
      filename: this.filenameFor(model, format),
      contentType: CONTENT_TYPE[format],
    };
  }

  /**
   * Assembles everything the renderers need.
   *
   * Deliberately does all the policy here rather than in the renderers: whether
   * a document gets a watermark, a seal, or a verification code is a legal
   * question about its state, and having two renderers each answer it is how
   * the PDF and the Word copy end up disagreeing about whether a contract is
   * approved.
   */
  async buildRenderModel(
    documentId: string,
    query: ExportDocumentQuery,
    user: AuthenticatedUser,
  ): Promise<DocumentRenderModel> {
    const document = await this.prisma.client.generatedDocument.findFirst({
      where: { id: documentId, companyId: user.companyId, deletedAt: null },
      include: { company: true },
    });

    if (!document) {
      throw new NotFoundException('Document not found');
    }
    if (!document.content) {
      throw new NotFoundException('Document has no content to export');
    }

    const isApproved = document.status === GeneratedDocumentStatus.COMPLETED;
    const content = document.content as unknown as TipTapNode;

    return {
      documentId: document.id,
      title: document.title,
      companyName: document.company.legalName ?? document.company.name,
      content,
      generatedAt: document.generatedAt ?? document.createdAt,
      referenceNumber: document.id.slice(-8).toUpperCase(),
      watermark: this.resolveWatermark(isApproved, query),
      signatures: await this.buildSignatures(document.company, isApproved, query),
      verification: isApproved
        ? await this.buildVerification(document.id, content)
        : undefined,
    };
  }

  /**
   * An unapproved document is always watermarked, and the caller cannot turn
   * that off — only relabel it. Making the mark optional would mean the one
   * request that matters (someone exporting a draft to send onward) is exactly
   * the one that omits it.
   */
  private resolveWatermark(
    isApproved: boolean,
    query: ExportDocumentQuery,
  ): DocumentRenderModel['watermark'] {
    if (!isApproved) {
      return buildWatermark(query.watermark ?? UNAPPROVED_WATERMARK);
    }
    return query.watermark ? buildWatermark(query.watermark) : undefined;
  }

  /**
   * Signature blocks for the issuing company and, where the document names one,
   * the counterparty.
   *
   * Seal and signature images are only ever embedded into an approved document,
   * and only when explicitly asked for. A scan of a corporate seal is
   * forgery-grade material: baking it into every draft export would put a
   * usable seal into the hands of anyone who can trigger a download.
   */
  private async buildSignatures(
    company: Company,
    isApproved: boolean,
    query: ExportDocumentQuery,
  ): Promise<SignatureBlock[]> {
    const blocks: SignatureBlock[] = [
      {
        role: 'For the company',
        partyName: company.legalName ?? company.name,
        signatoryName: company.directorName ?? undefined,
        signatoryPosition: company.directorPosition ?? 'Director',
        requiresSeal: true,
      },
      {
        role: 'Counterparty',
        partyName: query.counterpartyName ?? '',
        signatoryPosition: query.counterpartyPosition,
        requiresSeal: true,
      },
    ];

    if (!query.applySeal) return blocks;

    if (!isApproved) {
      throw new ForbiddenException(
        'A seal can only be applied to a document that has completed approval',
      );
    }

    const [signature, seal] = await Promise.all([
      this.loadAsset(company.id, CompanyAssetType.SIGNATURE),
      this.loadAsset(company.id, CompanyAssetType.SEAL),
    ]);

    blocks[0] = {
      ...blocks[0],
      signatureImage: signature,
      sealImage: seal,
      signedAt: new Date(),
    };

    return blocks;
  }

  private async loadAsset(
    companyId: string,
    type: CompanyAssetType,
  ): Promise<Buffer | undefined> {
    const asset = await this.prisma.client.companyAsset.findFirst({
      where: { companyId, type, deletedAt: null },
      orderBy: { uploadedAt: 'desc' },
      select: { storageKey: true },
    });

    if (!asset) return undefined;

    try {
      return await this.storage.getObjectBytes(asset.storageKey);
    } catch (error) {
      // A missing seal must not fail the export — the document still renders
      // with an empty seal marker, which is what an unsealed copy looks like.
      this.logger.warn(
        `Could not load ${type} for company ${companyId}: ${
          (error as Error)?.message ?? 'unknown error'
        }`,
      );
      return undefined;
    }
  }

  private async buildVerification(documentId: string, content: unknown) {
    const token = this.verification.sign(documentId, content);
    const url = this.verification.buildVerificationUrl(token);

    return { url, token, qrPng: await renderQrPng(url) };
  }

  private filenameFor(model: DocumentRenderModel, format: ExportFormat): string {
    // Filenames end up in a Content-Disposition header; anything outside this
    // set is a header-injection or path-traversal opportunity.
    const safeTitle =
      model.title
        .normalize('NFKD')
        .replace(/[^\w\s-]/g, '')
        .trim()
        .replace(/\s+/g, '-')
        .slice(0, 80) || 'document';

    return `${safeTitle}-${model.referenceNumber}.${format}`;
  }
}
