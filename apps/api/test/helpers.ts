/**
 * Shared setup for e2e suites.
 *
 * Boots a real Nest application against a real Postgres, configured exactly as
 * `main.ts` configures it — same pipes, same cookie parser, same global prefix.
 * A test harness that differs from the bootstrap is a harness that passes while
 * production fails.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import type { Server } from 'node:http';
import { PrismaClient } from '@legaltech/database';
import { AppModule } from '../src/app.module';

let prisma: PrismaClient | undefined;

export function db(): PrismaClient {
  prisma ??= new PrismaClient({
    datasources: { db: { url: process.env.DATABASE_URL } },
  });
  return prisma;
}

/** Boots the full application, mirroring main.ts. */
export async function createTestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestApplication({ rawBody: true });

  app.setGlobalPrefix('api', {
    exclude: ['health', 'health/live', 'health/ready', 'metrics'],
  });
  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  await app.init();
  return app;
}

export function server(app: INestApplication): Server {
  return app.getHttpServer() as Server;
}

/**
 * Empties every table between tests.
 *
 * One `TRUNCATE ... CASCADE` rather than per-table deletes: it is a single
 * statement, it resets sequences, and CASCADE handles the foreign-key ordering
 * that would otherwise have to be maintained by hand every time a table is added.
 *
 * `_prisma_migrations` is excluded — dropping it would make Prisma believe the
 * database is unmigrated on the next connection.
 */
export async function truncateAll(): Promise<void> {
  const client = db();

  const tables = await client.$queryRaw<{ tablename: string }[]>`
    SELECT tablename
      FROM pg_tables
     WHERE schemaname = 'public'
       AND tablename NOT LIKE '_prisma%'
  `;

  if (tables.length === 0) return;

  const list = tables.map((t) => `"public"."${t.tablename}"`).join(', ');
  await client.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

export async function closeDb(): Promise<void> {
  await prisma?.$disconnect();
  prisma = undefined;
}

/**
 * Reads a cookie value out of a Set-Cookie header collection.
 *
 * Auth cookies are HTTPOnly, so a test cannot read them from a document — the
 * response header is the only place they exist.
 */
export function readCookie(
  setCookie: string[] | string | undefined,
  name: string,
): string | undefined {
  const headers = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];

  for (const header of headers) {
    const [pair] = header.split(';');
    const separator = pair.indexOf('=');
    if (separator === -1) continue;
    if (pair.slice(0, separator).trim() === name) {
      return decodeURIComponent(pair.slice(separator + 1));
    }
  }
  return undefined;
}

/** All attributes of a Set-Cookie entry, for asserting flags. */
export function cookieAttributes(
  setCookie: string[] | string | undefined,
  name: string,
): string | undefined {
  const headers = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  return headers.find((header) => header.startsWith(`${name}=`));
}
