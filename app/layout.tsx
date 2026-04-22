import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'PropSpotter CMA',
  description:
    'Automated comparable market analysis and negotiation reference numbers from PropSpotter.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en-AU">
      <body className="min-h-screen bg-gradient-to-b from-light-blue via-cream to-white text-slate-900">
        {children}
      </body>
    </html>
  );
}
