import type { Metadata, Viewport } from 'next';
import './globals.css';
import { PwaManager } from '@/components/PwaManager';

export const viewport: Viewport = {
  themeColor: '#f59e0b',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  viewportFit: 'cover',
};

export const metadata: Metadata = {
  title: 'Hum & Keyboard Score Transcriber | Audio & MIDI to Score Studio',
  description: 'Real-time vocal humming, acoustic instrument pitch detection, and keyboard/MIDI performance transcription into numbered musical notation (簡譜).',
  applicationName: 'Hum & Keyboard Score Transcriber',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'Score Transcriber',
  },
  formatDetection: {
    telephone: false,
  },
  // NOTE: Do NOT set `manifest` here. Next.js auto-injects the manifest link from
  // app/manifest.ts — an explicit entry here would produce duplicate <link rel="manifest"> tags.
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: 'any' },
      { url: '/favicon.svg', type: 'image/svg+xml' },
      { url: '/icons/icon.svg', type: 'image/svg+xml' },
      { url: '/icons/icon-192x192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icons/icon-512x512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [
      { url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
      { url: '/icons/apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
    ],
    shortcut: ['/favicon.ico'],
  },
  openGraph: {
    title: 'Hum & Keyboard Score Transcriber | Audio & MIDI to Score Studio',
    description: 'Real-time vocal humming, acoustic instrument pitch detection, and keyboard/MIDI performance transcription into numbered musical notation (簡譜).',
    type: 'website',
    siteName: 'Score Transcriber Studio',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Hum & Keyboard Score Transcriber | Audio & MIDI to Score Studio',
    description: 'Real-time vocal humming, acoustic instrument pitch detection, and keyboard/MIDI performance transcription into numbered musical notation (簡譜).',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning className="antialiased">
        {children}
        <PwaManager />
      </body>
    </html>
  );
}
