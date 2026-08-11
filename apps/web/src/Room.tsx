import Editor from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import { useEffect, useMemo, useRef, useState } from "react";
import { MonacoBinding } from "y-monaco";
import { readKeyFromUrl } from "./keyFromUrl.ts";
import { RoomSync } from "./sync.ts";

export function Room({ roomId }: { roomId: string }) {
  const roomKey = useMemo(() => readKeyFromUrl(), []);

  const [sync, setSync] = useState<RoomSync | null>(null);
  const [status, setStatus] = useState("connecting");
  const [peers, setPeers] = useState(0);
  const [tampered, setTampered] = useState(false);
  const [editorReady, setEditorReady] = useState(false);

  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);

  useEffect(() => {
    if (!roomKey) return;

    const session = new RoomSync({
      roomId,
      roomKey,
      onStatus: setStatus,
      onPresence: setPeers,
      onTamper: () => setTampered(true),
    });
    setSync(session);

    return () => {
      session.destroy();
      setSync(null);
    };
  }, [roomId, roomKey]);

  // socket and editor get ready independently, wait for whichever is last
  useEffect(() => {
    if (!sync || !editorReady) return;

    const ed = editorRef.current;
    const model = ed?.getModel();
    if (!ed || !model) return;

    // both sides need the same field name or they're editing different texts
    const binding = new MonacoBinding(sync.doc.getText("code"), model, new Set([ed]));
    return () => binding.destroy();
  }, [sync, editorReady]);

  if (!roomKey) {
    return (
      <main className="centered">
        <h1>No key</h1>
        <p className="muted">
          This link is missing the part after the <code>#</code>, which is the key.
          Nothing can open the room without it.
        </p>
        <p className="muted small">Ask whoever sent it for the full URL.</p>
      </main>
    );
  }

  return (
    <div className="room">
      <header className="bar">
        <span className="logo">Enclave</span>
        <code className="roomid">{roomId}</code>
        <span className={`dot dot-${status}`} title={status} />
        <span className="muted small">
          {peers} {peers === 1 ? "person" : "people"}
        </span>
        {tampered ? (
          <span className="badge badge-error">tamper detected</span>
        ) : (
          <span className="badge badge-ok">encrypted</span>
        )}
      </header>

      <Editor
        height="calc(100vh - 44px)"
        defaultLanguage="javascript"
        theme="vs-dark"
        // no value prop, the Yjs doc owns the text
        onMount={(ed) => {
          editorRef.current = ed;
          setEditorReady(true);
        }}
        options={{
          minimap: { enabled: false },
          fontSize: 14,
          scrollBeyondLastLine: false,
          automaticLayout: true,
        }}
      />
    </div>
  );
}
