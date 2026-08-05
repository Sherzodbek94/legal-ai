'use client';

import { LogOut, Settings, UserRound } from 'lucide-react';
import Link from 'next/link';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { apiBaseUrl } from '@/lib/api-config';

/**
 * Account menu.
 *
 * The email is passed in from the server-rendered header rather than fetched
 * here. This component previously displayed a hardcoded "Dana Whitfield" for
 * every user, which reads as a bug the moment anyone signs in.
 */
export function UserMenu({ email }: { email: string | null }) {
  const label = email ?? 'Not signed in';
  const initials = toInitials(email);

  async function signOut() {
    // Credentials included: the refresh cookie is HTTPOnly on the API's origin
    // and is what the endpoint revokes.
    await fetch(`${apiBaseUrl}/auth/logout`, {
      method: 'POST',
      credentials: 'include',
    }).catch(() => undefined);

    // Full reload rather than a client navigation: every cached server component
    // was rendered for the previous identity and must be discarded. Straight to
    // `/login` rather than `/` — the middleware would bounce it there anyway,
    // this just skips the extra round trip.
    window.location.href = '/login';
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Account menu for ${label}`}
          className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <Avatar>
            <AvatarFallback>{initials}</AvatarFallback>
          </Avatar>
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="normal-case tracking-normal">
          <span className="flex flex-col">
            <span className="truncate text-sm font-medium text-popover-foreground">
              {label}
            </span>
          </span>
        </DropdownMenuLabel>

        <DropdownMenuSeparator />

        <DropdownMenuItem asChild>
          <Link href="/settings">
            <UserRound className="mr-2 h-4 w-4" aria-hidden="true" />
            Profile
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/settings">
            <Settings className="mr-2 h-4 w-4" aria-hidden="true" />
            Settings
          </Link>
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        <DropdownMenuItem onSelect={() => void signOut()}>
          <LogOut className="mr-2 h-4 w-4" aria-hidden="true" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Two letters from the email local part; a neutral fallback when absent. */
function toInitials(email: string | null): string {
  if (!email) return '??';

  const local = email.split('@')[0] ?? '';
  const parts = local.split(/[._-]/).filter(Boolean);

  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return local.slice(0, 2).toUpperCase() || '??';
}
