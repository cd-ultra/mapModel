import { describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { AuthError, authenticate } from './middleware.js';

function run(
  middleware: ReturnType<typeof authenticate>,
  authorization?: string,
): Promise<{ req: Request; error: unknown }> {
  const req = {
    header: (name: string) =>
      name.toLowerCase() === 'authorization' ? authorization : undefined,
  } as unknown as Request;

  return new Promise((resolve) => {
    const next: NextFunction = (error?: unknown) => resolve({ req, error });
    middleware(req, {} as Response, next);
  });
}

describe('authenticate', () => {
  it('refuses to start unauthenticated in production', () => {
    expect(() => authenticate({ required: false, nodeEnv: 'production' })).toThrow(
      /AUTH_REQUIRED must be true in production/,
    );
  });

  it('allows anonymous requests when auth is optional', async () => {
    const { req, error } = await run(authenticate({ required: false, nodeEnv: 'test' }));
    expect(error).toBeUndefined();
    expect(req.userId).toBeNull();
  });

  it('rejects a missing token when auth is required', async () => {
    const { error } = await run(authenticate({ required: true, nodeEnv: 'test' }));
    expect(error).toBeInstanceOf(AuthError);
  });

  it('rejects every token by default — the stub verifier trusts nothing', async () => {
    const { error } = await run(
      authenticate({ required: true, nodeEnv: 'test' }),
      'Bearer anything',
    );
    expect(error).toBeInstanceOf(AuthError);
  });

  it('accepts a token the verifier resolves to a user', async () => {
    const verifyToken = vi.fn(() => 'user-42');
    const { req, error } = await run(
      authenticate({ required: true, verifyToken, nodeEnv: 'test' }),
      'Bearer good-token',
    );

    expect(error).toBeUndefined();
    expect(req.userId).toBe('user-42');
    expect(verifyToken).toHaveBeenCalledWith('good-token');
  });

  it('handles a case-insensitive Bearer prefix and trims the token', async () => {
    const verifyToken = vi.fn(() => 'user-42');
    await run(
      authenticate({ required: true, verifyToken, nodeEnv: 'test' }),
      'bearer   spaced-token  ',
    );
    expect(verifyToken).toHaveBeenCalledWith('spaced-token');
  });

  it('rejects a token the verifier declines', async () => {
    const { error } = await run(
      authenticate({ required: true, verifyToken: () => null, nodeEnv: 'test' }),
      'Bearer bad',
    );
    expect(error).toBeInstanceOf(AuthError);
  });

  it('falls back to anonymous for a bad token when auth is optional', async () => {
    const { req, error } = await run(
      authenticate({ required: false, verifyToken: () => null, nodeEnv: 'test' }),
      'Bearer bad',
    );
    expect(error).toBeUndefined();
    expect(req.userId).toBeNull();
  });

  it('turns a verifier crash into an auth error, not a 500', async () => {
    const { error } = await run(
      authenticate({
        required: true,
        verifyToken: () => {
          throw new Error('provider down');
        },
        nodeEnv: 'test',
      }),
      'Bearer x',
    );
    expect(error).toBeInstanceOf(AuthError);
  });

  it('supports an async verifier', async () => {
    const { req } = await run(
      authenticate({
        required: true,
        verifyToken: async () => 'async-user',
        nodeEnv: 'test',
      }),
      'Bearer x',
    );
    expect(req.userId).toBe('async-user');
  });
});
