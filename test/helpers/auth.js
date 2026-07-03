// Helpers for exercising endpoints that sit behind requireAuth.
import jwt from 'jsonwebtoken';

export const TEST_SESSION_SECRET = 'test-session-secret';

// A signed, currently-valid session cookie value.
export function sessionCookie(secret = process.env.SESSION_SECRET || TEST_SESSION_SECRET) {
  const token = jwt.sign({ user: 'tester' }, secret, { expiresIn: '8h' });
  return `wf_session=${token}`;
}

// Merge a valid session cookie into a request's headers.
export function authedHeaders(extra = {}) {
  return { cookie: sessionCookie(), ...extra };
}
