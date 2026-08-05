/**
 * DevSMS delivery.
 *
 * Two properties carry the weight here. The first is that a refusal is
 * recognised as one: DevSMS answers `{"success": false}` and does not promise a
 * non-2xx status with it, so a client that reads only the status code reports a
 * message as sent that the gateway never accepted — and for an OTP that is a
 * user locked out with nothing in any log. The second is failure
 * classification, because a permanent failure retried five times is five
 * billable attempts.
 */
import { of, throwError } from 'rxjs';
import { Logger } from '@nestjs/common';
import type { HttpService } from '@nestjs/axios';
import type { ConfigService } from '@nestjs/config';
import { DevSmsService } from './devsms.service';
import { DeliveryError } from './delivery-error';

const SEND_OK = {
  success: true,
  message: 'SMS muvaffaqiyatli yuborildi',
  data: {
    sms_id: 123,
    request_id: 'req-uuid',
    status: 'sent',
    parts_count: 1,
    total_cost: 50,
    balance: 950,
  },
};

function build(
  config: Record<string, string> = { DEVSMS_TOKEN: 'test-token' },
  response: unknown = SEND_OK,
) {
  const post = jest.fn((..._args: unknown[]) => of({ data: response }));
  const get = jest.fn((..._args: unknown[]) => of({ data: response }));

  const service = new DevSmsService(
    { post, get } as unknown as HttpService,
    {
      get: (key: string, fallback?: string) => config[key] ?? fallback ?? '',
    } as unknown as ConfigService,
  );

  return { service, post, get };
}

/** An axios-shaped rejection, which is what `toDeliveryError` reads. */
function httpError(status: number, body?: unknown) {
  return throwError(() => ({
    response: { status, data: body, headers: {} },
    message: `HTTP ${status}`,
  }));
}

