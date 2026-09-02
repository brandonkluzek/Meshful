import type { Metadata } from 'next';
import './globals.css';

const siteOrigin = process.env.SITE_ORIGIN ?? 'http://localhost:3000';

export const metadata: Metadata = {
  metadataBase: new URL(siteOrigin),
  title: 'Meshful',
  description:
    'Connect terms. Build understanding. Definition recall, spaced review, and readable prerequisite maps in one agent-ready study workspace.',
  openGraph: {
    title: 'Meshful',
    description: 'Connect terms. Build understanding.',
    type: 'website',
    images: [
      {
        url: new URL('/og.png', siteOrigin).toString(),
        width: 1200,
        height: 630,
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Meshful',
    description: 'Connect terms. Build understanding.',
    images: [new URL('/og.png', siteOrigin).toString()],
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <meta name="theme-color" content="#101114" />
        <link rel="icon" href="/favicon.svg" />
        <link rel="stylesheet" href="/study/vendor/katex/katex.min.css" />
        <link rel="stylesheet" href="/study/styles.css" />
      </head>
      <body>{children}</body>
    </html>
  );
}
