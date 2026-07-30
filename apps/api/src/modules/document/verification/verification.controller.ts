import { Controller, Get, Param } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { GeneratedDocumentStatus } from '@legaltech/database';
import { PrismaService } from '../../../prisma/prisma.service';
import { VerificationTokenService } from './verification-token.service';
import { Public } from '../../auth/decorators/public.decorator';

/**
 * Public document verification — the endpoint the printed QR code resolves to.
 *
 * Public by necessity: the person checking a contract is a bank clerk or a
 * counterparty's lawyer holding a piece of paper, not a user of this platform.
 *
 * The response is therefore deliberately thin. It answers "was this issued, and
 * does it still say what it said" and nothing else: no body, no parties, no
 * amounts. Anyone can present a guessed token, and an endpoint that echoed
 * document contents back would be a disclosure channel for the entire
 * catalogue.
 */
@Controller('verify')
export class VerificationController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly verification: VerificationTokenService,
  ) {}

  @Public()
  // Unauthenticated and enumerable; the throttle is the only thing bounding a
  // brute-force attempt against the HMAC.
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get(':token')
  async verify(@Param('token') token: string) {
    const result = this.verification.verify(token);

    if (!result.valid) {
      // One shape for every failure — a forged signature and an unknown
      // document must be indistinguishable, or the endpoint confirms which
      // document ids exist.
      return { verified: false, reason: 'Document could not be verified' };
    }

    const document = await this.prisma.client.generatedDocument.findFirst({
      where: { id: result.payload.d, deletedAt: null },
      select: {
        id: true,
        title: true,
        status: true,
        content: true,
        completedAt: true,
        company: { select: { legalName: true, name: true } },
      },
    });

    if (!document) {
      return { verified: false, reason: 'Document could not be verified' };
    }

    // The token was signed against the content at issue time. If the stored
    // document has since changed, the paper in the verifier's hand is not what
    // this platform issued.
    if (!this.verification.matchesContent(result.payload, document.content)) {
      return {
        verified: false,
        reason: 'Document content does not match the issued version',
      };
    }

    return {
      verified: true,
      title: document.title,
      issuedBy: document.company.legalName ?? document.company.name,
      issuedAt: new Date(result.payload.i * 1000).toISOString(),
      approved: document.status === GeneratedDocumentStatus.COMPLETED,
      completedAt: document.completedAt,
    };
  }
}
