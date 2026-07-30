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
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { TaxonomyService } from './services/taxonomy.service';
import {
  CreateCategoryDto,
  MoveCategoryDto,
  TaxonomyTreeQuery,
  UpdateCategoryDto,
} from './dto/taxonomy.dto';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';

@Controller('taxonomy')
export class TaxonomyController {
  constructor(private readonly taxonomy: TaxonomyService) {}

  /** The tenant's navigable tree: shared catalogue plus its own categories. */
  @Get('tree')
  tree(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: TaxonomyTreeQuery,
  ) {
    return this.taxonomy.getTree(user.companyId, query.kind);
  }

  @Get('categories/:id')
  findOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.taxonomy.findOne(id, user.companyId);
  }

  @Get('categories/:id/subtree')
  subtree(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.taxonomy.listSubtree(id, user.companyId);
  }

  @Get('categories/:id/breadcrumb')
  breadcrumb(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.taxonomy.getBreadcrumb(id, user.companyId);
  }

  @Roles('OWNER', 'ADMIN')
  @Post('categories')
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateCategoryDto,
  ) {
    return this.taxonomy.createCategory(dto, user.companyId!);
  }

  @Roles('OWNER', 'ADMIN')
  @Patch('categories/:id')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateCategoryDto,
  ) {
    return this.taxonomy.updateCategory(id, dto, user.companyId!);
  }

  @Roles('OWNER', 'ADMIN')
  @Patch('categories/:id/move')
  move(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: MoveCategoryDto,
  ) {
    return this.taxonomy.moveCategory(id, dto.parentId ?? null, user.companyId!);
  }

  @Roles('OWNER', 'ADMIN')
  @Delete('categories/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.taxonomy.removeCategory(id, user.companyId!);
  }

  /**
   * Installs or refreshes the platform catalogue.
   *
   * Platform operation, not a tenant one — it writes the shared tree every
   * company sees, so it is restricted to SUPER_ADMIN and throttled hard: the
   * seed touches a few hundred rows and there is no reason to run it in a loop.
   */
  @Roles('SUPER_ADMIN')
  @Throttle({ default: { limit: 2, ttl: 60_000 } })
  @Post('seed')
  @HttpCode(HttpStatus.OK)
  seed() {
    return this.taxonomy.seedPlatformTaxonomy();
  }
}
