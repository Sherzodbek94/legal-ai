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

  @Get()
  findAll() {
    return this.companyService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.companyService.findOne(id);
  }

  @Roles('OWNER', 'ADMIN')
  @Post()
  create(@Body() dto: CreateCompanyDto) {
    return this.companyService.create(dto);
  }

  @Roles('OWNER', 'ADMIN')
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateCompanyDto) {
    return this.companyService.update(id, dto);
  }

  @Roles('OWNER')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string) {
    return this.companyService.softDelete(id);
  }

  /** Prompt variables plus any required fields still missing. */
  @Get(':id/variables')
  getVariables(@Param('id') id: string) {
    return this.companyService.getPromptVariables(id);
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
    @Param('id') id: string,
    @Param('type') type: CompanyAssetType,
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile(
      new ParseFilePipeBuilder()
        .addMaxSizeValidator({ maxSize: MAX_UPLOAD_BYTES })
        .build({ errorHttpStatusCode: HttpStatus.PAYLOAD_TOO_LARGE }),
    )
    file: UploadedFileLike,
  ) {
    return this.assetService.upload(id, type, file, user?.id);
  }

  @Get(':id/assets')
  listAssets(@Param('id') id: string) {
    return this.assetService.listForCompany(id);
  }

  /** Returns a short-lived presigned URL; the bucket is never public. */
  @Get(':id/assets/:assetId/download-url')
  getAssetUrl(@Param('id') id: string, @Param('assetId') assetId: string) {
    return this.assetService.getDownloadUrl(id, assetId);
  }

  @Roles('OWNER', 'ADMIN')
  @Delete(':id/assets/:assetId')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeAsset(@Param('id') id: string, @Param('assetId') assetId: string) {
    return this.assetService.remove(id, assetId);
  }
}
