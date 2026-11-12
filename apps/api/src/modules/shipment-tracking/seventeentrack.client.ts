import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  ENVIRONMENT,
  type Environment,
} from '../../common/config/environment.js';
import { TrackingProviderError } from './tracking-normalization.js';

export const TRACKING_FETCH = Symbol('TRACKING_FETCH');
const envelope = z.object({
  code: z.number().int(),
  data: z
    .object({
      accepted: z.array(z.record(z.string(), z.unknown())).max(40).optional(),
      rejected: z
        .array(
          z.object({
            number: z.string(),
            carrier: z.union([z.number(), z.string()]).optional(),
            error: z.object({
              code: z.number().int(),
              message: z.string().optional(),
            }),
          }),
        )
        .max(40)
        .optional(),
    })
    .passthrough()
    .nullish(),
});
export function providerError(code: number) {
  const errors: Record<number, string> = {
    [-18019901]: 'ALREADY_REGISTERED',
    [-18019902]: 'NOT_REGISTERED',
    [-18019903]: 'CARRIER_NOT_DETECTED',
    [-18019907]: 'DAILY_LIMIT',
    [-18019908]: 'QUOTA_EXHAUSTED',
    [-18019909]: 'NO_DATA',
    [-18019910]: 'INVALID_CARRIER',
    [-18010002]: 'AUTH_FAILED',
    [-18010003]: 'UNAVAILABLE',
    [-18010012]: 'INVALID_NUMBER',
    [-18010018]: 'ADDITIONAL_FIELDS_REQUIRED',
    [-18010019]: 'ADDITIONAL_FIELDS_REQUIRED',
  };
  return new TrackingProviderError(
    `TRACK17_${errors[code] ?? 'PROVIDER_REJECTED'}`,
    [-18010003, -18019909].includes(code),
    code,
  );
}
export async function boundedJson(
  response: Response,
  maxBytes = 1024 * 1024,
): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new TrackingProviderError('TRACKING_EMPTY_RESPONSE');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes)
        throw new TrackingProviderError('TRACKING_RESPONSE_TOO_LARGE');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally {
    await reader.cancel();
  }
}
@Injectable()
export class SeventeenTrackClient {
  constructor(
    @Inject(ENVIRONMENT) private readonly env: Environment,
    @Inject(TRACKING_FETCH) private readonly fetcher: typeof fetch,
  ) {}
  async request(
    endpoint: 'register' | 'gettrackinfo',
    number: string,
    carrier?: number,
    additional: Record<string, string> = {},
  ) {
    if (!this.env.SEVENTEENTRACK_API_KEY)
      throw new TrackingProviderError('TRACK17_NOT_CONFIGURED');
    const signal = AbortSignal.timeout(this.env.SEVENTEENTRACK_TIMEOUT_MS);
    try {
      const response = await this.fetcher(
        `https://api.17track.net/track/v2.4/${endpoint}`,
        {
          method: 'POST',
          redirect: 'error',
          signal,
          headers: {
            '17token': this.env.SEVENTEENTRACK_API_KEY,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify([
            {
              number,
              ...(carrier ? { carrier } : {}),
              ...(endpoint === 'register' ? additional : {}),
            },
          ]),
        },
      );
      if (!response.ok) {
        const after = response.headers.get('retry-after');
        const seconds =
          after && /^\d+$/.test(after)
            ? Number(after) * 1000
            : after
              ? Date.parse(after) - Date.now()
              : 0;
        await response.body?.cancel();
        throw new TrackingProviderError(
          `TRACK17_HTTP_${response.status}`,
          response.status === 429 || response.status >= 500,
          response.status,
          Math.max(0, Math.min(86400000, seconds || 0)),
        );
      }
      const parsed = envelope.safeParse(await boundedJson(response));
      if (!parsed.success)
        throw new TrackingProviderError('TRACK17_INVALID_RESPONSE');
      if (parsed.data.code !== 0) throw providerError(parsed.data.code);
      const { accepted = [], rejected = [] } = parsed.data.data ?? {};
      const matches = accepted.filter(
        (i) =>
          i.number === number &&
          (endpoint === 'register' || !carrier || i.carrier === carrier),
      );
      if (matches.length > 1)
        throw new TrackingProviderError('TRACK17_AMBIGUOUS_CARRIER');
      if (matches.length === 1) return matches[0]!;
      const rejection = rejected.find((i) => i.number === number);
      if (rejection) throw providerError(rejection.error.code);
      throw new TrackingProviderError('TRACK17_INVALID_RESPONSE');
    } catch (e) {
      if (e instanceof TrackingProviderError) throw e;
      if (e instanceof z.ZodError || e instanceof SyntaxError)
        throw new TrackingProviderError('TRACK17_INVALID_RESPONSE');
      throw new TrackingProviderError(
        signal.aborted ? 'TRACK17_TIMEOUT' : 'TRACK17_UNAVAILABLE',
        true,
      );
    }
  }
}
