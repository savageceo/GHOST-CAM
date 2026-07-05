import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_SITE_URL ?? "https://room-watch-six.vercel.app",
  ),
  title: { default: "SAVAGE LAB", template: "%s — SAVAGE LAB" },
  description:
    "Private studio control — live cameras, sensors & lab telemetry, from anywhere.",
  applicationName: "SAVAGE LAB",
  robots: { index: false, follow: false },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "SAVAGE LAB",
  },
  openGraph: {
    title: "SAVAGE LAB — Studio Control",
    description:
      "Private studio control — live cameras, sensors & lab telemetry, from anywhere.",
    siteName: "SAVAGE LAB",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "SAVAGE LAB — Studio Control",
    description: "Private studio control — live cameras, sensors & lab telemetry.",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#080a0d",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
