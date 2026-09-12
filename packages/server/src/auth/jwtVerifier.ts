/**
 * Minimal real `TokenVerifier`: HS256 bearer tokens signed with a shared
 * secret. This is the seam `middleware.ts` calls out for a provider swap
 * (Auth.js, Clerk, ...) — until one is wired in, tokens are minted with
 * `npm run mint-token -w @gme/server -- <userId>` and carry the user id as
 * `sub`.
 */

import { jwtVerify } from 'jose';
import type { TokenVerifier } from './middleware.js';

export function createJwtVerifier(secret: string): TokenVerifier {
  const key = new TextEncoder().encode(secret);

  return async (token) => {
    try {
      const { payload } = await jwtVerify(token, key);
      return typeof payload.sub === 'string' && payload.sub.length > 0 ? payload.sub : null;
    } catch {
      // Expired, malformed, or wrongly signed — all indistinguishable from
      // "not authenticated" to the caller.
      return null;
    }
  };
}
