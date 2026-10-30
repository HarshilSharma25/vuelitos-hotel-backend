import argon2 from 'argon2';
import { prisma } from '../lib/prisma.js';
import { Role } from '@prisma/client';

async function main() {
  const email = process.argv[2];
  const password = process.argv[3];
  const roleInput = (process.argv[4] as Role) || Role.super_admin;

  if (!email || !password) {
    console.error('Usage: tsx src/cli/create-admin.ts <email> <password> [role]');
    process.exit(1);
  }

  const hash = await argon2.hash(password, { type: argon2.argon2id });

  const user = await prisma.staffUser.upsert({
    where: { email: email.toLowerCase() },
    update: {
      passwordHash: hash,
      role: roleInput,
    },
    create: {
      email: email.toLowerCase(),
      passwordHash: hash,
      role: roleInput,
    },
  });

  console.log(`Staff user created: ${user.email} (Role: ${user.role})`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
