import { afterEach, describe, expect, it, vi } from 'vitest';
import { listModels } from '../electron/model-list.js';

function stubJson(body: unknown, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('listModels', () => {
  it('lists models from an OpenAI-compatible /models endpoint with Bearer auth', async () => {
    stubJson({ data: [{ id: 'deepseek-v4-pro' }, { id: 'deepseek-v4-flash' }, { id: 'deepseek-chat' }] });
    const models = await listModels({ adapter: 'openai', apiKey: 'sk-x', baseUrl: 'https://api.deepseek.com/v1' });
    expect(models).toEqual(['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-chat']);
    const call = vi.mocked(fetch).mock.calls[0]!;
    expect(call[0]).toBe('https://api.deepseek.com/v1/models');
    expect((call[1]!.headers as Record<string, string>).Authorization).toBe('Bearer sk-x');
  });

  it('lists models from the Anthropic /models endpoint with x-api-key', async () => {
    stubJson({ data: [{ id: 'claude-sonnet-4-5' }, { id: 'claude-opus-4-1' }] });
    const models = await listModels({ adapter: 'anthropic', apiKey: 'sk-ant-x', baseUrl: '' });
    expect(models).toEqual(['claude-sonnet-4-5', 'claude-opus-4-1']);
    const call = vi.mocked(fetch).mock.calls[0]!;
    expect(call[0]).toBe('https://api.anthropic.com/v1/models');
    const headers = call[1]!.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-ant-x');
    expect(headers['anthropic-version']).toBe('2023-06-01');
  });

  it('lists models from the Ollama /api/tags endpoint', async () => {
    stubJson({ models: [{ name: 'qwen2.5' }, { name: 'llama3.2' }] });
    const models = await listModels({ adapter: 'ollama', apiKey: '', baseUrl: 'http://localhost:11434' });
    expect(models).toEqual(['qwen2.5', 'llama3.2']);
    expect(vi.mocked(fetch).mock.calls[0]![0]).toBe('http://localhost:11434/api/tags');
  });

  it('dedupes and caps the list', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `m${i % 2}-${i}`);
    stubJson({ data: ids.map((id) => ({ id })) });
    const models = await listModels({ adapter: 'openai', apiKey: 'k', baseUrl: 'http://x' });
    expect(models).toHaveLength(100);
    expect(new Set(models).size).toBe(models.length);
  });

  it('returns [] on network failure, non-JSON, or empty payload', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })));
    expect(await listModels({ adapter: 'openai', apiKey: 'k', baseUrl: 'http://x' })).toEqual([]);

    stubJson({ data: [] });
    expect(await listModels({ adapter: 'openai', apiKey: 'k', baseUrl: 'http://x' })).toEqual([]);

    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network down');
    }));
    expect(await listModels({ adapter: 'anthropic', apiKey: 'k', baseUrl: '' })).toEqual([]);
  });
});
