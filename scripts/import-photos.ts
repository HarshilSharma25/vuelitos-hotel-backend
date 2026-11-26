import '../src/config/env.js';
import fs from 'node:fs';
import path from 'node:path';
import { ImageStatus, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const csvPath = path.resolve(
  process.argv[2] ?? path.join(process.cwd(), 'data_migration/photos.csv')
);

function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') {
      field += c;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }

  const [header, ...body] = rows.filter((r) => r.some((cell) => cell.trim() !== ''));
  if (!header) return [];
  return body.map((cells) => {
    const record: Record<string, string> = {};
    header.forEach((name, index) => {
      record[name] = cells[index] ?? '';
    });
    return record;
  });
}

async function main() {
  const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
  const hotels = await prisma.hotel.findMany({ select: { id: true, name: true } });
  const hotelIdByName = new Map(hotels.map((hotel) => [hotel.name.trim().toLowerCase(), hotel.id]));

  let created = 0;
  let updated = 0;
  let skipped = 0;
  const missing = new Set<string>();

  for (const row of rows) {
    const name = row.hotel_name?.trim();
    const publicUrl = row.public_url?.trim();
    if (!name || !publicUrl) {
      skipped++;
      continue;
    }

    const hotelId = hotelIdByName.get(name.toLowerCase());
    if (!hotelId) {
      missing.add(name);
      skipped++;
      continue;
    }

    const sort = Number(row.sort_order);
    const data = {
      key: publicUrl,
      sourceUrl: publicUrl,
      sourceKind: row.source_kind?.trim() || null,
      status: ImageStatus.published,
      sortOrder: Number.isFinite(sort) && row.sort_order !== '' ? sort : 0,
      alt: row.alt?.trim() || null,
    };

    const existing = await prisma.hotelImage.findFirst({
      where: { hotelId, key: publicUrl },
      select: { id: true },
    });
    if (existing) {
      await prisma.hotelImage.update({ where: { id: existing.id }, data });
      updated++;
    } else {
      await prisma.hotelImage.create({ data: { hotelId, ...data } });
      created++;
    }

    if (row.is_cover?.trim().toLowerCase() === 'true') {
      await prisma.hotel.update({
        where: { id: hotelId },
        data: { coverImageKey: publicUrl },
      });
    }
  }

  console.log(`Imported ${created} photos, updated ${updated}, skipped ${skipped}.`);
  if (missing.size) {
    console.log(`No hotel for: ${[...missing].join(', ')}`);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
