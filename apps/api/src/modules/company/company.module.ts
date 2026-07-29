import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CompanyController } from './company.controller';
import { CompanyService } from './company.service';
import { CompanyAssetService } from './services/company-asset.service';

@Module({
  imports: [ConfigModule],
  controllers: [CompanyController],
  providers: [CompanyService, CompanyAssetService],
  exports: [CompanyService, CompanyAssetService],
})
export class CompanyModule {}
