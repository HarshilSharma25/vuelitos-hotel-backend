import '../src/config/env.js';
import fs from 'node:fs';
import path from 'node:path';
import { AvailabilityMode, Currency, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const csvPath = path.resolve(
  process.argv[2] ?? path.join(process.cwd(), 'data_migration/hotels.csv')
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

function asBool(value: string): boolean {
  return value.trim().toLowerCase() === 'true';
}

function asCurrency(value: string): Currency {
  return value.trim().toUpperCase() === 'EUR' ? Currency.EUR : Currency.USD;
}

function asMode(value: string): AvailabilityMode {
  return value.trim().toLowerCase() === 'api' ? AvailabilityMode.api : AvailabilityMode.manual;
}

async function main() {
  const text = fs.readFileSync(csvPath, 'utf8');
  const rows = parseCsv(text);
  let created = 0;
  let updated = 0;

  for (const row of rows) {
    const slug = row.hotel_slug?.trim();
    const name = row.hotel_name?.trim();
    if (!slug || !name) continue;

    const commission = Number(row.commission_percent);
    const star = Number(row.star_rating);
    const data = {
      name,
      destination: row.destination?.trim() || '',
      category: row.category?.trim() || '',
      starRating: Number.isFinite(star) && row.star_rating !== '' ? star : null,
      baseCurrency: asCurrency(row.base_currency ?? ''),
      isSoloDivisas: asBool(row.is_solo_divisas ?? ''),
      availabilityMode: asMode(row.availability_mode ?? ''),
      isActive: asBool(row.hotel_is_active ?? ''),
      description: row.description?.trim() || null,
      amenities: row.amenities
        ? row.amenities.split('|').map((item) => item.trim()).filter(Boolean)
        : [],
      coverImageKey: row.cover_storage_key?.trim() || null,
      defaultCommissionPercent: Number.isFinite(commission) ? commission : 10,
    };

    const existing = await prisma.hotel.findUnique({ where: { slug }, select: { id: true } });
    if (existing) {
      await prisma.hotel.update({ where: { slug }, data });
      updated++;
    } else {
      await prisma.hotel.create({ data: { slug, ...data } });
      created++;
    }
  }

  console.log(`Imported ${created} hotels, updated ${updated}. CSV ids were not used.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
