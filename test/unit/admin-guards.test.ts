import { describe, it, expect } from 'vitest';
import { adminRouter } from '../../src/modules/admin/routes.js';

describe('Admin Router Stack Guard Check', () => {
  it('walks the router stack and verifies every admin route (except sign-in) has requireRole guard', () => {
    interface RouteInfo {
      path: string;
      methods: string[];
      hasRoleGuard: boolean;
    }

    const collectedRoutes: RouteInfo[] = [];

    function inspectLayer(layer: any, basePath = '') {
      if (layer.route) {
        const fullPath = (basePath + layer.route.path).replace(/\/+/g, '/');
        const methods = Object.keys(layer.route.methods);
        const stack = layer.route.stack;

        // Check if any handler in stack is requireRole
        // requireRole returns an async function (req, res, next)
        // We can inspect function names or behavior
        const hasGuard = stack.some((s: any) => {
          // If the middleware function is returned by requireRole
          return (
            s.name === 'requireRole' ||
            s.handle?.name === 'requireRole' ||
            s.handle?.toString().includes('ROLE_HIERARCHY') ||
            s.handle?.toString().includes('Cross-origin admin write prohibited')
          );
        });

        collectedRoutes.push({
          path: fullPath,
          methods,
          hasRoleGuard: hasGuard,
        });
      } else if (layer.name === 'router' && layer.handle?.stack) {
        // Nested router
        for (const subLayer of layer.handle.stack) {
          inspectLayer(subLayer, basePath);
        }
      }
    }

    for (const layer of adminRouter.stack) {
      inspectLayer(layer, '');
    }

    expect(collectedRoutes.length).toBeGreaterThan(15);

    const unprotectedRoutes: string[] = [];
    for (const route of collectedRoutes) {
      // The ONLY allowed unprotected route in /admin is /auth/sign-in
      if (route.path === '/auth/sign-in') {
        continue;
      }
      if (!route.hasRoleGuard) {
        unprotectedRoutes.push(`${route.methods.join(',').toUpperCase()} ${route.path}`);
      }
    }

    expect(
      unprotectedRoutes,
      `The following admin routes lack requireRole guard: ${unprotectedRoutes.join(', ')}`
    ).toEqual([]);
  });
});
