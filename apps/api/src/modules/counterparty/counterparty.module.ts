import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HttpModule } from '@nestjs/axios';
import { CounterpartyController } from './counterparty.controller';
import { CounterpartyLookupService } from './counterparty-lookup.service';
import { IHamkorProvider } from './providers/ihamkor.provider';
import { COUNTERPARTY_REGISTRY_PROVIDER } from './providers/registry-provider';

/**
 * Counterparty registry lookup.
 *
 * The provider is bound through a token rather than injected concretely, so
 * swapping iHamkor for a bank's own feed or direct tax-authority access is one
 * line here and nothing anywhere else.
 *
 * `maxRedirects: 0` matches the other outbound integrations: a redirect from a
 * credentialed API call is not something to follow silently, since it can move
 * the bearer token to a host that was never configured.
 */
@Module({
  imports: [ConfigModule, HttpModule.register({ timeout: 10_000, maxRedirects: 0 })],
  controllers: [CounterpartyController],
  providers: [
    CounterpartyLookupService,
    IHamkorProvider,
    { provide: COUNTERPARTY_REGISTRY_PROVIDER, useExisting: IHamkorProvider },
  ],
  exports: [CounterpartyLookupService],
})
export class CounterpartyModule {}
