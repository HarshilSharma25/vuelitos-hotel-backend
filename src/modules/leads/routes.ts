import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { rateLimit } from '../../middleware/rate-limit.js';
import { validate } from '../../middleware/validate.js';
import { sendData } from '../../middleware/response.js';

export const leadRouter = Router();

const createLeadSchema = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.string().trim().email().max(254).toLowerCase(),
  phone: z.string().trim().max(30).optional(),
  message: z.string().trim().max(1000).optional(),
});

const leadCreatedResponseSchema = z.object({
  id: z.string(),
});

leadRouter.post(
  '/leads',
  rateLimit({ bucket: 'leads-create', max: 10, windowSec: 600 }),
  validate({ body: createLeadSchema }),
  async (req, res, next) => {
    try {
      const lead = await prisma.lead.create({
        data: {
          name: req.body.name,
          email: req.body.email,
          phone: req.body.phone || null,
          message: req.body.message || null,
        },
      });

      sendData(res.status(201), leadCreatedResponseSchema, { id: lead.id });
    } catch (err) {
      next(err);
    }
  }
);
