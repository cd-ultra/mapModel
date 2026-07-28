/**
 * Request identity.
 *
 * The plan calls for Auth.js or Clerk. Rather than hard-wire either, the app
 * depends on this narrow `authenticate` middleware: it puts a `userId` on the
 * request and nothing else. Dropping in a real provider means replacing
 * `verifyToken` with that provider's session/JWT check — no route changes.
 *
 * With `AUTH_REQUIRED=false` (the default for local development) every request
 * is attributed to a single anonymous user so the API is usable before auth is
 * wired up. It refuses to do that when `NODE_ENV=production`.
 */

import type { NextFunction, Request, Response } from 'express';

declare module 'express-serve-static-core' {
  interface Request {
    userId?: string | null;
  }
}

/** Stable id for unauthenticated local development. */
export const ANONYMOUS_USER_ID = null;

export class AuthError extends Error {
  readonly status = 401;
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

export type TokenVerifier = (token: string) => Promise<string | null> | string | null;

/**
 * Placeholder verifier. It deliberately accepts nothing: leaving a
 * "any token works" stub in an auth path is how test credentials reach
 * production. Replace this with the provider's verification call.
 */
const rejectAllTokens: TokenVerifier = () => null;

export interface AuthOptions {
  required: boolean;
  verifyToken?: TokenVerifier;
  nodeEnv?: string;
}

export function authenticate(options: AuthOptions) {
  const verify = options.verifyToken ?? rejectAllTokens;
  const isProduction = (options.nodeEnv ?? process.env['NODE_ENV']) === 'production';

  if (!options.required && isProduction) {
    throw new Error(
      'AUTH_REQUIRED must be true in production: refusing to start an unauthenticated multi-user API.',
    );
  }

  return function authenticateRequest(req: Request, _res: Response, next: NextFunction): void {
    const header = req.header('authorization');
    const token = header?.toLowerCase().startsWith('bearer ')
      ? header.slice(7).trim()
      : null;

    if (!token) {
      if (options.required) {
        next(new AuthError('Missing bearer token'));
        return;
      }
      req.userId = ANONYMOUS_USER_ID;
      next();
      return;
    }

    // Deferred into the chain rather than `Promise.resolve(verify(token))`:
    // JWT libraries routinely throw synchronously on a malformed token, and
    // that would escape this middleware as an unhandled 500 instead of a 401.
    Promise.resolve()
      .then(() => verify(token))
      .then((userId) => {
        if (!userId) {
          if (options.required) {
            next(new AuthError('Invalid or expired token'));
            return;
          }
          req.userId = ANONYMOUS_USER_ID;
          next();
          return;
        }
        req.userId = userId;
        next();
      })
      .catch(() => next(new AuthError('Could not verify the token')));
  };
}
