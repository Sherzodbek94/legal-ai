import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * @nestjs/common ships no 429 exception, so rate-limited paths would otherwise
 * have to hand-roll `new HttpException(..., 429)` at each call site.
 */
export class TooManyRequestsException extends HttpException {
  constructor(message = 'Too many requests') {
    super(message, HttpStatus.TOO_MANY_REQUESTS);
  }
}
