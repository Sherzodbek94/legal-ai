import { Badge } from '@/components/ui/badge';
import { Panel, PanelError } from '@/components/admin/panel';
import { apiGet } from '@/lib/api';
import { getSession } from '@/lib/session';

interface Preferences {
  enabledChannels: string[];
  email: string | null;
  phone: string | null;
  telegramLinked: boolean;
  quietHoursStart: number | null;
  quietHoursEnd: number | null;
  timezone: string;
}

interface NotifiableEvent {
  key: string;
  description: string;
  channels: string[];
  urgency: 'critical' | 'normal' | 'low';
}

export const metadata = { title: 'Settings' };

export default async function SettingsPage() {
  const [session, preferences, events] = await Promise.all([
    getSession(),
    apiGet<Preferences>('/notifications/preferences'),
    apiGet<NotifiableEvent[]>('/notifications/events'),
  ]);

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 px-4 py-8 sm:px-6 lg:px-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Your account and how the platform reaches you.
        </p>
      </div>

      <Panel title="Account">
        <dl className="divide-y divide-border">
          <Row label="Email" value={session.user?.email ?? '—'} />
          <Row label="Platform role" value={session.user?.role ?? '—'} />
          <Row label="Company role" value={session.user?.companyRole ?? '—'} />
          <Row label="Workspace" value={session.company?.name ?? '—'} />
        </dl>
      </Panel>

      <Panel
        title="Notifications"
        description="Which channels may reach you, and when"
      >
        {!preferences.ok ? (
          <PanelError result={preferences} />
        ) : (
          <>
            <div className="border-b border-border px-5 py-4">
              <p className="mb-2 text-sm font-medium">Channels</p>
              <div className="flex flex-wrap gap-2">
                {/* In-app is always on and is not a preference — it is the
                    user's own inbox, and offering a toggle would imply
                    otherwise. */}
                <Badge variant="secondary">In-app (always on)</Badge>
                {['EMAIL', 'SMS', 'TELEGRAM'].map((channel) => {
                  const enabled = preferences.data.enabledChannels.includes(channel);
                  return (
                    <Badge key={channel} variant={enabled ? 'success' : 'outline'}>
                      {channel === 'EMAIL'
                        ? 'Email'
                        : channel === 'SMS'
                          ? 'SMS'
                          : 'Telegram'}
                      {enabled ? '' : ' — off'}
                    </Badge>
                  );
                })}
              </div>
            </div>

            <dl className="divide-y divide-border">
              <Row label="Notification email" value={preferences.data.email ?? 'Not set'} />
              <Row label="Phone" value={preferences.data.phone ?? 'Not set'} />
              <Row
                label="Telegram"
                value={preferences.data.telegramLinked ? 'Linked' : 'Not linked'}
              />
              <Row
                label="Quiet hours"
                value={
                  preferences.data.quietHoursStart !== null &&
                  preferences.data.quietHoursEnd !== null
                    ? `${pad(preferences.data.quietHoursStart)}:00 – ${pad(preferences.data.quietHoursEnd)}:00`
                    : 'Not set'
                }
              />
              <Row label="Timezone" value={preferences.data.timezone} />
            </dl>

            <p className="border-t border-border px-5 py-3 text-xs text-muted-foreground">
              During quiet hours only in-app notifications are delivered. Critical
              alerts — a failed payment, a suspended account — always break
              through, because holding them until morning can cost you service.
            </p>
          </>
        )}
      </Panel>

      <Panel
        title="What you can be notified about"
        description="Events you can turn off; mandatory ones are not listed"
      >
        {!events.ok ? (
          <PanelError result={events} />
        ) : (
          <ul className="divide-y divide-border">
            {events.data.map((event) => (
              <li
                key={event.key}
                className="flex flex-wrap items-baseline justify-between gap-2 px-5 py-3"
              >
                <div className="min-w-0">
                  <p className="text-sm">{event.description}</p>
                  <p className="font-mono text-xs text-muted-foreground">
                    {event.key}
                  </p>
                </div>
                <div className="flex items-center gap-1.5">
                  <Badge
                    variant={
                      event.urgency === 'critical'
                        ? 'destructive'
                        : event.urgency === 'normal'
                          ? 'secondary'
                          : 'outline'
                    }
                  >
                    {event.urgency}
                  </Badge>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <p className="text-xs text-muted-foreground">
        This screen is read-only for now. Editing preferences goes through{' '}
        <code className="font-mono">PATCH /api/notifications/preferences</code>,
        which exists and is tested but has no form here yet.
      </p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 px-5 py-3">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium">{value}</dd>
    </div>
  );
}

function pad(hour: number): string {
  return String(hour).padStart(2, '0');
}
