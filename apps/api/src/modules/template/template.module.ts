import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { TemplateController } from './template.controller';
import { TaxonomyController } from './taxonomy.controller';
import { ApprovalController } from './approval.controller';
import { TemplateService } from './services/template.service';
import { TaxonomyService } from './services/taxonomy.service';
import { TemplateVersionService } from './services/template-version.service';
import { ApprovalService } from './services/approval.service';

/**
 * Template Taxonomy Engine.
 *
 * Three concerns that only make sense together:
 *   * the taxonomy that classifies the catalogue,
 *   * immutable versions of each template, and
 *   * the approval chain a document generated from a version must clear.
 *
 * Services are exported because document generation needs the published
 * version and its variable contract.
 */
@Module({
  imports: [PrismaModule],
  controllers: [TaxonomyController, TemplateController, ApprovalController],
  providers: [
    TaxonomyService,
    TemplateService,
    TemplateVersionService,
    ApprovalService,
  ],
  exports: [TaxonomyService, TemplateService, TemplateVersionService, ApprovalService],
})
export class TemplateModule {}
