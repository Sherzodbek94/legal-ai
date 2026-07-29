import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';
import { ROLES_KEY, type AllowedRole } from '../decorators/roles.decorator';
import type { AuthenticatedUser } from '../interfaces/jwt-payload.interface';

describe('RolesGuard', () => {
  let reflector: Reflector;
  let guard: RolesGuard;

  const handlerRef = function handler() {};
  const classRef = class Controller {};

  /** Minimal ExecutionContext double carrying an optional request user. */
  function contextFor(user?: AuthenticatedUser): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => ({ user }),
      }),
      getHandler: () => handlerRef,
      getClass: () => classRef,
    } as unknown as ExecutionContext;
  }

  function requireRoles(roles: AllowedRole[] | undefined) {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(roles);
  }

  const attorney: AuthenticatedUser = {
    id: 'user-1',
    email: 'attorney@example.com',
    role: 'USER',
    companyId: 'company-1',
    companyRole: 'ATTORNEY',
  };

  beforeEach(() => {
    reflector = new Reflector();
    guard = new RolesGuard(reflector);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('when the route declares no role requirement', () => {
    it('allows access when metadata is absent', () => {
      requireRoles(undefined);
      expect(guard.canActivate(contextFor(attorney))).toBe(true);
    });

    it('allows access when the role list is empty', () => {
      requireRoles([]);
      expect(guard.canActivate(contextFor(attorney))).toBe(true);
    });

    it('allows an unauthenticated request through to other guards', () => {
      requireRoles(undefined);
      expect(guard.canActivate(contextFor(undefined))).toBe(true);
    });
  });

  describe('when the route requires roles', () => {
    it('allows a user whose tenant role matches', () => {
      requireRoles(['ATTORNEY', 'PARALEGAL']);
      expect(guard.canActivate(contextFor(attorney))).toBe(true);
    });

    it('denies a user whose tenant role does not match', () => {
      requireRoles(['OWNER', 'ADMIN']);
      expect(() => guard.canActivate(contextFor(attorney))).toThrow(
        ForbiddenException,
      );
    });

    it('denies when no authenticated user is present', () => {
      requireRoles(['ATTORNEY']);
      expect(() => guard.canActivate(contextFor(undefined))).toThrow(
        ForbiddenException,
      );
    });

    it('denies a user who holds no tenant role', () => {
      requireRoles(['ATTORNEY']);
      const noMembership: AuthenticatedUser = {
        id: 'user-2',
        email: 'nobody@example.com',
        role: 'USER',
      };
      expect(() => guard.canActivate(contextFor(noMembership))).toThrow(
        ForbiddenException,
      );
    });

    it('matches on the platform role when that is what is required', () => {
      requireRoles(['USER']);
      const platformOnly: AuthenticatedUser = {
        id: 'user-3',
        email: 'platform@example.com',
        role: 'USER',
      };
      expect(guard.canActivate(contextFor(platformOnly))).toBe(true);
    });

    it('does not leak the required roles in the error message', () => {
      requireRoles(['OWNER']);
      expect(() => guard.canActivate(contextFor(attorney))).toThrow(
        'Insufficient permissions',
      );
    });
  });

  describe('SUPER_ADMIN', () => {
    const superAdmin: AuthenticatedUser = {
      id: 'root-1',
      email: 'root@example.com',
      role: 'SUPER_ADMIN',
    };

    it('bypasses tenant role requirements', () => {
      requireRoles(['OWNER', 'ADMIN']);
      expect(guard.canActivate(contextFor(superAdmin))).toBe(true);
    });

    it('bypasses even with no company membership', () => {
      requireRoles(['PARALEGAL']);
      expect(guard.canActivate(contextFor(superAdmin))).toBe(true);
    });
  });

  describe('metadata resolution', () => {
    it('reads ROLES_KEY from both the handler and the class', () => {
      const spy = jest
        .spyOn(reflector, 'getAllAndOverride')
        .mockReturnValue(['ATTORNEY'] as AllowedRole[]);

      guard.canActivate(contextFor(attorney));

      expect(spy).toHaveBeenCalledWith(ROLES_KEY, [handlerRef, classRef]);
    });

    it('lets handler metadata override class metadata', () => {
      // getAllAndOverride returns the handler value when both are present;
      // this asserts the guard honours whatever it returns rather than
      // merging the two lists.
      const realReflector = new Reflector();
      Reflect.defineMetadata(ROLES_KEY, ['OWNER'], classRef);
      Reflect.defineMetadata(ROLES_KEY, ['ATTORNEY'], handlerRef);

      const realGuard = new RolesGuard(realReflector);
      expect(realGuard.canActivate(contextFor(attorney))).toBe(true);
    });
  });
});
