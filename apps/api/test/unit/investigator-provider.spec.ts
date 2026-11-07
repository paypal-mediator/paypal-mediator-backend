import { describe, expect, it, vi } from 'vitest';
import { AgentProvider } from '../../src/modules/investigator/agent-provider.js';
import { parseEnvironment } from '../../src/common/config/environment.js';

const draft = {
  summary: 'DEMO / MOCK no connected commercial source',
  findings: [],
  missing: [{ code: 'NOT_CONNECTED', explanation: 'No commercial source' }],
  contradictions: [],
  irrelevantEvidenceIds: [],
  suggestedResponse: '',
};
const command = { action: 'FINISH', evidenceId: null, result: draft };
const base = { DATABASE_URL: 'postgresql://mock:mock@localhost/mock' };
const messages = [{ role: 'user' as const, text: 'DEMO / MOCK provider test' }];
const signal = () => AbortSignal.timeout(1000);
function nvidiaResponse(
  content = JSON.stringify(command),
  finishReason = 'stop',
) {
  return Response.json({
    choices: [
      {
        finish_reason: finishReason,
        message: {
          content,
          reasoning_content: 'MOCK hidden reasoning must not persist',
        },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  });
}
describe('M05 provider adapters (explicit MOCK HTTP)', () => {
  it('selects NVIDIA with its exact requested model and bounded JSON prompt protocol', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(nvidiaResponse());
    const adapter = new AgentProvider(
      parseEnvironment({ ...base, NVIDIA_API_KEY: 'MOCK_NVIDIA_KEY' }),
      fetcher,
    );
    const result = await adapter.step(messages, signal());
    expect(result.command).toEqual(command);
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://integrate.api.nvidia.com/v1/chat/completions');
    const body = JSON.parse(init!.body as string);
    expect(body.model).toBe('nvidia/nemotron-3.5-super-vl-120b-a12b');
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body.stream).toBe(false);
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.response_format.json_schema.schema.additionalProperties).toBe(
      false,
    );
    expect(JSON.stringify(result)).not.toContain('hidden reasoning');
  });
  it('switches to OpenAI Responses with store=false and the same strict result schema', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        status: 'completed',
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: JSON.stringify(command) }],
          },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    );
    const adapter = new AgentProvider(
      parseEnvironment({
        ...base,
        AI_PROVIDER: 'openai',
        OPENAI_API_KEY: 'MOCK_OPENAI_KEY',
        OPENAI_MODEL: 'MOCK_CONFIGURED_MODEL',
      }),
      fetcher,
    );
    expect((await adapter.step(messages, signal())).command).toEqual(command);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/responses');
    const body = JSON.parse(init!.body as string);
    expect(body.store).toBe(false);
    expect(body.model).toBe('MOCK_CONFIGURED_MODEL');
    expect(body.text.format.strict).toBe(true);
    expect(body.text.format.schema.additionalProperties).toBe(false);
    expect(body.chat_template_kwargs).toBeUndefined();
  });
  it('does not fall back to OpenAI when NVIDIA is unconfigured', () => {
    const fetcher = vi.fn<typeof fetch>();
    const adapter = new AgentProvider(
      parseEnvironment({
        ...base,
        OPENAI_API_KEY: 'MOCK_OPENAI_KEY',
        OPENAI_MODEL: 'MOCK',
      }),
      fetcher,
    );
    expect(() => adapter.configuration()).toThrow('Configure the selected');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    'not JSON',
    '```json\n{}\n```',
    JSON.stringify({ ...command, action: 'SUBMIT_PAYPAL' }),
  ])('rejects malformed output or forbidden commands (%s)', async (content) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(nvidiaResponse(content));
    const adapter = new AgentProvider(
      parseEnvironment({ ...base, NVIDIA_API_KEY: 'MOCK' }),
      fetcher,
    );
    await expect(adapter.step(messages, signal())).rejects.toThrow(
      'AI_INVALID_RESPONSE',
    );
  });
  it('rejects truncated responses', async () => {
    const adapter = new AgentProvider(
      parseEnvironment({ ...base, NVIDIA_API_KEY: 'MOCK' }),
      vi.fn<typeof fetch>().mockResolvedValue(nvidiaResponse('{}', 'length')),
    );
    await expect(adapter.step(messages, signal())).rejects.toThrow(
      'AI_INVALID_RESPONSE',
    );
  });
  it('sanitizes upstream errors without retrying or switching providers', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ error: 'MOCK_SECRET_PROVIDER_BODY' }, { status: 429 }),
      );
    const adapter = new AgentProvider(
      parseEnvironment({ ...base, NVIDIA_API_KEY: 'MOCK' }),
      fetcher,
    );
    await expect(adapter.step(messages, signal())).rejects.toThrow(
      /^AI_RATE_LIMITED$/,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('maps aborts to explicit timeout failures', async () => {
    const controller = new AbortController();
    controller.abort();
    const adapter = new AgentProvider(
      parseEnvironment({ ...base, NVIDIA_API_KEY: 'MOCK' }),
      vi
        .fn<typeof fetch>()
        .mockRejectedValue(new Error('MOCK_SECRET_TRANSPORT')),
    );
    await expect(adapter.step(messages, controller.signal)).rejects.toThrow(
      /^INVESTIGATION_TIMEOUT$/,
    );
  });
});