describe('DevSmsService', () => {
  describe('configuration', () => {
    it('is unconfigured without a token', () => {
      expect(build({}).service.isConfigured()).toBe(false);
      expect(build({ DEVSMS_TOKEN: 'x' }).service.isConfigured()).toBe(true);
    });

    it('refuses to send when unconfigured, without calling out', async () => {
      const { service, post } = build({});

      await expect(service.send('998901234567', 'hi')).rejects.toMatchObject({
        kind: 'misconfigured',
      });
      // Fails closed: no request is attempted at all.
      expect(post).not.toHaveBeenCalled();
    });
  });

  describe('request shape', () => {
    it('posts JSON to send_sms.php with a bearer token', async () => {
      const { service, post } = build();

      await service.send('+998 90 123 45 67', 'Kod: 4829');

      const [url, body, options] = post.mock.calls[0] as unknown as [
        string,
        Record<string, unknown>,
        { headers: Record<string, string> },
      ];

      expect(url).toBe('https://devsms.uz/api/send_sms.php');
      // Normalised before it leaves: the gateway wants bare digits.
      expect(body).toMatchObject({ phone: '998901234567', message: 'Kod: 4829' });
      expect(options.headers.Authorization).toBe('Bearer test-token');
      expect(options.headers['Content-Type']).toBe('application/json');
    });

    it('strips a trailing slash from the configured base url', async () => {
      const { service, post } = build({
        DEVSMS_TOKEN: 't',
        DEVSMS_BASE_URL: 'https://devsms.uz/api/',
      });

      await service.send('998901234567', 'hi');

      expect(post.mock.calls[0][0]).toBe('https://devsms.uz/api/send_sms.php');
    });

    it('omits the gateway type unless one is configured', async () => {
      const { service, post } = build();

      await service.send('998901234567', 'hi');

      // Sending an empty `type` would be a request to route through a gateway
      // named "", not a request to use the account default.
      expect(post.mock.calls[0][1]).not.toHaveProperty('type');
    });

    it('sends the gateway type when configured', async () => {
      const { service, post } = build({ DEVSMS_TOKEN: 't', DEVSMS_TYPE: 'eskiz' });

      await service.send('998901234567', 'hi');

      expect(post.mock.calls[0][1]).toMatchObject({ type: 'eskiz' });
    });
  });

  describe('refusals reported in the body', () => {
    it('throws when success is false, even on HTTP 200', async () => {
      // THE case this client exists to get right. A 200 carrying
      // `success: false` must not read as a delivered message.
      const { service } = build(
        { DEVSMS_TOKEN: 't' },
        { success: false, error: 'Balans yetarli emas' },
      );

      await expect(service.send('998901234567', 'hi')).rejects.toBeInstanceOf(
        DeliveryError,
      );
    });

    it('keeps the reason the provider gave in the message', async () => {
      const { service } = build(
        { DEVSMS_TOKEN: 't' },
        { success: false, error: 'Balans yetarli emas' },
      );

      await expect(service.send('998901234567', 'hi')).rejects.toThrow(
        /Balans yetarli emas/,
      );
    });

    it('treats a body-level refusal as transient', async () => {
      // The number was already validated locally, so what is left is
      // account- or gateway-side and does recover. A refused message is not
      // billed, so the retry costs nothing.
      const { service } = build(
        { DEVSMS_TOKEN: 't' },
        { success: false, error: 'gateway down' },
      );

      await expect(service.send('998901234567', 'hi')).rejects.toMatchObject({
        retryable: true,
      });
    });

    it('throws when the envelope has no success field at all', async () => {
      // An unrecognised shape is not a success. Defaulting the other way would
      // turn every future response change into silent message loss.
      const { service } = build({ DEVSMS_TOKEN: 't' }, { data: { sms_id: 1 } });

      await expect(service.send('998901234567', 'hi')).rejects.toBeInstanceOf(
        DeliveryError,
      );
    });
  });

  describe('phone validation', () => {
    it.each(['12345', 'not a phone', '447911123456', ''])(
      'rejects %p as permanent without calling out',
      async (phone) => {
        const { service, post } = build();

        await expect(service.send(phone, 'hi')).rejects.toMatchObject({
          kind: 'permanent',
        });
        // Each attempt would be billable, so this must never reach the gateway.
        expect(post).not.toHaveBeenCalled();
      },
    );
  });

  describe('message id', () => {
    it('returns sms_id as the provider message id', async () => {
      const { service } = build();

      // Stringified: the rest of the pipeline stores an opaque string.
      expect(await service.send('998901234567', 'hi')).toEqual({
        providerMessageId: '123',
      });
    });

    it('falls back to request_id when sms_id is absent', async () => {
      const { service } = build(
        { DEVSMS_TOKEN: 't' },
        { success: true, data: { request_id: 'req-uuid' } },
      );

      expect(await service.send('998901234567', 'hi')).toEqual({
        providerMessageId: 'req-uuid',
      });
    });

    it('returns no id rather than a fabricated one', async () => {
      const { service } = build({ DEVSMS_TOKEN: 't' }, { success: true, data: {} });

      expect(await service.send('998901234567', 'hi')).toEqual({
        providerMessageId: undefined,
      });
    });
  });

  describe('balance warning', () => {
    /**
     * The live API answers with decimal strings — `"balance": "400.00"` — where
     * the documentation shows JSON numbers. Every case here uses the string
     * form, because a check written against the documented types is dead code
     * that never fires against the real gateway.
     */
    function sendWith(balance: unknown, total_cost: unknown) {
      const errors: string[] = [];
      const spy = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation((message: unknown) => {
          errors.push(String(message));
        });

      const { service } = build(
        { DEVSMS_TOKEN: 't' },
        { success: true, data: { sms_id: 1, balance, total_cost } },
      );

      return service
        .send('998901234567', 'hi')
        .then(() => errors)
        .finally(() => spy.mockRestore());
    }

    it('warns once the balance no longer covers another message', async () => {
      // 200 left, 200 a message: this send worked, the next one will not.
      expect(await sendWith('200.00', '200.00')).toHaveLength(0);
      expect(await sendWith('100.00', '200.00')).toHaveLength(1);
    });

    it('says what is left and what a message costs', async () => {
      const [message] = await sendWith('100.00', '200.00');
      expect(message).toMatch(/100/);
      expect(message).toMatch(/200/);
    });

    it('stays quiet on a healthy balance', async () => {
      expect(await sendWith('40000.00', '200.00')).toHaveLength(0);
    });

    it('warns on an exhausted balance even without a cost', async () => {
      expect(await sendWith('0.00', undefined)).toHaveLength(1);
    });

    it('says nothing when the response omits the balance', async () => {
      // A missing field must not read as a zero balance — `Number(null)` is 0,
      // which would report every response without the field as an outage.
      expect(await sendWith(undefined, undefined)).toHaveLength(0);
      expect(await sendWith(null, null)).toHaveLength(0);
    });
  });

  describe('HTTP failures', () => {
    it('classifies a rejected token as our misconfiguration', async () => {
      const { service } = build();
      (service as unknown as { http: { post: jest.Mock } }).http.post = jest.fn(
        () => httpError(401),
      );

      await expect(service.send('998901234567', 'hi')).rejects.toMatchObject({
        kind: 'misconfigured',
        retryable: false,
      });
    });

    it('classifies a 5xx as transient', async () => {
      const { service } = build();
      (service as unknown as { http: { post: jest.Mock } }).http.post = jest.fn(
        () => httpError(503),
      );

      await expect(service.send('998901234567', 'hi')).rejects.toMatchObject({
        retryable: true,
      });
    });

    it('classifies a 400 as permanent', async () => {
      const { service } = build();
      (service as unknown as { http: { post: jest.Mock } }).http.post = jest.fn(
        () => httpError(400, { success: false, error: 'invalid sender' }),
      );

      await expect(service.send('998901234567', 'hi')).rejects.toMatchObject({
        kind: 'permanent',
      });
    });

    it('surfaces the provider error text from an error body', async () => {
      const { service } = build();
      (service as unknown as { http: { post: jest.Mock } }).http.post = jest.fn(
        () => httpError(400, { success: false, error: 'invalid sender' }),
      );

      await expect(service.send('998901234567', 'hi')).rejects.toThrow(
        /invalid sender/,
      );
    });
  });

  describe('getStatus', () => {
    const STATUS_OK = { success: true, data: { status: 'delivered' } };

    it('looks a numeric id up as sms_id', async () => {
      const { service, get } = build({ DEVSMS_TOKEN: 't' }, STATUS_OK);

      expect(await service.getStatus('123')).toBe('delivered');

      const [url, options] = get.mock.calls[0] as unknown as [
        string,
        { params: Record<string, string> },
      ];
      expect(url).toBe('https://devsms.uz/api/get_status.php');
      expect(options.params).toEqual({ sms_id: '123' });
    });

    it('looks a uuid up as request_id', async () => {
      const { service, get } = build({ DEVSMS_TOKEN: 't' }, STATUS_OK);

      await service.getStatus('req-uuid');

      // The wrong key returns "not found", which would read as a lost message.
      expect(
        (get.mock.calls[0] as unknown as [string, { params: unknown }])[1].params,
      ).toEqual({ request_id: 'req-uuid' });
    });

    it('returns null instead of throwing when the lookup fails', async () => {
      // A status check is diagnostic. Failing it must not fail the send that
      // already succeeded.
      const { service } = build();
      (service as unknown as { http: { get: jest.Mock } }).http.get = jest.fn(() =>
        httpError(500),
      );

      expect(await service.getStatus('123')).toBeNull();
    });

    it('returns null when the body reports a refusal', async () => {
      const { service } = build(
        { DEVSMS_TOKEN: 't' },
        { success: false, error: 'not found' },
      );

      expect(await service.getStatus('123')).toBeNull();
    });
  });
});
