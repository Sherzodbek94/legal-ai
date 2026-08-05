import { cache } from 'react';
import { apiGet } from './api';

export interface SessionUser {
  id: string;
  email: string;
  role: 'SUPER_ADMIN' | 'USER';
  companyId?: string;
  companyRole?: string;
  impersonation?: {
    sessionId: string;
    impersonatorId: string;
    impersonatorEmail: string;
  };
  /** Included by `/auth/me` so the shell needs no second request. */
  company: SessionCompany | null;
}

export interface SessionCompany {
  id: string;
  name: string;
  legalName: string | null;
}

export interface Session {
  user: SessionUser | null;
  company: SessionCompany | null;
  isSuperAdmin: boolean;
  isImpersonating: boolean;
}

const ANONYMOUS: Session = {
  user: null,
  company: null,
  isSuperAdmin: false,
  isImpersonating: false,
};

/**
 * The current session, fetched once per request.
 *
 * ONE request, and both halves of that matter.
 *
 * `cache()` dedupes across a single render pass: the layout, the header, and the
 * sidebar all need the signed-in user, and without it each would issue its own
 * `/auth/me` — three round trips per page, each re-authenticated and
 * re-validated by the API.
 *
 * The company arrives inside `/auth/me` rather than from a second call to
 * `/companies/:id`. Fetching it separately meant two *sequential* requests on
 * every page — the second cannot start until the first returns the companyId —
 * which put a full round trip on the critical path of every navigation.
 *
 * Returns an anonymous session rather than throwing. The shell renders for
 * signed-out users too, and a layout that throws produces a blank error page
 * where a login prompt belongs.
 */
export const getSession = cache(async (): Promise<Session> => {
  const me = await apiGet<SessionUser>('/auth/me');
  if (!me.ok) return ANONYMOUS;

  const user = me.data;

  return {
    user,
    company: user.company ?? null,
    isSuperAdmin: user.role === 'SUPER_ADMIN',
    isImpersonating: Boolean(user.impersonation),
  };
});
