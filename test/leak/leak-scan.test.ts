import { describe, it, expect } from 'vitest';
import * as catalogSchemas from '../../src/modules/catalog/schemas.js';
import * as bookingSchemas from '../../src/modules/bookings/schemas.js';
import * as ratesRoutes from '../../src/modules/rates/routes.js';

describe('Leak Scan Contract Tests', () => {
  const FORBIDDEN_WORDS = ['net_rate', 'commission', 'markup', 'internal_notes'];

  function checkSchemaForForbiddenKeys(obj: any, path = ''): string[] {
    const violations: string[] = [];
    if (!obj || typeof obj !== 'object') return violations;

    for (const [key, val] of Object.entries(obj)) {
      const currentPath = path ? `${path}.${key}` : key;
      const lowerKey = key.toLowerCase();

      for (const forbidden of FORBIDDEN_WORDS) {
        if (lowerKey.includes(forbidden)) {
          violations.push(`Found forbidden term '${forbidden}' at ${currentPath}`);
        }
      }

      if (typeof val === 'object' && val !== null) {
        // If it's a zod object schema, check shape
        if ((val as any)._def?.shape) {
          const shape = typeof (val as any)._def.shape === 'function'
            ? (val as any)._def.shape()
            : (val as any)._def.shape;
          violations.push(...checkSchemaForForbiddenKeys(shape, currentPath));
        } else if ((val as any)._def?.schema) {
          violations.push(...checkSchemaForForbiddenKeys((val as any)._def.schema, currentPath));
        } else {
          violations.push(...checkSchemaForForbiddenKeys(val, currentPath));
        }
      }
    }

    return violations;
  }

  it('ensures no public schemas expose sensitive pricing or internal notes', () => {
    const publicModules = [catalogSchemas, bookingSchemas, ratesRoutes];

    for (const mod of publicModules) {
      for (const [schemaName, schemaObj] of Object.entries(mod)) {
        if (typeof schemaObj === 'object' && schemaObj !== null) {
          const violations = checkSchemaForForbiddenKeys({ [schemaName]: schemaObj });
          expect(
            violations,
            `Leak scan failed in schema '${schemaName}': ${violations.join(', ')}`
          ).toEqual([]);
        }
      }
    }
  });
});
