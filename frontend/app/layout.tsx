import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'Jhar Samadhan — SIH 26043',
  description:
    'Crowdsourcing-to-resolution ecosystem for the Government of Jharkhand: citizen intake, AI triage, academic claims, industry partnerships and closed-loop governance.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-slate-100 text-slate-900 antialiased">{children}</body>
    </html>
  );
}
