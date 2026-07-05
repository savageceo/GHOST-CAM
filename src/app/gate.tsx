"use client";

import { useState } from "react";

export default function Gate({ configured }: { configured: boolean }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);

  async function unlock(event: React.FormEvent) {
    event.preventDefault();
    setChecking(true);
    setError("");
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        setPassword("");
        window.location.reload();
      } else if (res.status === 429) {
        setError("too many tries. wait a few minutes.");
      } else if (res.status === 503) {
        setError("server is not configured yet.");
      } else {
        setError("wrong password.");
      }
    } catch {
      setError("network error. try again.");
    } finally {
      setChecking(false);
    }
  }

  return (
    <main className="gate">
      <h1>SAVAGE LAB</h1>
      <p>studio control · eyes only</p>
      <form onSubmit={unlock}>
        <input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="password"
          // biome-ignore lint/a11y/noAutofocus: the password box is the page's only element
          autoFocus
        />
        <button type="submit" disabled={checking || password.length === 0}>
          {checking ? "…" : "unlock"}
        </button>
      </form>
      {error && <p className="err">{error}</p>}
      {!configured && (
        <p className="err">heads up: environment variables are missing.</p>
      )}
    </main>
  );
}
