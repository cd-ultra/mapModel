import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { createJwtVerifier } from './jwtVerifier.js';

const secret = 'test-secret-value';

async function sign(payload: Record<string, unknown>, opts: { expired?: boolean } = {}) {
  const builder = new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject((payload['sub'] as string | undefined) ?? 'user-1')
    .setIssuedAt();
  builder.setExpirationTime(opts.expired ? Math.floor(Date.now() / 1000) - 60 : '1h');
  return builder.sign(new TextEncoder().encode(secret));
}

describe('createJwtVerifier', () => {
  it('resolves the subject of a validly signed token', async () => {
    const verify = createJwtVerifier(secret);
    const token = await sign({ sub: 'user-42' });
    await expect(verify(token)).resolves.toBe('user-42');
  });

  it('rejects a token signed with a different secret', async () => {
    const verify = createJwtVerifier(secret);
    const other = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('user-42')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode('wrong-secret'));
    await expect(verify(other)).resolves.toBeNull();
  });

  it('rejects an expired token', async () => {
    const verify = createJwtVerifier(secret);
    const token = await sign({ sub: 'user-42' }, { expired: true });
    await expect(verify(token)).resolves.toBeNull();
  });

  it('rejects a malformed token instead of throwing', async () => {
    const verify = createJwtVerifier(secret);
    await expect(verify('not-a-jwt')).resolves.toBeNull();
  });
});
