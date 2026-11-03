import { z } from 'zod';

export const quotePublicViewSchema = z.object({
  code: z.string(),
  status: z.enum(['draft', 'sent', 'accepted', 'declined', 'expired']),
  lines: z.array(z.any()),
  expires_at: z.string(),
});
