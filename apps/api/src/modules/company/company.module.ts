import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CompanyController } from './company.controller';
import { InvitationController, MemberController } from './member.controller';
import { CompanyService } from './company.service';
import { CompanyAssetService } from './services/company-asset.service';
import { MemberService } from './services/member.service';

@Module({
  imports: [ConfigModule],
  /**
   * MemberController FIRST.
   *
   * Nest registers routes in the order controllers are listed here, and
   * `CompanyController` declares `@Get(':id')`. Listed after it,
   * `GET /companies/members` is captured as `:id = "members"` — which returned
   * HTTP 200 with an empty body, because the lookup is tenant-scoped and no
   * company has that id. A silent empty list, not an error.
   *
   * The same ordering rule is noted in `NotificationController`, where
   * `preferences` would otherwise be swallowed by `:id/read`.
   */
  controllers: [MemberController, InvitationController, CompanyController],
  providers: [CompanyService, CompanyAssetService, MemberService],
  exports: [CompanyService, CompanyAssetService, MemberService],
})
export class CompanyModule {}
