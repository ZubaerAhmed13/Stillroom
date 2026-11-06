import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { atomic, GUEST_LIMIT, INVITE_DURATION, SESSION_DURATION } from './catalog.mjs';
import { HttpError } from './http.mjs';

const derive = promisify(scrypt);
const dummyPassword = '00000000000000000000000000000000:' + '00'.repeat(64);
const COOKIE = 'stillroom_session';
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const randomToken = () => randomBytes(32).toString('base64url');
export const digest = value => createHash('sha256').update(value).digest('hex');

function validateEmail(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpError(400, 'Enter a valid email address.');
  }
  return email;
}

async function hashPassword(value) {
  if (typeof value !== 'string' || value.length < 12 || value.length > 128) {
    throw new HttpError(400, 'Use a password with 12 to 128 characters.');
  }
  const salt = randomBytes(16).toString('hex');
  return salt + ':' + (await derive(value, salt, 64)).toString('hex');
}

async function verifyPassword(value, hash) {
  if (typeof value !== 'string' || value.length > 128) return false;
  const [salt, expected] = hash.split(':');
  return timingSafeEqual(await derive(value, salt, 64), Buffer.from(expected, 'hex'));
}

function sessionToken(request) {
  const match = new RegExp('(?:^|;\\s*)' + COOKIE + '=([A-Za-z0-9_-]{43})(?:;|$)').exec(request.headers.cookie || '');
  return match?.[1];
}

