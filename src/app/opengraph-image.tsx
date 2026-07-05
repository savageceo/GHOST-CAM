import { ImageResponse } from "next/og";

// Branded share card — deliberately NOT the live frame (the dashboard is
// private/gated, so link unfurls must never leak the room).
export const alt = "SAVAGE LAB — Studio Control";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          width: "100%",
          height: "100%",
          background: "linear-gradient(135deg, #080a0d 0%, #12161d 100%)",
          color: "#e9edf2",
          padding: 90,
          justifyContent: "center",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 32 }}>
          <div
            style={{
              display: "flex",
              width: 128,
              height: 128,
              borderRadius: 64,
              border: "20px solid #38bdf8",
              alignItems: "center",
              justifyContent: "center",
              boxShadow: "0 0 60px rgba(56,189,248,0.45)",
            }}
          >
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: 22,
                background: "#38bdf8",
              }}
            />
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ fontSize: 84, fontWeight: 800, letterSpacing: 10 }}>
              SAVAGE LAB
            </div>
            <div style={{ fontSize: 26, letterSpacing: 18, color: "#5a6270" }}>
              STUDIO CONTROL
            </div>
          </div>
        </div>
        <div
          style={{
            marginTop: 48,
            fontSize: 32,
            color: "#8b93a1",
            maxWidth: 940,
            lineHeight: 1.4,
          }}
        >
          Private studio control — live cameras, sensors & lab telemetry, from
          anywhere.
        </div>
      </div>
    ),
    { ...size },
  );
}
