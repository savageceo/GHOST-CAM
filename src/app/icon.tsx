import { ImageResponse } from "next/og";

// Static brand favicon (the camera-eye mark). The live green/red state is
// painted client-side in viewer.tsx by swapping <link rel="icon">; this is the
// default shown on the gate and before hydration.
export const size = { width: 64, height: 64 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          width: "100%",
          height: "100%",
          alignItems: "center",
          justifyContent: "center",
          background: "#0b0e13",
          borderRadius: 15,
        }}
      >
        <div
          style={{
            display: "flex",
            width: 36,
            height: 36,
            borderRadius: 18,
            border: "6px solid #38bdf8",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <div
            style={{
              width: 12,
              height: 12,
              borderRadius: 6,
              background: "#38bdf8",
            }}
          />
        </div>
      </div>
    ),
    { ...size },
  );
}