export async function openAccess(db, { ownerEmail, ownerPassword, secureCookies, now, onBootstrap }) {
  const owner = db.prepare("SELECT email FROM users WHERE role = 'owner'").get();
  if (!owner) {
    const email = validateEmail(ownerEmail);
    const generated = !ownerPassword;
    const password = ownerPassword || randomBytes(18).toString('base64url');
    db.prepare("INSERT INTO users (email, password, role) VALUES (?, ?, 'owner')")
      .run(email, await hashPassword(password));
    onBootstrap({ email, password: generated ? password : undefined });
  }
  const secure = secureCookies ? '; Secure' : '';
  const cookie = (value, age) => COOKIE + '=' + value + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + age + secure;
  const guestAllowed = "u.role = 'owner' OR EXISTS (SELECT 1 FROM invites i WHERE i.email = u.email AND i.status = 'active')";
  const userByEmail = db.prepare("SELECT u.email, u.password, u.role FROM users u WHERE u.email = ? AND (" + guestAllowed + ")");
  const userByToken = db.prepare("SELECT u.email, u.role FROM sessions s JOIN users u USING (email) WHERE s.token = ? AND s.expires > ? AND (" + guestAllowed + ")");
  const revokeSessions = db.prepare('DELETE FROM sessions WHERE email = ?');
  const loginWindows = new Map();

  function identity(request) {
    const raw = sessionToken(request);
    if (!raw) return null;
    const session = digest(raw);
    const user = userByToken.get(session, now());
    return user ? { ...user, session } : null;
  }

  function requireUser(request, ownerOnly = false) {
    const user = identity(request);
    if (!user) throw new HttpError(401, 'Sign in to continue.');
    if (ownerOnly && user.role !== 'owner') throw new HttpError(403, 'Only the owner can do this.');
    return user;
  }

  function issueSession(request, response, user) {
    const old = sessionToken(request);
    if (old) db.prepare('DELETE FROM sessions WHERE token = ?').run(digest(old));
    db.prepare('DELETE FROM sessions WHERE expires <= ?').run(now());
    const raw = randomToken();
    db.prepare('INSERT INTO sessions (token, email, expires) VALUES (?, ?, ?)')
      .run(digest(raw), user.email, now() + SESSION_DURATION);
    response.setHeader('set-cookie', cookie(raw, SESSION_DURATION / 1000));
    return { email: user.email, role: user.role };
  }

  function throttle(request) {
    const key = request.socket.remoteAddress || 'local';
    const current = now();
    for (const [address, window] of loginWindows) {
      if (window.until <= current) loginWindows.delete(address);
    }
    const window = loginWindows.get(key) || { attempts: 0, until: current + 10 * 60 * 1000 };
    if (window.attempts >= 35 || loginWindows.size >= 1000 && !loginWindows.has(key)) {
      throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
    }
    window.attempts++;
    loginWindows.set(key, window);
  }

  return {
    identity, requireUser,
    async login(request, response, body) {
      throttle(request);
      const user = userByEmail.get(validateEmail(body.email));
      const valid = await verifyPassword(body.password, user?.password || dummyPassword);
      const current = user && userByEmail.get(user.email);
      if (!valid || !current || current.password !== user.password) {
        throw new HttpError(401, 'Email or password is incorrect, or access is inactive.');
      }
      return issueSession(request, response, current);
    },
    async redeem(request, response, body) {
      throttle(request);
      if (typeof body.token !== 'string' || !TOKEN_PATTERN.test(body.token)) {
        throw new HttpError(404, 'This invitation is unavailable.');
      }
      const hashedToken = digest(body.token);
      const lookup = db.prepare("SELECT * FROM invites WHERE token = ? AND status = 'pending' AND expires > ?");
      if (!lookup.get(hashedToken, now())) throw new HttpError(404, 'This invitation is unavailable.');
      const password = await hashPassword(body.password);
      const email = atomic(db, () => {
        const invite = lookup.get(hashedToken, now());
        if (!invite) throw new HttpError(404, 'This invitation is unavailable.');
        db.prepare("UPDATE invites SET status = 'active', token = NULL WHERE id = ?").run(invite.id);
        db.prepare("INSERT INTO users (email, password, role) VALUES (?, ?, 'guest') ON CONFLICT(email) DO UPDATE SET password = excluded.password WHERE users.role = 'guest'")
          .run(invite.email, password);
        revokeSessions.run(invite.email);
        return invite.email;
      });
      return issueSession(request, response, { email, role: 'guest' });
    },
    logout(request, response) {
      const token = sessionToken(request);
      if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(digest(token));
      response.setHeader('set-cookie', cookie('', 0));
    },
    invites() {
      const invites = db.prepare('SELECT id, email, status, created, expires FROM invites ORDER BY created DESC').all()
        .map(item => ({ ...item, status: item.status === 'pending' && item.expires <= now() ? 'expired' : item.status }));
      return { invites, limit: GUEST_LIMIT, used: invites.filter(item => ['active', 'pending'].includes(item.status)).length };
    },
    invite(value, ownerAddress) {
      const email = validateEmail(value);
      if (email === ownerAddress) throw new HttpError(400, 'The owner already has access.');
      return atomic(db, () => {
        const time = now();
        const existing = db.prepare('SELECT * FROM invites WHERE email = ?').get(email);
        if (existing?.status === 'active') throw new HttpError(409, 'This guest already has access.');
        const used = db.prepare("SELECT count(*) AS count FROM invites WHERE status = 'active' OR (status = 'pending' AND expires > ?)").get(time).count;
        const usesSlot = existing?.status === 'pending' && existing.expires > time;
        if (!usesSlot && used >= GUEST_LIMIT) throw new HttpError(409, 'All 10 guest slots are in use.');
        const id = existing?.id || randomUUID();
        const token = randomToken();
        const expires = time + INVITE_DURATION;
        db.prepare(`INSERT INTO invites (id, email, token, status, created, expires)
          VALUES (?, ?, ?, 'pending', ?, ?) ON CONFLICT(email) DO UPDATE SET
          token = excluded.token, status = 'pending', created = excluded.created, expires = excluded.expires`)
          .run(id, email, digest(token), time, expires);
        return { id, email, expires, path: '/invite#' + token };
      });
    },
    revoke(id) {
      return atomic(db, () => {
        const invite = db.prepare('SELECT email FROM invites WHERE id = ?').get(id);
        if (!invite) throw new HttpError(404, 'Invitation not found.');
        db.prepare("UPDATE invites SET status = 'revoked', token = NULL WHERE id = ?").run(id);
        revokeSessions.run(invite.email);
      });
    }
  };
}
