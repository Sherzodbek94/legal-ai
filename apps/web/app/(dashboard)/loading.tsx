import { PageSkeleton } from '@/components/ui/skeleton';

/**
 * Shown while any dashboard route resolves its data.
 *
 * Every page here is a server component doing a blocking `await` on the API.
 * Without this file Next.js keeps the *previous* page on screen until the new
 * one is ready, so a slow request looks like a click that did nothing.
 */
export default function DashboardLoading() {
  return <PageSkeleton />;
}
