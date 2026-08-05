import { IsStir } from '../../company/validators/uz-identifiers';

/**
 * `IsStir` rather than a bare string: it strips the spaces and dashes people
 * paste out of scanned contracts, and rejects anything that is not nine digits
 * before it reaches a billable provider call.
 */
export class LookupCounterpartyDto {
  @IsStir()
  stir!: string;
}
