// Thin Jira Cloud client over a session from auth.mjs. Read-only: every call is a GET, or a POST to
// a search/bulk-read endpoint.

import { request, pool, HttpError } from './http.mjs';

export class Jira {
  constructor(session, { concurrency = 6 } = {}) { this.s = session; this.concurrency = concurrency; }

  async get(path, { agile = false } = {}) {
    return request((agile ? this.s.agileBase : this.s.apiBase) + path, { headers: await this.s.headers() });
  }
  async post(path, body) {
    return request(this.s.apiBase + path, { method: 'POST', body, headers: await this.s.headers() });
  }

  /** All issues matching `jql` (enhanced search, token paging). */
  async search(jql, fields, { onPage } = {}) {
    const out = [];
    let nextPageToken;
    do {
      const r = await this.post('/search/jql', { jql, fields, maxResults: 100, ...(nextPageToken ? { nextPageToken } : {}) });
      out.push(...r.issues);
      onPage?.(out.length);
      nextPageToken = r.isLast ? undefined : r.nextPageToken;
    } while (nextPageToken);
    return out;
  }

  fields() { return this.get('/field'); }
  statuses() { return this.get('/status'); }
  priorities() { return this.get('/priority'); }
  project(key) { return this.get(`/project/${encodeURIComponent(key)}`); }

  /** Remaining comments when the search response truncated them. */
  async comments(key) {
    const out = [];
    for (let startAt = 0; ;) {
      const r = await this.get(`/issue/${encodeURIComponent(key)}/comment?startAt=${startAt}&maxResults=100`);
      out.push(...r.comments);
      startAt += r.comments.length;
      if (!r.comments.length || startAt >= r.total) return out;
    }
  }

  /**
   * Changelogs for many issues: { issueId: histories[] }. Uses the bulk endpoint (1000 issues a
   * request); falls back to one paged request per issue when the site does not offer it.
   */
  async changelogs(issues) {
    const byId = {};
    if (!issues.length) return byId;
    try {
      for (let i = 0; i < issues.length; i += 1000) {
        const chunk = issues.slice(i, i + 1000).map(x => x.id);
        let nextPageToken;
        do {
          const r = await this.post('/changelog/bulkfetch', { issueIdsOrKeys: chunk, maxResults: 10000, ...(nextPageToken ? { nextPageToken } : {}) });
          for (const c of r.issueChangeLogs ?? []) (byId[c.issueId] ??= []).push(...(c.changeHistories ?? []));
          nextPageToken = r.nextPageToken;
        } while (nextPageToken);
      }
      for (const x of issues) byId[x.id] ??= [];
      return byId;
    } catch (e) {
      if (!(e instanceof HttpError) || ![400, 404, 405].includes(e.status)) throw e;
    }
    await pool(issues, this.concurrency, async x => {
      const all = [];
      for (let startAt = 0; ;) {
        const r = await this.get(`/issue/${encodeURIComponent(x.key)}/changelog?startAt=${startAt}&maxResults=100`);
        all.push(...r.values);
        startAt += r.values.length;
        if (r.isLast || !r.values.length) break;
      }
      byId[x.id] = all;
    });
    return byId;
  }

  // ---------- Jira Software (agile) ----------

  async boardsForProject(key) {
    const out = [];
    for (let startAt = 0; ;) {
      const r = await this.get(`/board?projectKeyOrId=${encodeURIComponent(key)}&startAt=${startAt}&maxResults=50`, { agile: true });
      out.push(...r.values);
      startAt += r.values.length;
      if (r.isLast || !r.values.length) return out;
    }
  }
  board(id) { return this.get(`/board/${id}`, { agile: true }); }
  boardConfig(id) { return this.get(`/board/${id}/configuration`, { agile: true }); }
  filter(id) { return this.get(`/filter/${id}`); }
}
