import type { Metadata } from 'next';
import './globals.css';

const siteOrigin = process.env.SITE_ORIGIN ?? 'https://meshful.ai';
const assetRevision = 'v39-catalog-graph';
const versionedAsset = (path: string) => `${path}?release=${assetRevision}`;

export const metadata: Metadata = {
  metadataBase: new URL(siteOrigin),
  title: 'Meshful',
  description: 'Study tools for your AI agent.',
  openGraph: {
    title: 'Meshful',
    description: 'Study tools for your AI agent.',
    type: 'website',
    images: [
      {
        url: new URL(versionedAsset('/meshful-social-card-1200x630.png'), siteOrigin).toString(),
        width: 1200,
        height: 630,
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Meshful',
    description: 'Study tools for your AI agent.',
    images: [new URL(versionedAsset('/meshful-social-card-1200x630.png'), siteOrigin).toString()],
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <meta name="theme-color" content="#101114" />
        <link rel="icon" href={versionedAsset('/favicon.svg')} type="image/svg+xml" />
        <link rel="icon" href={versionedAsset('/favicon-32.png')} sizes="32x32" type="image/png" />
        <link rel="icon" href={versionedAsset('/favicon-16.png')} sizes="16x16" type="image/png" />
        <link rel="apple-touch-icon" href={versionedAsset('/apple-touch-icon.png')} sizes="180x180" />
        <link rel="stylesheet" href="/study/vendor/katex/katex.min.css" />
        <link rel="stylesheet" href={versionedAsset('/study/styles.css')} />
      </head>
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
