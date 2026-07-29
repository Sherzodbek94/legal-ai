import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CompanyAssetType } from '@legaltech/database';
import { PrismaService } from '../../../prisma/prisma.service';
import { S3StorageService } from '../../../storage/s3-storage.service';
import {
  detectMimeType,
  SEAL_SIGNATURE_MIMES,
  type DetectedMime,
} from '../../../storage/file-signature';

/** Multer's in-memory file shape, narrowed to what we actually use. */
export interface UploadedFileLike {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

const EXTENSION_BY_MIME: Record<DetectedMime, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

@Injectable()
export class CompanyAssetService {
  private readonly logger = new Logger(CompanyAssetService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: S3StorageService,
    private readonly config: ConfigService,
  ) {}

  private get maxBytes(): number {
    return this.config.get<number>('COMPANY_ASSET_MAX_BYTES', 5 * 1024 * 1024);
  }

  async upload(
    companyId: string,
    type: CompanyAssetType,
    file: UploadedFileLike,
    uploadedById?: string,
  ) {
    if (!file?.buffer?.length) {
      throw new BadRequestException('No file content received');
    }

    if (file.size > this.maxBytes) {
      throw new PayloadTooLargeException(
        `File exceeds the ${Math.floor(this.maxBytes / 1024 / 1024)}MB limit`,
      );
    }

    // Trust the bytes, not the declared Content-Type or the extension.
    const detected = detectMimeType(file.buffer);
    if (!detected || !SEAL_SIGNATURE_MIMES.includes(detected)) {
      throw new UnsupportedMediaTypeException(
        'File must be a PNG, JPEG, or WebP image',
      );
    }

    const company = await this.prisma.client.company.findFirst({
      where: { id: companyId, deletedAt: null },
      select: { id: true },
    });
    if (!company) {
      throw new NotFoundException('Company not found');
    }

    const key = this.storage.buildKey(
      companyId,
      type,
      EXTENSION_BY_MIME[detected],
    );
    const stored = await this.storage.putObject(key, file.buffer, detected);

    // Supersede any previous asset of this type. The old row is soft-deleted
    // rather than dropped so the audit trail still shows what was in force when
    // earlier documents were generated.
    const [, created] = await this.prisma.client.$transaction([
      this.prisma.client.companyAsset.updateMany({
        where: { companyId, type, deletedAt: null },
        data: { deletedAt: new Date() },
      }),
      this.prisma.client.companyAsset.create({
        data: {
          companyId,
          type,
          storageKey: stored.storageKey,
          contentType: detected,
          sizeBytes: stored.sizeBytes,
          checksum: stored.checksum,
          // Retained for display only; never used to build the object key.
          originalName: file.originalname?.slice(0, 255),
          uploadedById,
        },
      }),
    ]);

    return this.toPublicShape(created);
  }

  async listForCompany(companyId: string) {
    const assets = await this.prisma.client.companyAsset.findMany({
      where: { companyId, deletedAt: null },
      orderBy: { uploadedAt: 'desc' },
    });
    return assets.map((asset) => this.toPublicShape(asset));
  }

  /** Issues a short-lived URL; the bucket has no public read path. */
  async getDownloadUrl(companyId: string, assetId: string) {
    const asset = await this.prisma.client.companyAsset.findFirst({
      // Scoped by companyId so an id from another tenant cannot be fetched.
      where: { id: assetId, companyId, deletedAt: null },
    });

    if (!asset) {
      throw new NotFoundException('Asset not found');
    }

    const url = await this.storage.getSignedDownloadUrl(asset.storageKey, 300);
    return { url, expiresIn: 300 };
  }

  async remove(companyId: string, assetId: string) {
    const asset = await this.prisma.client.companyAsset.findFirst({
      where: { id: assetId, companyId, deletedAt: null },
      select: { id: true },
    });
    if (!asset) {
      throw new NotFoundException('Asset not found');
    }

    // Soft delete only. The object stays in the bucket because generated
    // documents may still reference the seal that signed them; lifecycle
    // rules on the bucket handle eventual expiry.
    await this.prisma.client.companyAsset.update({
      where: { id: assetId },
      data: { deletedAt: new Date() },
    });
  }

  /** Strips the storage key — clients get presigned URLs, never raw keys. */
  private toPublicShape(asset: {
    id: string;
    type: CompanyAssetType;
    contentType: string;
    sizeBytes: number;
    checksum: string;
    originalName: string | null;
    uploadedAt: Date;
  }) {
    return {
      id: asset.id,
      type: asset.type,
      contentType: asset.contentType,
      sizeBytes: asset.sizeBytes,
      checksum: asset.checksum,
      originalName: asset.originalName,
      uploadedAt: asset.uploadedAt,
    };
  }
}
