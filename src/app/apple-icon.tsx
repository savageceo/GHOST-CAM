import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          width: "100%",
          height: "100%",
          alignItems: "center",
          justifyContent: "center",
          background: "linear-gradient(135deg, #0b0e13, #12161d)",
        }}
      >
        <div
          style={{
            display: "flex",
            width: 104,
            height: 104,
            borderRadius: 52,
            border: "16px solid #38bdf8",
            alignItems: "center",
            justifyContent: "center",
            boxShadow: "0 0 40px rgba(56,189,248,0.5)",
          }}
        >
          <div
            style={{
              width: 34,
              height: 34,
              borderRadius: 17,
              background: "#38bdf8",
            }}
          />
        </div>
      </div>
    ),
    { ...size },
  );
}
