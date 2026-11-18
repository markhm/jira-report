// Authentication. Resolution order for a site:
//   1. $JIRA_EMAIL + $JIRA_API_TOKEN                     (CI, one-off runs)
//   2. a stored OAuth session       (Keychain "<host>:oauth")   — refreshed silently
//   3. a stored API token           (Keychain "<host>:token")
//   4. interactive login: browser OAuth 2.0 (3LO) when an OAuth app is configured,
//      otherwise the guided API-token flow (opens Atlassian's token page, paste once).
//
// A session is { kind, apiBase, agileBase, headers() }. apiBase/agileBase differ per kind:
// API tokens talk to https://<host>, OAuth tokens to https://api.atlassian.com/ex/jira/<cloudId>.

import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { request } from './http.mjs';
import { getSecret, setSecret, deleteSecret } from './secrets.mjs';

const AUTH = 'https://auth.atlassian.com';
const TOKEN_PAGE = 'https://id.atlassian.com/manage-profile/security/api-tokens';

export function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).unref(); } catch { /* printed below anyway */ }
}

export function prompt(question, { hidden = false } = {}) {
  return new Promise(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = s => { if (!s.startsWith(question)) return; rl.output.write(question); };
    rl.question(question, answer => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(answer.trim()); });
  });
}

// ---------- sessions ----------

function basicSession(host, email, token, source) {
  const auth = 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
  const base = `https://${host}`;
  return { kind: 'token', source, who: email, apiBase: `${base}/rest/api/3`, agileBase: `${base}/rest/agile/1.0`, headers: async () => ({ Authorization: auth }) };
}

function oauthClient(config) {
  const env = process.env.JIRA_OAUTH_CLIENT_ID && process.env.JIRA_OAUTH_CLIENT_SECRET
    ? { clientId: process.env.JIRA_OAUTH_CLIENT_ID, clientSecret: process.env.JIRA_OAUTH_CLIENT_SECRET } : null;
  const stored = getSecret('oauth-client');
  const c = env ?? stored;
  if (!c?.clientId || !c?.clientSecret) return null;
  return { ...c, clientId: config.oauth?.clientId || c.clientId };
}

function oauthSession(host, stored, client) {
  let s = stored;
  const base = `https://api.atlassian.com/ex/jira/${s.cloudId}`;
  return {
    kind: 'oauth', source: 'keychain', who: s.who ?? 'OAuth', apiBase: `${base}/rest/api/3`, agileBase: `${base}/rest/agile/1.0`,
    async headers() {
      if (Date.now() > s.expiresAt - 60_000) {
        const t = await request(`${AUTH}/oauth/token`, { method: 'POST', body: { grant_type: 'refresh_token', client_id: client.clientId, client_secret: client.clientSecret, refresh_token: s.refreshToken } });
        s = { ...s, accessToken: t.access_token, refreshToken: t.refresh_token ?? s.refreshToken, expiresAt: Date.now() + t.expires_in * 1000 };
        setSecret(`${host}:oauth`, s);
      }
      return { Authorization: `Bearer ${s.accessToken}` };
    },
  };
}

async function verify(session) {
  const me = await request(`${session.apiBase}/myself`, { headers: await session.headers(), retries: 1 });
  session.who = me.emailAddress || me.displayName || session.who;
  return session;
}

/** Non-interactive resolution; returns null when nothing is stored. */
export async function storedSession(host, config) {
  if (process.env.JIRA_EMAIL && process.env.JIRA_API_TOKEN) return basicSession(host, process.env.JIRA_EMAIL, process.env.JIRA_API_TOKEN, 'env');
  const o = getSecret(`${host}:oauth`), client = oauthClient(config);
  if (o && client) {
    try { return await verify(oauthSession(host, o, client)); }
    catch (e) { process.stderr.write(`  stored OAuth session no longer works (${e.status ?? e.message}); signing in again\n`); deleteSecret(`${host}:oauth`); }
  }
  const t = getSecret(`${host}:token`);
  if (t) return basicSession(host, t.email, t.token, 'keychain');
  return null;
}

export async function resolveSession(host, config, { interactive = process.stdin.isTTY } = {}) {
  const s = await storedSession(host, config);
  if (s) return s;
  if (!interactive) throw new Error(`no credentials for ${host}: set JIRA_EMAIL + JIRA_API_TOKEN, or run 'jira-report login ${host}' in a terminal`);
  return login(host, config);
}

// ---------- interactive login ----------

export async function login(host, config, { method } = {}) {
  const client = oauthClient(config);
  const use = method ?? (client ? 'oauth' : 'token');
  if (use === 'oauth') {
    if (!client) throw new Error("no OAuth app configured — run 'jira-report oauth-setup' first (see README), or use 'login --token'");
    return oauthLogin(host, config, client);
  }
  return tokenLogin(host);
}

