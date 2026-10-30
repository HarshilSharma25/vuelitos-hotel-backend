import { Router } from 'express';
import argon2 from 'argon2';
import crypto from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { redis } from '../../lib/redis.js';
import { validate } from '../../middleware/validate.js';
import { rateLimit } from '../../middleware/rate-limit.js';
import { requireRole, COOKIE_NAME, hashSessionToken } from '../../middleware/auth.js';
import { UnauthenticatedError } from '../../lib/errors.js';
import { env } from '../../config/env.js';

export const adminAuthRouter = Router();

const signInSchema = z.object({
  email: z.string().trim().email().toLowerCase(),
  password: z.string().min(8).max(128),
});

adminAuthRouter.post(
  '/auth/sign-in',
  rateLimit({ bucket: 'admin-signin', max: 5, windowSec: 60 }),
  validate({ body: signInSchema }),
  async (req, res, next) => {
    try {
      const user = await prisma.staffUser.findUnique({
        where: { email: req.body.email },
      });

      if (!user) {
        throw new UnauthenticatedError('Invalid email or password');
      }

      const valid = await argon2.verify(user.passwordHash, req.body.password);
      if (!valid) {
        throw new UnauthenticatedError('Invalid email or password');
      }

      // Generate 12-hour session
      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = hashSessionToken(rawToken);
      const twelveHoursMs = 12 * 60 * 60 * 1000;
      const expiresAt = new Date(Date.now() + twelveHoursMs);

      const session = await prisma.session.create({
        data: {
          tokenHash,
          userId: user.id,
          expiresAt,
          userAgent: req.headers['user-agent'] || null,
        },
      });

      // Cache session in Redis
      const sessionCache = {
        sessionId: session.id,
        userId: user.id,
        email: user.email,
        role: user.role,
        expiresAt: expiresAt.toISOString(),
      };
      await redis.set(
        `session:${tokenHash}`,
        JSON.stringify(sessionCache),
        'EX',
        12 * 3600
      ).catch(() => {});

      res.cookie(COOKIE_NAME, rawToken, {
        httpOnly: true,
        secure: env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: twelveHoursMs,
        path: '/',
      });

      return res.json({
        data: {
          token: rawToken, // For API client convenience
          user: {
            id: user.id,
            email: user.email,
            role: user.role,
          },
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

adminAuthRouter.post('/auth/sign-out', requireRole('agent'), async (req, res, next) => {
  try {
    if (req.user?.sessionId) {
      await prisma.session.delete({ where: { id: req.user.sessionId } }).catch(() => {});
    }
    const token =
      req.cookies?.[COOKIE_NAME] ||
      req.cookies?.['vh_session'] ||
      req.cookies?.['__Secure-vh_session'];
    if (token) {
      await redis.del(`session:${hashSessionToken(token)}`).catch(() => {});
    }
    res.clearCookie(COOKIE_NAME, { path: '/' });
    res.json({ data: { success: true } });
  } catch (err) {
    next(err);
  }
});

adminAuthRouter.get('/auth/me', requireRole('agent'), (req, res) => {
  return res.json({
    data: {
      user: {
        id: req.user!.id,
        email: req.user!.email,
        role: req.user!.role,
      },
    },
  });
});
