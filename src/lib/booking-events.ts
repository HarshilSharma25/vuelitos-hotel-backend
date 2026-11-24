import mysql, { type ConnectionOptions } from 'mysql2/promise';
import { env } from '../config/env.js';

const CREATE_NO_UPDATE = `CREATE TRIGGER booking_events_no_update BEFORE UPDATE ON booking_events FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'booking_events is append-only'`;
const CREATE_NO_DELETE = `CREATE TRIGGER booking_events_no_delete BEFORE DELETE ON booking_events FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'booking_events is append-only'`;

/**
 * Prisma sends every query as a prepared statement. MySQL rejects
 * DROP TRIGGER and CREATE TRIGGER in that protocol (error 1295), so these
 * statements go out on a text-protocol connection instead.
 * Split on the last "@" so a password that contains "@" still parses.
 */
function mysqlConnectionOptions(databaseUrl: string): ConnectionOptions {
  const body = databaseUrl.trim().replace(/^mysql:\/\//i, '');
  const at = body.lastIndexOf('@');
  if (at === -1) {
    throw new Error('DATABASE_URL is missing a host');
  }
  const auth = body.slice(0, at);
  const hostAndDb = body.slice(at + 1);
  const colon = auth.indexOf(':');
  const user = decodeURIComponent(colon === -1 ? auth : auth.slice(0, colon));
  const password = colon === -1 ? '' : decodeURIComponent(auth.slice(colon + 1));
  const slash = hostAndDb.indexOf('/');
  const hostPort = (slash === -1 ? hostAndDb : hostAndDb.slice(0, slash)).split('?')[0];
  const database = decodeURIComponent(
    (slash === -1 ? '' : hostAndDb.slice(slash + 1)).split('?')[0],
  );
  const [host, portRaw] = hostPort.split(':');
  return {
    host,
    port: portRaw ? Number(portRaw) : 3306,
    user,
    password,
    database,
  };
}

async function executeDdl(sql: string): Promise<void> {
  const connection = await mysql.createConnection(mysqlConnectionOptions(env.DATABASE_URL));
  try {
    await connection.query(sql);
  } finally {
    await connection.end();
  }
}

/** Drop the append-only triggers, run the callback, then recreate them. */
export async function withMutableBookingEvents<T>(fn: () => Promise<T>): Promise<T> {
  await executeDdl('DROP TRIGGER IF EXISTS booking_events_no_update');
  await executeDdl('DROP TRIGGER IF EXISTS booking_events_no_delete');
  try {
    return await fn();
  } finally {
    await executeDdl(CREATE_NO_DELETE);
    await executeDdl(CREATE_NO_UPDATE);
  }
}
