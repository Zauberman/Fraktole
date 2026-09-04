import { describe, expect, it, vi, afterEach } from 'vitest';
import { probeLocalServer } from '../electron/reviewer/local-probe.js';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('probeLocalServer', () => {
  it('reads n_ctx from llama.cpp /props', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ default_generation_settings: { n_ctx: 16384, temperature: 0.7 }, total_slots: 1 }),
      ),
    );
    const res = await probeLocalServer({ adapter: 'openai', baseUrl: 'http://localhost:8080/v1', model: 'whatever' });
    expect(res.contextTokens).toBe(16384);
    expect(res.state).toBe('ok');
    expect(res.kind).toBe('llamacpp');
  });

  it('reports 503 (still loading) as loading without touching /models', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: { message: 'Loading model', code: 503 } }, 503));
    vi.stubGlobal('fetch', fetchMock);
    const res = await probeLocalServer({ adapter: 'openai', baseUrl: 'http://localhost:8080/v1', model: 'm' });
    expect(res.state).toBe('loading');
    expect(res.contextTokens).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to /v1/models meta.n_ctx when /props 404s (vLLM/LM Studio shape)', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/props')) return jsonResponse({ error: 'not found' }, 404);
      return jsonResponse({ object: 'list', data: [{ id: 'qwen', meta: { n_ctx: 32768, n_ctx_train: 131072 } }] });
    });
    vi.stubGlobal('fetch', fetchMock);
    const res = await probeLocalServer({ adapter: 'openai', baseUrl: 'http://localhost:1234/v1', model: 'm' });
    expect(res.contextTokens).toBe(32768);
    expect(res.kind).toBe('openai-compat');
    expect(res.state).toBe('ok');
  });

  it('accepts max_model_len / context_length / top-level variants (vLLM, LM Studio)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('/props')) return jsonResponse({ error: 'not found' }, 404);
        return jsonResponse({ object: 'list', data: [{ id: 'm', context_length: 2048, max_model_len: 8192 }] });
      }),
    );
    const res = await probeLocalServer({ adapter: 'openai', baseUrl: 'http://localhost:1234/v1', model: 'm' });
    expect(res.contextTokens).toBe(2048);
  });

  it('reads ollama /api/show model_info context_length (shortest value wins across backends)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ model_info: { 'llama.context_length': 4096, 'qwen2.context_length': 32768 } }),
      ),
    );
    const res = await probeLocalServer({ adapter: 'ollama', baseUrl: 'http://localhost:11434', model: 'qwen2.5' });
    expect(res.contextTokens).toBe(4096);
    expect(res.kind).toBe('ollama');
  });

  it('an unreachable server is a benign unreachable — never a throw', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('fetch failed'))));
    const res = await probeLocalServer({ adapter: 'openai', baseUrl: 'http://localhost:8080/v1', model: 'm' });
    expect(res.state).toBe('unreachable');
    expect(res.contextTokens).toBeUndefined();
  });

  it('drops the trailing slash before joining endpoints', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith('/props')) return jsonResponse({ default_generation_settings: { n_ctx: 8192 } });
      return jsonResponse({ error: 'nope' }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);
    const res = await probeLocalServer({ adapter: 'openai', baseUrl: 'http://localhost:8080/v1/', model: 'm' });
    expect(res.contextTokens).toBe(8192);
    expect(fetchMock.mock.calls[0]![0]).toBe('http://localhost:8080/v1/props');
  });

  it('explains every outcome in a single-line detail (which endpoint answered, or why not)', async () => {
    // llama.cpp: the answering endpoint is named with the detected window
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ default_generation_settings: { n_ctx: 16384 } })));
    const llamacpp = await probeLocalServer({ adapter: 'openai', baseUrl: 'http://localhost:8080/v1', model: 'm' });
    expect(llamacpp.detail).toBe('llama.cpp /props — context window 16384');

    // ollama: named endpoint + window
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ model_info: { 'qwen2.context_length': 32768 } })),
    );
    const ollama = await probeLocalServer({ adapter: 'ollama', baseUrl: 'http://localhost:11434', model: 'q' });
    expect(ollama.detail).toBe('ollama /api/show — context window 32768');

    // loading: says so
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: { message: 'Loading model' } }, 503)));
    const loading = await probeLocalServer({ adapter: 'openai', baseUrl: 'http://localhost:8080/v1', model: 'm' });
    expect(loading.detail).toBe('llama.cpp is loading the model');

    // unreachable: says why, never throws
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('fetch failed'))));
    const dead = await probeLocalServer({ adapter: 'openai', baseUrl: 'http://localhost:8080/v1', model: 'm' });
    expect(dead.state).toBe('unreachable');
    expect(dead.detail).toBe('no answer — is the server running?');

    // empty base URL
    const empty = await probeLocalServer({ adapter: 'openai', baseUrl: '  ', model: 'm' });
    expect(empty.detail).toBe('no base URL configured');
  });
});
