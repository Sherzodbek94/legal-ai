import { Controller, Get, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CounterpartyLookupService } from './counterparty-lookup.service';
import { LookupCounterpartyDto } from './dto/lookup.dto';
import { mapCounterpartyToVariables } from './utils/map-counterparty-to-variables';

@Controller('counterparties')
export class CounterpartyController {
  constructor(private readonly lookup: CounterpartyLookupService) {}

  /**
   * Whether counterparty lookup can be performed at all.
   *
   * Read once when the document form renders, so the field is offered only
   * where it works — the same arrangement as `/auth/providers`, and for the
   * same reason: a control that reveals itself unusable on click reads as a
   * fault rather than as a feature this deployment does not have.
   */
  @Get('lookup/availability')
  availability() {
    return { available: this.lookup.isAvailable() };
  }

  /**
   * Looks up the other party to a contract by STIR.
   *
   * Tighter than the global throttle because each call may be billable to this
   * deployment, and a form that fires on every keystroke would be
   * indistinguishable from abuse.
   *
   * Returns a *suggestion*. Nothing is written: the caller decides whether the
   * values become part of a document by submitting them with the rest of the
   * template variables.
   */
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get('lookup')
  async byStir(@Query() query: LookupCounterpartyDto) {
    const result = await this.lookup.findByStir(query.stir);

    // 200 with `found: false`, not 404. The lookup succeeded — the answer is
    // that nobody is registered under that number, which the form needs to
    // show inline. A 404 here would also be ambiguous with the route itself
    // being absent on an older API.
    if (!result) {
      return { found: false as const, stir: query.stir };
    }

    return {
      found: true as const,
      source: result.source,
      retrievedAt: result.retrievedAt.toISOString(),
      entity: result.entity,
      // Pre-mapped so the client submits template variables rather than
      // reimplementing the `counterparty_` naming and the prompt sanitising
      // that goes with it.
      variables: mapCounterpartyToVariables(result.entity),
    };
  }
}
