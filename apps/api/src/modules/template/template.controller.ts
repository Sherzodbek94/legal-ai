import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UnprocessableEntityException,
} from '@nestjs/common';
import { TemplateService } from './services/template.service';
import { TemplateVersionService } from './services/template-version.service';
import {
  CreateTemplateDto,
  ListTemplatesQuery,
  MoveTemplateDto,
  UpdateTemplateDto,
} from './dto/template.dto';
import {
  CreateVersionDto,
  PublishVersionDto,
  RollbackDto,
  ValidateVariablesDto,
} from './dto/version.dto';
import { parseVariableSchema } from './validation/variable-schema';
import { validateVariableValues } from './validation/variable-values';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';

@Controller('templates')
export class TemplateController {
  constructor(
    private readonly templates: TemplateService,
    private readonly versions: TemplateVersionService,
  ) {}

  // ---------------------------------------------------------------------------
  // Templates
  // ---------------------------------------------------------------------------

  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListTemplatesQuery,
  ) {
    return this.templates.list(query, user.companyId!);
  }

  @Get(':id')
  findOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.templates.findOne(id, user.companyId!);
  }

  @Roles('OWNER', 'ADMIN', 'ATTORNEY')
  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateTemplateDto,
  ) {
    return this.templates.create(dto, user);
  }

  @Roles('OWNER', 'ADMIN', 'ATTORNEY')
  @Patch(':id')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateTemplateDto,
  ) {
    return this.templates.update(id, dto, user);
  }

  @Roles('OWNER', 'ADMIN', 'ATTORNEY')
  @Patch(':id/category')
  move(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: MoveTemplateDto,
  ) {
    return this.templates.move(id, dto, user);
  }

  @Roles('OWNER', 'ADMIN')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.templates.softDelete(id, user);
  }

  // ---------------------------------------------------------------------------
  // Versions
  // ---------------------------------------------------------------------------

  @Get(':id/versions')
  listVersions(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.versions.listVersions(id, user.companyId!);
  }

  @Get(':id/versions/published')
  publishedVersion(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.versions.getPublishedVersion(id, user.companyId!);
  }

  @Get(':id/versions/:versionId')
  getVersion(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('versionId') versionId: string,
  ) {
    return this.versions.getVersion(id, versionId, user.companyId!);
  }

  @Roles('OWNER', 'ADMIN', 'ATTORNEY')
  @Post(':id/versions')
  createVersion(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: CreateVersionDto,
  ) {
    return this.versions.createDraft(id, dto, user);
  }

  /** Publishing decides what every future document is generated from. */
  @Roles('OWNER', 'ADMIN')
  @Post(':id/versions/:versionId/publish')
  @HttpCode(HttpStatus.OK)
  publish(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('versionId') versionId: string,
    @Body() dto: PublishVersionDto,
  ) {
    return this.versions.publish(id, versionId, dto, user);
  }

  @Roles('OWNER', 'ADMIN')
  @Post(':id/versions/rollback')
  @HttpCode(HttpStatus.OK)
  rollback(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: RollbackDto,
  ) {
    return this.versions.rollback(id, dto, user);
  }

  /**
   * Dry-runs variable values against a version's schema.
   *
   * Lets the editor show field-level errors before a generation call is spent,
   * which is the expensive part of the pipeline.
   */
  @Post(':id/versions/:versionId/validate-variables')
  @HttpCode(HttpStatus.OK)
  async validateVariables(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('versionId') versionId: string,
    @Body() dto: ValidateVariablesDto,
  ) {
    const version = await this.versions.getVersion(id, versionId, user.companyId!);

    const schema = parseVariableSchema(version.variableSchema);
    const result = validateVariableValues(schema, dto.values);

    if (!result.ok) {
      throw new UnprocessableEntityException({
        message: 'Variable values do not satisfy the template contract',
        issues: result.issues,
      });
    }

    return { ok: true, values: result.values };
  }
}
