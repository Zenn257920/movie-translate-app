import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Movie Translate — တရုတ် Video ကို မြန်မာအသံနဲ့',
  description:
    'Upload a Chinese video and get back a Burmese AI voiceover recap + Burmese subtitles. Runs fully in your browser — no server, no API keys.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="my">
      <body>{children}</body>
    </html>
  );
}
