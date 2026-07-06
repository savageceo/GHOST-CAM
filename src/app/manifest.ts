import type { MetadataRoute } from "next";

// Makes the site an installable PWA: "Add to Home Screen" gives a standalone,
// chrome-less app — and on iOS 16.4+ that install is what unlocks Web Push.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "SAVAGE LAB",
    short_name: "SAVAGE LAB",
    description:
      "Private studio control — live cameras, sensors & lab telemetry, from anywhere.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#080a0d",
    theme_color: "#080a0d",
    icons: [
      { src: "/icon-192", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512", sizes: "512x512", type: "image/png", purpose: "any" },
      {
        src: "/icon-512",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
