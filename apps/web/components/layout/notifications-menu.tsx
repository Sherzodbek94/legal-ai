'use client';

import { useCallback, useEffect, useState } from 'react';
import { Bell } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { apiBaseUrl } from '@/lib/api-config';
import { formatRelative } from '@/lib/format';

interface NotificationItem {
  id: string;
  event: string;
  title: string;
  body: string;
  readAt: string | null;
  createdAt: string;
}

/**
 * The notifications inbox.
 *
 * This button previously rendered with no `onClick` and no `href` — it was
 * decoration on top of a fully built notification backend
 * (`GET /notifications`, `unread-count`, `read-all`).
 *
 * The list is fetched when the menu opens rather than on mount: it is one
 * request per page load otherwise, on every page, for a panel most users
 * never expand. The unread *count* is cheap (a single indexed count) and is
 * fetched eagerly, because the badge has to be right before anyone clicks.
 */
export function NotificationsMenu() {
  const [count, setCount] = useState(0);
  const [items, setItems] = useState<NotificationItem[] | null>(null);
  const [open, setOpen] = useState(false);

  const loadCount = useCallback(async () => {
    try {
      const response = await fetch(`${apiBaseUrl}/notifications/unread-count`, {
        credentials: 'include',
      });
      if (!response.ok) return;
      const body = (await response.json()) as { count: number };
      setCount(body.count);
    } catch {
      // A failed badge count is not worth surfacing — the bell just shows none.
    }
  }, []);

  useEffect(() => {
    void loadCount();
  }, [loadCount]);

  async function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) return;

    setItems(null);
    try {
      const response = await fetch(`${apiBaseUrl}/notifications?take=8`, {
        credentials: 'include',
      });
      if (!response.ok) {
        setItems([]);
        return;
      }
      const body = (await response.json()) as { items: NotificationItem[] };
      setItems(body.items);
    } catch {
      setItems([]);
    }
  }

  async function markAllRead() {
    try {
      await fetch(`${apiBaseUrl}/notifications/read-all`, {
        method: 'POST',
        credentials: 'include',
      });
      setCount(0);
      setItems((current) =>
        current?.map((item) => ({ ...item, readAt: item.readAt ?? new Date().toISOString() })) ??
        null,
      );
    } catch {
      // Left as-is; the next page load re-reads the true count.
    }
  }

  return (
    <DropdownMenu open={open} onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative"
          aria-label={
            count > 0 ? `Notifications, ${count} unread` : 'Notifications'
          }
        >
          <Bell className="h-5 w-5" aria-hidden="true" />
          {count > 0 ? (
            <span
              aria-hidden="true"
              className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-medium leading-none text-destructive-foreground"
            >
              {count > 9 ? '9+' : count}
            </span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel className="flex items-center justify-between normal-case tracking-normal">
          <span className="text-sm font-medium">Notifications</span>
          {count > 0 ? (
            <button
              type="button"
              onClick={() => void markAllRead()}
              className="text-xs font-normal text-muted-foreground underline-offset-4 hover:underline"
            >
              Mark all read
            </button>
          ) : null}
        </DropdownMenuLabel>

        <DropdownMenuSeparator />

        {items === null ? (
          <div className="space-y-3 p-3">
            {[0, 1, 2].map((index) => (
              <div key={index} className="space-y-1.5">
                <Skeleton className="h-3.5 w-2/3" />
                <Skeleton className="h-3 w-full" />
              </div>
            ))}
          </div>
        ) : items.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">
            Nothing yet.
          </p>
        ) : (
          <ul className="max-h-80 overflow-y-auto">
            {items.map((item) => (
              <li
                key={item.id}
                className="border-b border-border px-3 py-2.5 last:border-b-0"
              >
                <div className="flex items-start gap-2">
                  {!item.readAt ? (
                    <span
                      aria-hidden="true"
                      className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
                    />
                  ) : (
                    <span aria-hidden="true" className="mt-1.5 h-1.5 w-1.5 shrink-0" />
                  )}
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{item.title}</p>
                    <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                      {item.body}
                    </p>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {formatRelative(item.createdAt)}
                    </p>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
