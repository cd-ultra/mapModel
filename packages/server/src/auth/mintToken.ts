/**
 * Mints an HS256 bearer token for the shared-secret verifier in
 * `jwtVerifier.ts`. Stopgap until a real provider (Auth.js/Clerk) replaces
 * `verifyToken` — usage: `npm run mint-token -w @gme/server -- <userId>`.
 */

import { SignJWT } from 'jose';

const [userId] = process.argv.slice(2);
const secret = process.env['JWT_SECRET'];

if (!userId) {
  console.error('Usage: npm run mint-token -w @gme/server -- <userId>');
  process.exit(1);
}
if (!secret) {
  console.error('JWT_SECRET must be set in the environment to mint a token.');
  process.exit(1);
}

const token = await new SignJWT({})
  .setProtectedHeader({ alg: 'HS256' })
  .setSubject(userId)
  .setIssuedAt()
  .setExpirationTime('365d')
  .sign(new TextEncoder().encode(secret));

console.log(token);
