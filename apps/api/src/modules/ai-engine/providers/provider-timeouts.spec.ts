/**
 * Request deadlines on the AI provider clients.
 *
 * Both SDKs default to a 10-minute timeout and two retries, so a client
 * constructed without options can hold a request open for half an hour and
 * report nothing while it does. Everything downstream waits behind it — the
 * failover to the second provider, the fallback to the plain interpolated
 * template, and the user, who sees a "Generating…" button that never resolves.
 *
 * That is a configuration absence, not a crash: nothing throws, nothing logs,
 * and no test that only checks a successful generation would notice it coming
 * back. Hence a test on the client options themselves.
 */
import type { ConfigService } from '@nestjs/config';
import { AnthropicProvider } from './anthropic.provider';
import { OpenAiProvider } from './openai.provider';

function config(values: Record<string, unknown> = {}): ConfigService {
  return {
    get: <T>(key: string, fallback?: T) => (values[key] as T) ?? fallback,
    getOrThrow: <T>(key: string) => {
      const value = values[key];
      if (value === undefined) throw new Error(`${key} is not configured`);
      return value as T;
    },
  } as unknown as ConfigService;
}

/** Reaches the lazily-constructed SDK client without making a request. */
function clientOf(provider: { generate: unknown }): {
  timeout?: number;
  maxRetries?: number;
} {
  const withClient = provider as unknown as {
    getClient(): { timeout?: number; maxRetries?: number };
  };
  return withClient.getClient();
}

const KEYS = {
  ANTHROPIC_API_KEY: 'sk-ant-test',
  OPENAI_API_KEY: 'sk-test',
};

describe('provider request deadlines', () => {
  describe.each([
    ['Anthropic', () => new AnthropicProvider(config(KEYS))],
    ['OpenAI', () => new OpenAiProvider(config(KEYS))],
  ])('%s', (_name, build) => {
    it('sets a timeout rather than inheriting the SDK default', () => {
      // The SDK default is 600_000. Anything near it means the option was
      // dropped and a hung request will sit for ten minutes per attempt.
      const client = clientOf(build() as never);

      expect(client.timeout).toBe(120_000);
    });

    it('retries at most once', () => {
      // A timeout is retried like any other failure, so the worst case is
      // `timeout × (maxRetries + 1)`. The SDK's default of two retries would
      // put that back over five minutes.
      expect(clientOf(build() as never).maxRetries).toBe(1);
    });

    it('caps the worst case at under five minutes', () => {
      // The property that actually matters, stated directly: whatever the two
      // numbers are, a person waiting on a generation gets an answer.
      const client = clientOf(build() as never);
      const worstCaseMs = client.timeout! * (client.maxRetries! + 1);

      expect(worstCaseMs).toBeLessThan(5 * 60_000);
    });
  });

  it('honours a configured timeout', async () => {
    const provider = new AnthropicProvider(
      config({ ...KEYS, AI_REQUEST_TIMEOUT_MS: 30_000 }),
    );

    expect(clientOf(provider as never).timeout).toBe(30_000);
  });

  it('shares one deadline across both providers', () => {
    // The second provider is the failover: a request that already spent its
    // budget on the first must not be able to spend a different one again.
    const settings = { ...KEYS, AI_REQUEST_TIMEOUT_MS: 45_000 };

    expect(clientOf(new AnthropicProvider(config(settings)) as never).timeout).toBe(
      clientOf(new OpenAiProvider(config(settings)) as never).timeout,
    );
  });
});
