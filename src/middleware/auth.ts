import { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';
import { Role } from '@prisma/client';
import { ForbiddenError, UnauthenticatedError, NotFoundError } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { redis } from '../lib/redis.js';
import { env } from '../config/env.js';
import { verifyUnifiedToken, VerifiedUserIdentity } from '../lib/jwt.js';
import { verifyAccessToken } from '../lib/ids.js';

export const COOKIE_NAME =
  env.NODE_ENV === 'production' ? '__Secure-vh_session' : 'vh_session';

export const ROLE_HIERARCHY: Record<Role, number> = {
  [Role.agent]: 1,
  [Role.admin]: 2,
  [Role.super_admin]: 3,
};

export interface StaffAuthUser {
  id: string;
  email: string;
  role: Role | string;
  sessionId?: string;
  roleId?: string;
  userType?: string;
  isCustomer?: boolean;
}

declare global {
  namespace Express {
    interface Request {
      user?: StaffAuthUser;
    }
  }
}

export function hashSessionToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Maps Flight Backend role string to Hotel Backend role enum.
 * SuperAdmin / Super -> super_admin (Level 3)
 * Admin -> admin (Level 2)
 * Agent / LimitedAdmin -> agent (Level 1)
 * USER / Customer -> null (Not staff)
 */
export function mapFlightRoleToHotelRole(role?: string): Role | null {
  if (!role) return null;
  const normalized = role.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  if (normalized.includes('super')) {
    return Role.super_admin;
  }
  if (normalized.includes('admin')) {
    return Role.admin;
  }
  if (normalized.includes('agent') || normalized.includes('limited')) {
    return Role.agent;
  }
  return null;
}

/**
 * Shared JWT authentication middleware for protected user/customer endpoints.
 * Requires a valid Bearer JWT issued by Flight Backend.
 */
export async function authenticateUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next(new UnauthenticatedError('Authentication token required'));
  }

  const token = authHeader.slice(7).trim();
  if (!token) {
    return next(new UnauthenticatedError('Authentication token required'));
  }

  try {
    const verified = await verifyUnifiedToken(token);
    const mappedRole = mapFlightRoleToHotelRole(verified.role) || verified.role;
    req.user = {
      id: verified.id,
      email: verified.email || '',
      role: mappedRole,
      roleId: verified.roleId,
      userType: verified.userType || (verified.role === 'USER' ? 'CUSTOMER' : 'STAFF'),
      isCustomer: verified.role === 'USER' || verified.userType === 'CUSTOMER',
    };
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Optional JWT authentication middleware:
 * Populates req.user if a valid Bearer token is provided, but does not reject unauthenticated calls.
 */
export async function authenticateUserOptional(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next();
  }

  const token = authHeader.slice(7).trim();
  if (!token) {
    return next();
  }

  try {
    const verified = await verifyUnifiedToken(token);
    const mappedRole = mapFlightRoleToHotelRole(verified.role) || verified.role;
    req.user = {
      id: verified.id,
      email: verified.email || '',
      role: mappedRole,
      roleId: verified.roleId,
      userType: verified.userType || (verified.role === 'USER' ? 'CUSTOMER' : 'STAFF'),
      isCustomer: verified.role === 'USER' || verified.userType === 'CUSTOMER',
    };
  } catch {
    // Optional token validation error should not block guest requests
  }
  next();
}

/**
 * Centralized Role Guard:
 * Supports Flight Backend centralized JWTs as primary, and legacy session tokens during migration.
 */
