import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { createAdapter } from '@socket.io/redis-adapter';
import type { Server, Socket } from 'socket.io';
import { RedisService } from '../../../redis/redis.service';
import { ACCESS_TOKEN_COOKIE } from '../../auth/constants';
import type { JwtPayload } from '../../auth/interfaces/jwt-payload.interface';

/** Rooms are per user and per company, so a push can address either. */
export const userRoom = (userId: string) => `user:${userId}`;
export const companyRoom = (companyId: string) => `company:${companyId}`;

interface AuthenticatedSocket extends Socket {
  data: {
    userId?: string;
    companyId?: string;
  };
}

/**
 * In-app push over Socket.IO.
 *
 * Two things here are load-bearing:
 *
 *   * **Authentication happens on connect**, from the same HTTPOnly cookie the
 *     REST API uses. An unauthenticated socket is disconnected rather than left
 *     open, because a connected-but-anonymous socket that later joins a room is
 *     the shape of every websocket authorisation bug.
 *   * **The Redis adapter is mandatory in production.** Socket.IO's default
 *     in-memory adapter only reaches clients attached to the same process, so with
 *     more than one replica a notification emitted on pod A never reaches a user
 *     connected to pod B — and it fails silently, for a fraction of users, which is
 *     the worst possible failure shape.
 */
@WebSocketGateway({
  namespace: '/notifications',
  // Credentialed CORS needs an explicit origin; the browser rejects `*` when
  // cookies are in play, exactly as for the REST API.
  cors: { origin: true, credentials: true },
  // Websocket first, long-polling as a fallback for restrictive networks — which
  // corporate legal environments frequently are.
  transports: ['websocket', 'polling'],
})
export class NotificationGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(NotificationGateway.name);

  @WebSocketServer()
  private server!: Server;

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly redis: RedisService,
  ) {}

  async afterInit(): Promise<void> {
    try {
      // Separate connections: the Redis pub/sub protocol puts a subscribed client
      // into a mode where it cannot issue ordinary commands, so the shared
      // application client cannot be reused for either half.
      const pubClient = this.redis.client.duplicate();
      const subClient = this.redis.client.duplicate();

      this.server.adapter(createAdapter(pubClient, subClient));
      this.logger.log('Socket.IO Redis adapter attached; pushes span all replicas');
    } catch (error) {
      // Degraded, not broken: single-replica deployments work fine without it, so
      // this is a loud warning rather than a boot failure.
      this.logger.error(
        `Failed to attach the Redis adapter — in-app pushes will only reach clients on this replica: ${
          (error as Error)?.message ?? 'unknown error'
        }`,
      );
    }
  }

  async handleConnection(client: AuthenticatedSocket): Promise<void> {
    const token = extractToken(client);

    if (!token) {
      this.disconnect(client, 'no credentials presented');
      return;
    }

    try {
      const payload = await this.jwt.verifyAsync<JwtPayload>(token, {
        secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
        issuer: this.config.get<string>('JWT_ISSUER', 'legaltech-api'),
        audience: this.config.get<string>('JWT_AUDIENCE', 'legaltech-web'),
      });

      if (!payload?.sub) {
        this.disconnect(client, 'malformed token');
        return;
      }

      client.data.userId = payload.sub;
      client.data.companyId = payload.companyId;

      await client.join(userRoom(payload.sub));
      if (payload.companyId) {
        await client.join(companyRoom(payload.companyId));
      }

      this.logger.debug(`Socket connected for user ${payload.sub}`);
    } catch (error) {
      // An expired token is the common case, and the client's job is to refresh
      // and reconnect — so this is debug, not an error.
      this.logger.debug(
        `Rejected socket: ${(error as Error)?.message ?? 'invalid token'}`,
      );
      this.disconnect(client, 'invalid token');
    }
  }

  handleDisconnect(client: AuthenticatedSocket): void {
    if (client.data?.userId) {
      this.logger.debug(`Socket disconnected for user ${client.data.userId}`);
    }
  }

  /**
   * Pushes a notification to one user, on every device they have open.
   *
   * Fire-and-forget by design: a user with no socket open is not an error, they
   * simply read it from their inbox next time they load the app. The durable copy
   * is the `Notification` row, and the socket is only an optimisation on when they
   * notice it.
   */
  pushToUser(userId: string, event: string, payload: unknown): void {
    if (!this.server) return;
    this.server.to(userRoom(userId)).emit(event, payload);
  }

  /** Pushes to everyone in a tenant — used for workspace-wide changes. */
  pushToCompany(companyId: string, event: string, payload: unknown): void {
    if (!this.server) return;
    this.server.to(companyRoom(companyId)).emit(event, payload);
  }

  /**
   * Disconnects every socket belonging to a user.
   *
   * Called when an account is locked. Without it a suspended user keeps receiving
   * live pushes over a socket authenticated before the lock — the REST API refuses
   * them, but the socket was authorised once and never re-checked.
   */
  disconnectUser(userId: string): void {
    if (!this.server) return;
    this.server.in(userRoom(userId)).disconnectSockets(true);
  }

  private disconnect(client: Socket, reason: string): void {
    // The reason is emitted before disconnecting so the client can distinguish
    // "refresh your token" from "the network dropped" and avoid a reconnect loop.
    client.emit('unauthorized', { reason });
    client.disconnect(true);
  }
}

/**
 * Reads the access token from the handshake.
 *
 * Cookie first, matching the REST API's JwtStrategy. The `auth.token` field is the
 * fallback for non-browser clients, which have no cookie jar. The query string is
 * deliberately *not* accepted: query parameters end up in access logs, and a
 * bearer token in a log file is a credential leak.
 */
function extractToken(client: Socket): string | null {
  const auth = client.handshake.auth as { token?: unknown } | undefined;
  if (typeof auth?.token === 'string' && auth.token) return auth.token;

  const cookieHeader = client.handshake.headers?.cookie;
  if (!cookieHeader) return null;

  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;

    const name = part.slice(0, separator).trim();
    if (name === ACCESS_TOKEN_COOKIE) {
      return decodeURIComponent(part.slice(separator + 1).trim());
    }
  }

  return null;
}
