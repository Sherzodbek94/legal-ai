import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  ArrowRight,
  Bot,
  FileCheck,
  Scale,
  ScanSearch,
  ShieldCheck,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { getSession } from '@/lib/session';

export const metadata = { title: 'AI-assisted legal document generation for Uzbekistan' };

const FEATURES = [
  {
    icon: Bot,
    title: 'AI-drafted documents',
    description:
      'Generate contracts and legal documents from your template library, with a human reviewer in the loop for every clause the model is unsure about.',
  },
  {
    icon: FileCheck,
    title: 'Multi-role approval chains',
    description:
      'Every document moves through the sign-off your organisation requires before it can be exported — never generated and sent in the same step.',
  },
  {
    icon: ScanSearch,
    title: 'Search across scans and drafts',
    description:
      'OCR for Uzbek Latin, Uzbek Cyrillic, and Russian, combined with hybrid keyword and meaning-based search across everything your team has uploaded.',
  },
  {
    icon: ShieldCheck,
    title: 'Built for Uzbekistan',
    description:
      'Sign in with OneID (id.egov.uz), an SMS code, or Google. STIR/OKED/MFO registry identifiers and Click, Payme, and Uzum for billing — not bolted on afterward.',
  },
];

/**
 * The public landing page. Outside the `(dashboard)` route group, and the one
 * page in the app anonymous middleware traffic is allowed to reach — see
 * `middleware.ts`.
 */
export default async function HomePage() {
  // Signed in already: this page has nothing further to offer them. Bounce
  // straight to wherever their session actually belongs.
  const session = await getSession();
  if (session.user) {
    redirect(session.company || session.isSuperAdmin ? '/dashboard' : '/onboarding');
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-border">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-2.5">
            <span
              aria-hidden="true"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground"
            >
              <Scale className="h-4 w-4" />
            </span>
            <span className="text-sm font-semibold tracking-tight">LegalTech AI</span>
          </div>
          <nav className="flex items-center gap-3">
            <Button asChild variant="ghost">
              <Link href="/login">Sign in</Link>
            </Button>
            <Button asChild>
              <Link href="/register">Get started</Link>
            </Button>
          </nav>
        </div>
      </header>

      <main id="main-content" tabIndex={-1} className="flex-1 focus:outline-none">
        <section className="mx-auto w-full max-w-6xl px-4 py-20 sm:px-6 lg:px-8">
          {/* The one place in the app where the entrance is staged rather than
              a single fade: this is the first thing a visitor sees, and the
              headline, the subheading, and the two actions arriving in that
              order is the order they are meant to be read in. */}
          <div className="stagger mx-auto max-w-2xl text-center">
            <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
              Legal document generation, review, and approval — built for Uzbekistan
            </h1>
            <p className="mt-6 text-lg text-muted-foreground">
              AI-assisted drafting, multi-role approval, and searchable document
              intelligence for law firms and in-house legal teams. Uzbek and
              Russian text handled natively, from OCR to the generated PDF.
            </p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              <Button asChild size="lg">
                <Link href="/register">
                  Register your company
                  <ArrowRight aria-hidden="true" />
                </Link>
              </Button>
              <Button asChild size="lg" variant="outline">
                <Link href="/login">Sign in</Link>
              </Button>
            </div>
          </div>
        </section>

        <section
          aria-labelledby="features-heading"
          className="border-t border-border bg-card/50"
        >
          <div className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 lg:px-8">
            <h2 id="features-heading" className="sr-only">
              Features
            </h2>
            <dl className="stagger grid gap-8 sm:grid-cols-2">
              {FEATURES.map((feature) => {
                const Icon = feature.icon;
                return (
                  <div key={feature.title} className="flex gap-4">
                    <span
                      aria-hidden="true"
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"
                    >
                      <Icon className="h-5 w-5" />
                    </span>
                    <div>
                      <dt className="font-medium text-foreground">{feature.title}</dt>
                      <dd className="mt-1 text-sm text-muted-foreground">
                        {feature.description}
                      </dd>
                    </div>
                  </div>
                );
              })}
            </dl>
          </div>
        </section>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto w-full max-w-6xl px-4 py-6 text-center text-xs text-muted-foreground sm:px-6 lg:px-8">
          Access is provisioned per company. Registering creates a new
          company workspace, with you as its owner.
        </div>
      </footer>
    </div>
  );
}
