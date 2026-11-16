import { useEffect, useRef, useState } from "react";
import { useLoad } from "./useLoad.js";
import { Banner, Chip, Icon, Loading, errText } from "./ui.jsx";

const TOOL_NAMES = { search_flights: "Searched flights", search_hotels: "Searched hotels", propose_item: "Proposed an item", get_traveller_profile: "Read preferences" };

export function ChatPanel({ api, trip, onChanged }) {
  const { data, loading, reload } = useLoad(() => api.messages(trip.id), [api, trip.id]);
  const [text, setText] = useState(""); const [busy, setBusy] = useState(false); const [err, setErr] = useState(null);
  const [pending, setPending] = useState(null); const [tools, setTools] = useState([]);
  const end = useRef(null);
  useEffect(() => { end.current && end.current.scrollIntoView({ block: "end" }); }, [data, pending, busy]);

  async function send(e) {
    e.preventDefault(); const msg = text.trim(); if (!msg || busy) return;
    setBusy(true); setErr(null); setPending(msg); setText("");
    try { const r = await api.sendMessage(trip.id, msg); setTools(r.tools || []); await reload(); onChanged(); }
    catch (ex) { setErr(ex.code === "AGENT_MODEL_NOT_CONFIGURED" ? null : errText(ex)); setText(msg); }
    finally { setPending(null); setBusy(false); }
  }
  if (loading && !data) return <Loading n={2} />;
  const available = data ? data.agentAvailable : false;
  const msgs = (data && data.messages || []).filter((m) => m.role !== "tool");
  return (
    <div className="stack">
      {!available && <Banner tone="info">The AI assistant is not switched on for this deployment yet. You can still search under <strong>Find</strong>, add offers, and approve and book them yourself.</Banner>}
      <div className="chat" role="log" aria-live="polite" aria-label="Conversation">
        {msgs.length === 0 && !pending && <div className="empty"><h2>Ask for help planning</h2>Try: “Find me a direct flight and a 4-star hotel near the conference.” The assistant can search and propose. It cannot book or pay.</div>}
        {msgs.map((m) => <div key={m.id} className={`bubble ${m.role}`}>{m.content}</div>)}
        {pending && <div className="bubble user">{pending}</div>}
        {busy && <div className="bubble assistant" aria-busy="true">Working on it…</div>}
        {tools.length > 0 && !busy && <div className="row wrap">{tools.map((t, i) => <Chip key={i} tone={t.status === "ok" ? "info" : "bad"}>{TOOL_NAMES[t.tool] || t.tool}{t.status === "ok" ? "" : " (failed)"}</Chip>)}</div>}
        <div ref={end} />
      </div>
      {err && <Banner onClose={() => setErr(null)}>{err}</Banner>}
      <form className="row" onSubmit={send} style={{ alignItems: "end" }}>
        <textarea className="textarea" style={{ minHeight: 48, height: 48 }} aria-label="Message" value={text} onChange={(e) => setText(e.target.value)} disabled={!available || busy} placeholder={available ? "Describe what you need…" : "Assistant unavailable"} maxLength={4000}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(e); } }} />
        <button className="btn primary" disabled={!available || busy || !text.trim()} aria-label="Send"><Icon name="send" size={18} /></button>
      </form>
    </div>
  );
}
