/**
 * Waits until Postgres is genuinely accepting connections.
 *
 * `docker compose up -d` returns as soon as containers are *started*, and even
 * with a healthcheck there is a window where the server is up but still running
 * its initialisation scripts. Running `prisma migrate deploy` inside that window
 * fails with a connection error that reads like a configuration problem rather
 * than a timing one — which is exactly the confusing first-run experience this
 * avoids.
 *
 * Speaks the first byte of the real Postgres wire protocol (an SSLRequest)
 * rather than a full client library: no dependency, but a bare TCP connect is
 * not enough. During initdb's restart phase the postmaster can accept and
 * immediately drop a TCP connection before any backend exists to answer it —
 * `net.connect` reports that as success, and `prisma migrate deploy` then
 * fails on a connection Postgres never actually served. Waiting for the
 * single-byte SSLRequest reply ('S' or 'N') proves a backend is live and
 * reading protocol traffic, not just that the port is open.
 */
import net from 'node:net';

// Postgres SSLRequest: Int32 length (8) + Int32 request code (80877103).
const SSL_REQUEST = Buffer.from([0, 0, 0, 8, 4, 210, 22, 47]);

const url = process.env.DATABASE_URL
  ?? 'postgresql://postgres:postgres@localhost:5432/legaltech?schema=public';

const TIMEOUT_MS = 60_000;
const INTERVAL_MS = 500;

function parseTarget(connectionString) {
  try {
    const parsed = new URL(connectionString);
    return {
      host: parsed.hostname || 'localhost',
      port: Number(parsed.port || 5432),
    };
  } catch {
    return { host: 'localhost', port: 5432 };
  }
}

function tryConnect({ host, port }) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });

    const done = (ok) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };

    socket.once('connect', () => {
      socket.write(SSL_REQUEST);
      // A real backend replies with exactly one byte ('S' or 'N'). Anything
      // else — a reset, a timeout, an empty close — means nothing is actually
      // serving Postgres traffic on this port yet.
      socket.once('data', (chunk) => done(chunk.length >= 1));
      socket.once('close', () => done(false));
    });
    socket.once('error', () => done(false));
    // Shorter than the poll interval, so a hung connect cannot stall the loop.
    socket.setTimeout(400, () => done(false));
  });
}

const target = parseTarget(url);
const deadline = Date.now() + TIMEOUT_MS;

process.stdout.write(`Waiting for Postgres at ${target.host}:${target.port}`);

while (Date.now() < deadline) {
  if (await tryConnect(target)) {
    process.stdout.write(' — ready\n');
    process.exit(0);
  }
  process.stdout.write('.');
  await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
}

process.stdout.write('\n');
console.error(
  `Postgres did not become reachable at ${target.host}:${target.port} within ${TIMEOUT_MS / 1000}s.\n\n` +
    'Check:\n' +
    '  docker compose ps\n' +
    '  docker compose logs postgres\n\n' +
    'The image must be pgvector/pgvector:pg16 — the schema needs the vector extension.',
);
process.exit(1);