export function requireRole(minRole: Role) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      // 1. Check for Bearer token (Centralized JWT from Flight Backend)
      const authHeader = req.headers['authorization'];
      if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.slice(7).trim();

        // Check if token is a JWT (has three dot-separated components)
        if (token.split('.').length === 3) {
          const verified = await verifyUnifiedToken(token);
          const mappedRole = mapFlightRoleToHotelRole(verified.role);

          if (!mappedRole) {
            // Customer role (e.g. USER) trying to access staff admin endpoints
            throw new ForbiddenError('Insufficient permissions for this action');
          }

          const userLevel = ROLE_HIERARCHY[mappedRole] ?? 0;
          const minLevel = ROLE_HIERARCHY[minRole] ?? 999;
          if (userLevel < minLevel) {
            throw new ForbiddenError('Insufficient permissions for this action');
          }

          req.user = {
            id: verified.id,
            email: verified.email || '',
            role: mappedRole,
            roleId: verified.roleId,
            userType: 'STAFF',
            isCustomer: false,
          };

          return next();
        }
      }

      // 2. Same-origin check for browser cookie writes (applies strictly to cookie sessions)
      const writeMethods = ['POST', 'PUT', 'PATCH', 'DELETE'];
      if (writeMethods.includes(req.method.toUpperCase())) {
        const secFetchSite = req.headers['sec-fetch-site'] as string | undefined;
        if (secFetchSite && secFetchSite !== 'same-origin' && secFetchSite !== 'none') {
          throw new ForbiddenError('Cross-origin admin write prohibited');
        }

        const origin = req.headers['origin'] as string | undefined;
        if (origin) {
          const allowedOrigins = [
            env.PUBLIC_API_ORIGIN,
            ...env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()),
          ];
          if (!allowedOrigins.includes(origin)) {
            throw new ForbiddenError('Cross-origin admin write prohibited');
          }
        }
      }

      // 3. Fallback: Extract legacy session token from cookie (or header for legacy session tests)
      const sessionToken =
        req.cookies?.[COOKIE_NAME] ||
        req.cookies?.['vh_session'] ||
        req.cookies?.['__Secure-vh_session'] ||
        (authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : undefined);

      if (!sessionToken) {
        throw new UnauthenticatedError('Admin session missing or expired');
      }

      const tokenHash = hashSessionToken(sessionToken);
      let sessionData: { userId: string; email: string; role: Role; sessionId: string; expiresAt: string } | null = null;

      // Check redis cache first
      try {
        const cached = await redis.get(`session:${tokenHash}`);
        if (cached) {
          sessionData = JSON.parse(cached);
        }
      } catch {
        // Redis failure should not block session DB check
      }

      if (!sessionData) {
        const dbSession = await prisma.session.findUnique({
          where: { tokenHash },
          include: { user: true },
        });

        if (!dbSession || dbSession.expiresAt < new Date()) {
          if (dbSession) {
            await prisma.session.delete({ where: { id: dbSession.id } }).catch(() => {});
          }
          throw new UnauthenticatedError('Admin session missing or expired');
        }

        sessionData = {
          sessionId: dbSession.id,
          userId: dbSession.user.id,
          email: dbSession.user.email,
          role: dbSession.user.role,
          expiresAt: dbSession.expiresAt.toISOString(),
        };

        const ttlSec = Math.max(
          1,
          Math.floor((new Date(sessionData.expiresAt).getTime() - Date.now()) / 1000)
        );
        redis.set(`session:${tokenHash}`, JSON.stringify(sessionData), 'EX', ttlSec).catch(() => {});
      }

      // Role check
      const userLevel = ROLE_HIERARCHY[sessionData.role] ?? 0;
      const minLevel = ROLE_HIERARCHY[minRole] ?? 999;
      if (userLevel < minLevel) {
        throw new ForbiddenError('Insufficient permissions for this action');
      }

      req.user = {
        id: sessionData.userId,
        email: sessionData.email,
        role: sessionData.role,
        sessionId: sessionData.sessionId,
      };

      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Checks fine-grained resource permission for administrative operations.
 */
export function requirePermission(resource: string, action: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(new UnauthenticatedError('Authentication required'));
    }
    // Super admins have all permissions
    if (req.user.role === Role.super_admin || req.user.role === 'SuperAdmin') {
      return next();
    }
    // Check if permission was granted in token claims or mapped role
    const rawPayload = (req.user as any).rawPayload;
    if (rawPayload?.permissions && Array.isArray(rawPayload.permissions)) {
      const match = rawPayload.permissions.find((p: any) => p.name === resource);
      if (match && match.actions && match.actions.includes(action)) {
        return next();
      }
    }
    // Default fallback to role hierarchy
    const userLevel = ROLE_HIERARCHY[req.user.role as Role] ?? 0;
    if (userLevel >= ROLE_HIERARCHY[Role.admin]) {
      return next();
    }
    return next(new ForbiddenError(`Permission denied for ${resource}:${action}`));
  };
}

/**
 * Multi-tenant hotel access authorization:
 * Verifies staff member has permission to manage the specified hotel.
 */
export function authorizeHotelAccess() {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(new UnauthenticatedError('Authentication required'));
    }
    // Admins and SuperAdmins have platform-wide hotel access
    const userLevel = ROLE_HIERARCHY[req.user.role as Role] ?? 0;
    if (userLevel >= ROLE_HIERARCHY[Role.admin]) {
      return next();
    }
    return next(new ForbiddenError('Access forbidden to this hotel catalog'));
  };
}

/**
 * Authorizes access to a booking:
 * Allows if caller has:
 *  - Valid booking access token, OR
 *  - Authenticated user matching booking.userId, OR
 *  - Staff member with role agent+
 */
export function authorizeBookingOwner(booking: { userId?: string | null; accessKey: string }, token?: string, user?: StaffAuthUser): boolean {
  if (token) {
    if (verifyAccessToken(token, booking.accessKey)) {
      return true;
    }
  }

  if (user) {
    // Staff access (agent or higher)
    const userLevel = ROLE_HIERARCHY[user.role as Role] ?? 0;
    if (userLevel >= ROLE_HIERARCHY[Role.agent]) {
      return true;
    }

    // Customer ownership
    if (booking.userId && String(booking.userId) === String(user.id)) {
      return true;
    }
  }

  return false;
}
