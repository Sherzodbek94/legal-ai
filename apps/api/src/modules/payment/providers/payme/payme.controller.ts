import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { PaymeService } from './payme.service';
import {
  PaymeError,
  PaymeErrorCode,
  paymeFailure,
  paymeSuccess,
  type PaymeRpcRequest,
} from './payme-errors';
import { Public } from '../../../auth/decorators/public.decorator';

/**
 * Payme Merchant API endpoint — a single JSON-RPC 2.0 route.
 *
 * Always HTTP 200. JSON-RPC carries failure in the envelope, and Payme's
 * certification explicitly checks that an authentication failure comes back as
 * `error: -32504` at status 200 rather than as a 401.
 *
 * The body is typed as `unknown` and validated here rather than by a DTO: the
 * global ValidationPipe would reject a malformed envelope with a 400, when the
 * protocol requires a `-32600` in a well-formed JSON-RPC response.
 */
@Controller('payments/payme')
export class PaymeController {
  private readonly logger = new Logger(PaymeController.name);

  constructor(private readonly payme: PaymeService) {}

  @Public()
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Post()
  @HttpCode(HttpStatus.OK)
  async handle(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
  ) {
    const request = (body ?? {}) as PaymeRpcRequest;
    const id = request.id ?? null;

    try {
      // Authentication first, before the envelope is even inspected: an
      // unauthenticated caller must not be able to probe which methods exist.
      this.payme.authorize(authorization);

      if (typeof request.method !== 'string' || !request.method) {
        throw new PaymeError(PaymeErrorCode.INVALID_REQUEST);
      }

      const result = await this.payme.dispatch(request.method, request.params);
      return paymeSuccess(id, result);
    } catch (error) {
      if (error instanceof PaymeError) {
        return paymeFailure(id, error.toRpcError());
      }

      // An unexpected failure must still be a valid JSON-RPC envelope, or Payme
      // reports a protocol violation on top of whatever actually broke.
      this.logger.error(
        `Payme handler failed for method ${request.method}: ${
          (error as Error)?.message ?? 'unknown error'
        }`,
        (error as Error)?.stack,
      );

      return paymeFailure(
        id,
        new PaymeError(PaymeErrorCode.INTERNAL_ERROR).toRpcError(),
      );
    }
  }
}
