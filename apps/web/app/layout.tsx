import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'LegalTech AI',
  description: 'AI-powered LegalTech SaaS platform',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
