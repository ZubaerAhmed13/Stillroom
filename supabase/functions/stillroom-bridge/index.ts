const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const url = Deno.env.get('SUPABASE_URL') || '';
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || '';
const expectedBridgeDigest = Deno.env.get('STILLROOM_BRIDGE_SHA256') || '__STILLROOM_BRIDGE_SHA256__';

class BridgeError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function randomToken() {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

async function trustedBridge(key: string) {
  if (!/^[a-f0-9]{64}$/.test(expectedBridgeDigest)) return false;
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)));
  let difference = 0;
  for (let index = 0; index < bytes.length; index++) {
    difference |= bytes[index] ^ Number.parseInt(expectedBridgeDigest.slice(index * 2, index * 2 + 2), 16);
  }
  return difference === 0;
}

function normalizeEmail(value: unknown) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!emailPattern.test(email) || email.length > 254) throw new BridgeError(400, 'Enter a valid email address.');
  return email;
}

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { 'cache-control': 'private, no-store' } });
}

async function callAuth(path: string, body: unknown, admin = false, token?: string) {
  const key = admin ? serviceKey : anonKey;
  return fetch(url + '/auth/v1/' + path, {
    method: 'POST',
    headers: { apikey: key, authorization: 'Bearer ' + (token || key), 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5500)
  });
}

Deno.serve(async request => {
  const bridge = request.headers.get('x-stillroom-bridge');
  if (request.method !== 'POST' || !bridge || !tokenPattern.test(bridge) || !await trustedBridge(bridge)) {
    return json({ error: 'Bridge access denied.' }, 403);
  }
  if (!url || !serviceKey || !anonKey) return json({ error: 'Stillroom is temporarily unavailable.' }, 503);
  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null && (!/^[1-9]\d*$/.test(declaredLength) || Number(declaredLength) > 18 * 1024)) {
    return json({ error: 'Invalid request.' }, 400);
  }

  try {
    const { action, data, session } = await request.json();
    if (typeof action !== 'string' || !data || typeof data !== 'object' || Array.isArray(data) ||
        (session !== null && (typeof session !== 'string' || !tokenPattern.test(session)))) {
      throw new BridgeError(400, 'Invalid request.');
    }

    async function dispatch(command: string, input = data) {
      const rpc = command.startsWith('storage_') ? 'stillroom_storage' : 'stillroom_dispatch';
      const response = await fetch(url + '/rest/v1/rpc/' + rpc, {
        method: 'POST',
        headers: { apikey: serviceKey, authorization: 'Bearer ' + serviceKey, 'content-type': 'application/json' },
        body: JSON.stringify({ p_bridge: bridge, p_session: session, p_action: command, p_data: input }),
        signal: AbortSignal.timeout(5500)
      });
      const result = await response.json();
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500 && result.code === 'PT' + response.status) {
          const code = ['storage_limit', 'r2_read_limit', 'r2_write_limit'].includes(result.details) ? result.details : undefined;
          throw new BridgeError(response.status, result.message, code);
        }
        throw new BridgeError(503, 'Stillroom is temporarily unavailable.');
      }
      return result;
    }

    if (['login', 'redeem', 'setup'].includes(action)) {
      await dispatch('throttle', { ip: typeof data.ip === 'string' ? data.ip.slice(0, 80) : 'unknown' });
      const { password } = data;
      if (typeof password !== 'string' || password.length > 128 || !password.length) throw new BridgeError(400, 'Enter your password.');
      if (action !== 'login' && (password.length < 12 || new TextEncoder().encode(password).length > 72)) {
        throw new BridgeError(400, 'Use a password with at least 12 characters and at most 72 bytes.');
      }
      const claim = data.token;
      let email = action === 'redeem' ? '' : normalizeEmail(data.email);
      let newAccount = false;
      if (action !== 'login') {
        if (typeof claim !== 'string' || !tokenPattern.test(claim)) throw new BridgeError(404, 'This link is unavailable.');
        const claimed = await dispatch('claim', { claim, mode: action, email });
        email = claimed.email;
        const created = await callAuth('admin/users', {
          email, password, email_confirm: true,
          app_metadata: { stillroom_provisioned: true, stillroom_claim: claimed.digest, stillroom_mode: action }
        }, true);
        newAccount = created.ok;
        if (created.ok) {
          await created.body?.cancel();
        } else {
          const failure = await created.json().catch(() => ({}));
          if (failure.code === 'weak_password') throw new BridgeError(400, 'Choose a stronger password.');
          if (failure.code === 'email_address_invalid') throw new BridgeError(400, 'Enter a valid email address.');
          if (!['email_exists', 'user_already_exists'].includes(failure.code)) {
            throw new BridgeError(503, 'Account setup is temporarily unavailable.');
          }
        }
      }

      const signedIn = await callAuth('token?grant_type=password', { email, password });
      if (!signedIn.ok) {
        await signedIn.body?.cancel();
        if (signedIn.status === 429) throw new BridgeError(429, 'Too many sign-in attempts. Try again in a few minutes.');
        if (signedIn.status >= 500) throw new BridgeError(503, 'Stillroom sign-in is temporarily unavailable.');
        throw new BridgeError(401, action === 'login' ? 'Email or password is incorrect, or access is inactive.' :
          'Could not activate this account. If you were invited again, use your existing Stillroom password.');
      }
      const { user, access_token: accessToken } = await signedIn.json();
      if (!user?.id || user.email !== email || user.app_metadata?.stillroom_provisioned !== true || !accessToken) {
        throw new BridgeError(401, 'This identity is unavailable.');
      }
      const token = randomToken();
      try {
        const command = action === 'redeem' && !newAccount ? 'activate' : 'login';
        const result = await dispatch(command, { id: user.id, email, token, claim, mode: action });
        return json({ ...result, token });
      } finally {
        // Stillroom issues its own revocable session. Close the temporary Auth session.
        try { const closed = await callAuth('logout?scope=local', {}, false, accessToken); await closed.body?.cancel(); } catch { /* Auth session is never returned */ }
      }
    }

    const commands = new Set(['session', 'logout', 'require_member', 'require_owner', 'media', 'owner', 'invite',
      'revoke', 'create_collection', 'rename_collection', 'edit_media', 'storage_status', 'storage_lookup',
      'storage_read', 'storage_reserve', 'storage_part', 'storage_reject_part', 'storage_save_multipart',
      'storage_save_part', 'storage_finish', 'storage_complete_budget', 'storage_release', 'storage_publish',
      'storage_trash', 'storage_restore', 'storage_remove', 'storage_removed']);
    if (!commands.has(action)) return json({ error: 'Page not found.' }, 404);
    const result = await dispatch(action, action === 'invite' ? { email: data.email, token: randomToken() } : data);
    return json(result);
  } catch (error) {
    if (error instanceof BridgeError) return json({ error: error.message, code: error.code }, error.status);
    return json({ error: 'Stillroom is temporarily unavailable.' }, 503);
  }
});
