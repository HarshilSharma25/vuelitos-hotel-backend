import { prisma } from './prisma.js';

const CREATE_NO_UPDATE = `CREATE TRIGGER booking_events_no_update BEFORE UPDATE ON booking_events FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'booking_events is append-only'`;
const CREATE_NO_DELETE = `CREATE TRIGGER booking_events_no_delete BEFORE DELETE ON booking_events FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'booking_events is append-only'`;

/** Drop the append-only triggers, run the callback, then recreate them. */
export async function withMutableBookingEvents<T>(fn: () => Promise<T>): Promise<T> {
  await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS booking_events_no_update');
  await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS booking_events_no_delete');
  try {
    return await fn();
  } finally {
    await prisma.$executeRawUnsafe(CREATE_NO_DELETE);
    await prisma.$executeRawUnsafe(CREATE_NO_UPDATE);
  }
}