async function tokenLogin(host) {
  console.log(`\nSign in to ${host} with an Atlassian API token.`);
  console.log(`Opening ${TOKEN_PAGE} — create a token ("Create API token"), copy it, and paste it here.`);
  openBrowser(TOKEN_PAGE);
  const email = await prompt('  Atlassian account email: ');
  const token = await prompt('  API token (hidden): ', { hidden: true });
  const s = await verify(basicSession(host, email, token, 'keychain')).catch(e => { throw new Error(`token rejected by ${host} (${e.status ?? e.message})`); });
  setSecret(`${host}:token`, { email, token });
  console.log(`  ✓ signed in as ${s.who}; token stored in ${process.platform === 'darwin' ? 'the macOS Keychain' : 'the credentials file'}\n`);
  return s;
}

async function oauthLogin(host, config, client) {
  const port = config.oauth?.callbackPort ?? 8765;
  const redirect = `http://localhost:${port}/callback`;
  const state = randomBytes(16).toString('hex');
  const url = `${AUTH}/authorize?` + new URLSearchParams({
    audience: 'api.atlassian.com', client_id: client.clientId, scope: (config.oauth?.scopes ?? []).join(' '),
    redirect_uri: redirect, state, response_type: 'code', prompt: 'consent',
  });

  // "localhost" may resolve to 127.0.0.1 or ::1 depending on the OS and browser, so listen on both
  // loopback addresses (never on external interfaces).
  const code = await new Promise((resolve, reject) => {
    const servers = [];
    const done = () => { clearTimeout(timer); servers.forEach(s => s.close()); };
    const timer = setTimeout(() => { done(); reject(new Error('login timed out after 5 minutes')); }, 300_000);
    const handler = (req, res) => {
      const q = new URL(req.url, redirect);
      if (q.pathname !== '/callback') { res.writeHead(404).end(); return; }
      const ok = q.searchParams.get('state') === state && q.searchParams.get('code');
      res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' })
        .end(`<!doctype html><title>jira-report</title><body style="font:16px system-ui;margin:3rem">${ok ? 'Signed in. You can close this tab and return to the terminal.' : 'Sign-in failed. Return to the terminal.'}</body>`);
      done();
      ok ? resolve(q.searchParams.get('code')) : reject(new Error(q.searchParams.get('error_description') ?? 'OAuth state mismatch'));
    };
    let listening = 0, failed = 0;
    for (const host of ['127.0.0.1', '::1']) {
      const srv = createServer(handler);
      servers.push(srv);
      srv.on('error', e => {
        if (++failed < 2 && e.code !== 'EADDRINUSE') return;   // no IPv6 loopback is fine
        done(); reject(e.code === 'EADDRINUSE' ? new Error(`port ${port} is busy; set oauth.callbackPort (and the app's callback URL) to a free port`) : e);
      });
      srv.listen(port, host, () => {
        if (++listening > 1) return;
        console.log(`\nOpening your browser to sign in to Atlassian…\n  If it does not open, visit:\n  ${url}\n`);
        openBrowser(url);
      });
    }
  });

  const t = await request(`${AUTH}/oauth/token`, { method: 'POST', body: { grant_type: 'authorization_code', client_id: client.clientId, client_secret: client.clientSecret, code, redirect_uri: redirect } });
  const sites = await request('https://api.atlassian.com/oauth/token/accessible-resources', { headers: { Authorization: `Bearer ${t.access_token}` } });
  const site = sites.find(r => new URL(r.url).host === host);
  if (!site) throw new Error(`this login has no access to ${host} (it can see: ${sites.map(r => new URL(r.url).host).join(', ') || 'nothing'})`);
  if (!t.refresh_token) console.log("  note: no refresh token returned — add the 'offline_access' scope to stay signed in");
  const stored = { cloudId: site.id, accessToken: t.access_token, refreshToken: t.refresh_token ?? null, expiresAt: Date.now() + t.expires_in * 1000 };
  const s = await verify(oauthSession(host, stored, client));
  setSecret(`${host}:oauth`, { ...stored, who: s.who });
  console.log(`  ✓ signed in as ${s.who} (OAuth); session stored\n`);
  return s;
}

export async function oauthSetup() {
  console.log('\nRegister the OAuth app once (see README "Browser sign-in"), then paste its credentials.');
  const clientId = await prompt('  Client ID: ');
  const clientSecret = await prompt('  Secret (hidden): ', { hidden: true });
  if (!clientId || !clientSecret) throw new Error('both client ID and secret are required');
  setSecret('oauth-client', { clientId, clientSecret });
  console.log('  ✓ OAuth app stored. Run  jira-report login <host>  to sign in.\n');
}

export function logout(host) {
  deleteSecret(`${host}:oauth`);
  deleteSecret(`${host}:token`);
  console.log(`signed out of ${host} (stored OAuth session and API token removed)`);
}
