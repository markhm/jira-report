// fetch with retry (429 / 5xx / network), honouring Retry-After, and a small concurrency pool.

const sleep = ms => new Promise(r => setTimeout(r, ms));

export class HttpError extends Error {
  constructor(status, url, body) {
    super(`HTTP ${status} ${url.replace(/\?.*/, '')}${body ? ` — ${body.slice(0, 300)}` : ''}`);
    this.status = status;
  }
}

export async function request(url, { method = 'GET', headers = {}, body, retries = 5 } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      if (attempt >= retries) throw e;
      await sleep(500 * 2 ** attempt);
      continue;
    }
    if (res.ok) return res.status === 204 ? null : res.json();
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= retries) throw new HttpError(res.status, url, await res.text().catch(() => ''));
    const after = Number(res.headers.get('retry-after'));
    await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : 500 * 2 ** attempt + Math.random() * 250);
  }
}

/** Map over items with at most `limit` in flight; preserves order. */
export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
