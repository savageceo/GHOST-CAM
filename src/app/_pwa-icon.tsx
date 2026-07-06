import { ImageResponse } from "next/og";

// Shared PWA app-icon (the SAVAGE LAB reactor eye). Rendered at a couple sizes
// for the web manifest. The mark sits at ~34% so there's a maskable safe zone.
export function labIcon(size: number): ImageResponse {
  const ring = Math.round(size * 0.34);
  const dot = Math.round(size * 0.13);
  const border = Math.max(4, Math.round(size * 0.055));
  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          width: "100%",
          height: "100%",
          alignItems: "center",
          justifyContent: "center",
          background: "linear-gradient(135deg,#0b0e13,#12161d)",
        }}
      >
        <div
          style={{
            display: "flex",
            width: ring,
            height: ring,
            borderRadius: ring,
            border: `${border}px solid #38bdf8`,
            alignItems: "center",
            justifyContent: "center",
            boxShadow: "0 0 60px rgba(56,189,248,0.5)",
          }}
        >
          <div
            style={{
              width: dot,
              height: dot,
              borderRadius: dot,
              background: "#38bdf8",
            }}
          />
        </div>
      </div>
    ),
    { width: size, height: size },
  );
}
