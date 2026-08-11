import { useEffect, useState } from "react";
import { Room } from "./Room.tsx";
import { newRoomUrl } from "./keyFromUrl.ts";

// Two screens, so no router. Also keeps anything else from touching the URL --
// the encryption key lives in the fragment and routers like to rewrite that.
function currentRoomId(): string | null {
  const m = window.location.pathname.match(/^\/room\/([A-Za-z0-9_-]+)$/);
  return m ? m[1] : null;
}

export function App() {
  const [roomId, setRoomId] = useState<string | null>(currentRoomId());

  useEffect(() => {
    const onPop = () => setRoomId(currentRoomId());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  if (roomId) return <Room roomId={roomId} />;
  return <Home onCreated={setRoomId} />;
}

function Home({ onCreated }: { onCreated: (id: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function createRoom() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/rooms", { method: "POST" });
      if (!res.ok) throw new Error(`server said ${res.status}`);
      const { id } = (await res.json()) as { id: string };

      // key is generated here, in the browser, and only ever put in the
      // fragment. the server just told us an id and knows nothing else.
      window.history.pushState({}, "", newRoomUrl(id));
      onCreated(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not create room");
      setBusy(false);
    }
  }

  return (
    <main className="centered">
      <h1>Enclave</h1>
      <p className="muted">A collaborative editor the server cannot read.</p>
      <button onClick={createRoom} disabled={busy}>
        {busy ? "Creating…" : "New room"}
      </button>
      {error && <p className="error">{error}</p>}
    </main>
  );
}
