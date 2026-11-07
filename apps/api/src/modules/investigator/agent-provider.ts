import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { InvestigationStepSchema } from '@resolve-ai/contracts';
import {
  ENVIRONMENT,
  type Environment,
} from '../../common/config/environment.js';
import { ApiException } from '../../common/http/api.exception.js';

export const INVESTIGATOR_FETCH = Symbol('INVESTIGATOR_FETCH');
export interface AgentMessage {
  role: 'system' | 'user' | 'assistant';
  text: string;
  image?: { mediaType: string; base64: string };
}
export class AgentError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

@Injectable()
export class AgentProvider {
  constructor(
    @Inject(ENVIRONMENT) private readonly env: Environment,
    @Inject(INVESTIGATOR_FETCH) private readonly fetcher: typeof fetch,
  ) {}

  configuration() {
    const nvidia = this.env.AI_PROVIDER === 'nvidia';
    const key = nvidia ? this.env.NVIDIA_API_KEY : this.env.OPENAI_API_KEY;
    const model = nvidia ? this.env.NVIDIA_MODEL : this.env.OPENAI_MODEL;
    if (!key || !model)
      throw new ApiException(
        'INVESTIGATOR_NOT_CONFIGURED',
        'Configure the selected AI provider key and model',
        503,
      );
    return {
      provider: nvidia ? ('NVIDIA' as const) : ('OPENAI' as const),
      model,
      key,
    };
  }

  async step(messages: AgentMessage[], signal: AbortSignal) {
    return this.structuredStep(messages, signal, InvestigationStepSchema);
  }

  async structuredStep<T>(
    messages: AgentMessage[],
    signal: AbortSignal,
    outputSchema: z.ZodType<T>,
    maxOutputTokens = 3072,
  ) {
    const config = this.configuration();
    const nvidia = config.provider === 'NVIDIA';
    const schema = z.toJSONSchema(outputSchema, {
      target: 'draft-7',
    });
    const body = nvidia
      ? {
          model: config.model,
          stream: false,
          max_tokens: maxOutputTokens,
          temperature: 0.6,
          chat_template_kwargs: { enable_thinking: false },
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'agent_step', strict: true, schema },
          },
          messages: messages.map((m) => ({
            role: m.role,
            content: m.image
              ? [
                  { type: 'text', text: m.text },
                  {
                    type: 'image_url',
                    image_url: {
                      url: `data:${m.image.mediaType};base64,${m.image.base64}`,
                    },
                  },
                ]
              : m.text,
          })),
        }
      : {
          model: config.model,
          store: false,
          max_output_tokens: maxOutputTokens,
          input: messages.map((m) => ({
            role: m.role,
            content: m.image
              ? [
                  { type: 'input_text', text: m.text },
                  {
                    type: 'input_image',
                    image_url: `data:${m.image.mediaType};base64,${m.image.base64}`,
                    detail: 'auto',
                  },
                ]
              : m.text,
          })),
          text: {
            format: {
              type: 'json_schema',
              name: 'investigation_step',
              strict: true,
              schema,
            },
          },
        };
    let response: Response;
    try {
      response = await this.fetcher(
        nvidia
          ? 'https://integrate.api.nvidia.com/v1/chat/completions'
          : 'https://api.openai.com/v1/responses',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.key}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal,
          redirect: 'error',
        },
      );
    } catch {
      throw new AgentError(
        signal.aborted ? 'INVESTIGATION_TIMEOUT' : 'AI_PROVIDER_UNAVAILABLE',
      );
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new AgentError(
        response.status === 429 ? 'AI_RATE_LIMITED' : 'AI_PROVIDER_REJECTED',
      );
    }
    let raw: unknown;
    try {
      if (!response.body) throw new Error();
      const reader = response.body.getReader();
      const parts: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 512 * 1024) {
          await reader.cancel();
          throw new Error();
        }
        parts.push(value);
      }
      raw = JSON.parse(Buffer.concat(parts).toString('utf8'));
    } catch {
      throw new AgentError(
        signal.aborted ? 'INVESTIGATION_TIMEOUT' : 'AI_INVALID_RESPONSE',
      );
    }
    const usageSchema = z.object({
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
    });
    let content: string;
    let usage: z.infer<typeof usageSchema>;
    try {
      if (nvidia) {
        const parsed = z
          .object({
            choices: z
              .array(
                z.object({
                  finish_reason: z.literal('stop'),
                  message: z.object({ content: z.string() }),
                }),
              )
              .min(1),
            usage: z.object({
              prompt_tokens: z.number().int().nonnegative(),
              completion_tokens: z.number().int().nonnegative(),
            }),
          })
          .parse(raw);
        content = parsed.choices[0]!.message.content;
        usage = {
          inputTokens: parsed.usage.prompt_tokens,
          outputTokens: parsed.usage.completion_tokens,
        };
      } else {
        const parsed = z
          .object({
            status: z.literal('completed'),
            output: z.array(
              z.object({
                type: z.string(),
                content: z
                  .array(
                    z.object({ type: z.string(), text: z.string().optional() }),
                  )
                  .optional(),
              }),
            ),
            usage: z.object({
              input_tokens: z.number().int().nonnegative(),
              output_tokens: z.number().int().nonnegative(),
            }),
          })
          .parse(raw);
        const texts = parsed.output
          .filter((o) => o.type === 'message')
          .flatMap((o) => o.content ?? []);
        if (texts.some((c) => c.type === 'refusal')) throw new Error();
        content = texts
          .filter((c) => c.type === 'output_text')
          .map((c) => c.text ?? '')
          .join('');
        usage = {
          inputTokens: parsed.usage.input_tokens,
          outputTokens: parsed.usage.output_tokens,
        };
      }
      return {
        command: outputSchema.parse(JSON.parse(content)),
        usage: usageSchema.parse(usage),
      };
    } catch {
      throw new AgentError('AI_INVALID_RESPONSE');
    }
  }
}
