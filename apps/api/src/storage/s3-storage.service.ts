import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash, randomUUID } from 'node:crypto';

export interface StoredObject {
  storageKey: string;
  checksum: string;
  sizeBytes: number;
}

@Injectable()
export class S3StorageService {
  private readonly logger = new Logger(S3StorageService.name);
  private readonly client: S3Client;

  constructor(private readonly config: ConfigService) {
    const endpoint = this.config.get<string>('S3_ENDPOINT');

    this.client = new S3Client({
      region: this.config.get<string>('S3_REGION', 'us-east-1'),
      ...(endpoint
        ? // Custom endpoint implies a MinIO/Ceph-style deployment, which
          // requires path-style addressing.
          { endpoint, forcePathStyle: true }
        : {}),
      credentials: {
        accessKeyId: this.config.getOrThrow<string>('S3_ACCESS_KEY_ID'),
        secretAccessKey: this.config.getOrThrow<string>('S3_SECRET_ACCESS_KEY'),
      },
    });
  }

  private get bucket(): string {
    return this.config.getOrThrow<string>('S3_BUCKET_NAME');
  }

  /**
   * Builds an object key that is unguessable and cannot escape its prefix.
   *
   * The uploaded filename never contributes: it is attacker-controlled and
   * would otherwise permit traversal (`../`) or collisions between tenants.
   */
  buildKey(companyId: string, kind: string, extension: string): string {
    const safeKind = kind.toLowerCase().replace(/[^a-z0-9-]/g, '');
    const safeExt = extension.toLowerCase().replace(/[^a-z0-9]/g, '');
    return `companies/${companyId}/${safeKind}/${randomUUID()}.${safeExt}`;
  }

  async putObject(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<StoredObject> {
    const checksum = createHash('sha256').update(body).digest('hex');

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        // Encrypt at rest. Seals and signatures are forgery-grade material.
        ServerSideEncryption: 'AES256',
        // Force download semantics; a stored file must never be interpreted as
        // a document in a browser context.
        ContentDisposition: 'attachment',
        Metadata: { checksum },
      }),
    );

    return { storageKey: key, checksum, sizeBytes: body.byteLength };
  }

  /**
   * Time-limited read URL. The bucket itself stays private — there is no
   * public path to these objects.
   */
  async getSignedDownloadUrl(key: string, expiresInSeconds = 300): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: expiresInSeconds },
    );
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }
}
