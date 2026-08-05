import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseFilePipeBuilder,
  Patch,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CompanyAssetType } from '@legaltech/database';
import { CompanyService } from './company.service';
import {
  CompanyAssetService,
  type UploadedFileLike,
} from './services/company-asset.service';
import { CreateCompanyDto, UpdateCompanyDto } from './dto/company.dto';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';

/** Hard ceiling enforced by multer before the buffer is ever materialised. */
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

@Controller('companies')
export class CompanyController {
  constructor(
    private readonly companyService: CompanyService,
    private readonly assetService: CompanyAssetService,
  ) {}

  // Every read and write below is scoped to the caller's tenant. Without that,
  // @Roles('OWNER') only asks whether the caller is *an* owner — not an owner of
  // this company.
  @Get()
  findAll(@CurrentUser() user: AuthenticatedUser) {
    return this.companyService.findAll(user.companyId!);
  }

  @Get(':id')
  findOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.companyService.findOne(id, user.companyId!);
  }

  @Roles('OWNER', 'ADMIN')
  @Post()
  create(@Body() dto: CreateCompanyDto) {
    return this.companyService.create(dto);
  }

  @Roles('OWNER', 'ADMIN')
  @Patch(':id')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateCompanyDto,
  ) {
    return this.companyService.update(id, dto, user.companyId!);
  }

  @Roles('OWNER')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.companyService.softDelete(id, user.companyId!);
  }

  /** Prompt variables plus any required fields still missing. */
  @Get(':id/variables')
  getVariables(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.companyService.getPromptVariables(id, user.companyId!);
  }

  // -------------------------------------------------------------------------
  // Corporate seals and digital signatures
  // -------------------------------------------------------------------------

  @Roles('OWNER', 'ADMIN')
  @Post(':id/assets/:type')
  @UseInterceptors(
    // memoryStorage keeps the bytes off disk entirely; nothing untrusted is
    // ever written to the filesystem, and the limit is enforced during upload
    // rather than after a full file has been buffered.
    FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } }),
  )
  uploadAsset(
    @Param('type') type: CompanyAssetType,
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile(
      new ParseFilePipeBuilder()
        .addMaxSizeValidator({ maxSize: MAX_UPLOAD_BYTES })
        .build({ errorHttpStatusCode: HttpStatus.PAYLOAD_TOO_LARGE }),
    )
    file: UploadedFileLike,
  ) {
    return this.assetService.upload(user.companyId!, type, file, user?.id);
  }

  @Get(':id/assets')
  listAssets(@CurrentUser() user: AuthenticatedUser) {
    return this.assetService.listForCompany(user.companyId!);
  }

  /** Returns a short-lived presigned URL; the bucket is never public. */
  @Get(':id/assets/:assetId/download-url')
  getAssetUrl(
    @CurrentUser() user: AuthenticatedUser,
    @Param('assetId') assetId: string,
  ) {
    return this.assetService.getDownloadUrl(user.companyId!, assetId);
  }

  @Roles('OWNER', 'ADMIN')
  @Delete(':id/assets/:assetId')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeAsset(
    @CurrentUser() user: AuthenticatedUser,
    @Param('assetId') assetId: string,
  ) {
    return this.assetService.remove(user.companyId!, assetId);
  }
}
