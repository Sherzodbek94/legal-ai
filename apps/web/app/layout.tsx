import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { cn } from '@/lib/utils';
import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-inter',
});

export const metadata: Metadata = {
  title: {
    default: 'LegalTech AI',
    template: '%s · LegalTech AI',
  },
  description: 'AI-powered matter, document, and contract intelligence for legal teams.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={cn(inter.variable, 'min-h-screen bg-background font-sans')}>
        {/*
          WCAG 2.1 AA 2.4.1 Bypass Blocks — visually hidden until focused, so
          keyboard users can jump past the sidebar and header navigation.
        */}
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-primary-foreground"
        >
          Skip to main content
        </a>
        {children}
      </body>
    </html>
  );
}
