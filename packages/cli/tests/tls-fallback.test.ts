import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiRequest } from '../src/client.js';

const fetchMock = vi.hoisted(() => vi.fn());
vi.stubGlobal('fetch', fetchMock);

afterEach(() => {
  fetchMock.mockReset();
});

function okResponse(): Response {
  return new Response(JSON.stringify({ tasks: [] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('apiRequest TLS fallback', () => {
  it('retries over plain http when https fails on a loopback host', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('certificate has expired'))
      .mockResolvedValueOnce(okResponse());

    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { data } = await apiRequest(
      { baseUrl: 'https://127.0.0.1:8756', token: 't' },
      'GET',
      '/v1/tasks',
    );
    warn.mockRestore();

    expect(data).toEqual({ tasks: [] });
    expect(fetchMock.mock.calls[1]![0]).toBe('http://127.0.0.1:8756/v1/tasks');
  });

  it('does NOT fall back for non-loopback hosts', async () => {
    fetchMock.mockRejectedValueOnce(new Error('certificate has expired'));

    await expect(
      apiRequest({ baseUrl: 'https://my-vps.example.com:8756', token: 't' }, 'GET', '/v1/tasks'),
    ).rejects.toThrow('certificate has expired');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('leaves plain http requests untouched', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await expect(
      apiRequest({ baseUrl: 'http://127.0.0.1:8756', token: 't' }, 'GET', '/v1/tasks'),
    ).rejects.toThrow('ECONNREFUSED');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
