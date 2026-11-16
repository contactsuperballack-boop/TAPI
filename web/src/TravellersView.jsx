import { useState } from "react";
import { useLoad } from "./useLoad.js";
import { Banner, Field, Icon, Loading, Sheet, errText } from "./ui.jsx";
import { Empty } from "./TripsView.jsx";
import { ProfileForm, missingText } from "./Profile.jsx";

function AddSheet({ api, onClose, onDone }) {
  const [f, setF] = useState({ firstName: "", lastName: "", email: "", phone: "", dateOfBirth: "", nationality: "", passportNumber: "" });
  const [err, setErr] = useState(null); const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  async function submit(e) {
    e.preventDefault(); setBusy(true); setErr(null);
    const body = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.trim() || undefined]));
    try { await api.createTraveler(body); onDone(); } catch (ex) { setErr(errText(ex)); setBusy(false); }
  }
  return (
    <Sheet title="Add client" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        {err && <Banner>{err}</Banner>}
        <div className="grid2">
          <Field label="First name" id="a-f"><input id="a-f" className="input" value={f.firstName} onChange={set("firstName")} required autoFocus /></Field>
          <Field label="Last name" id="a-l"><input id="a-l" className="input" value={f.lastName} onChange={set("lastName")} required /></Field>
          <Field label="Email" id="a-e"><input id="a-e" className="input" type="email" value={f.email} onChange={set("email")} required /></Field>
          <Field label="Phone" id="a-p"><input id="a-p" className="input" type="tel" value={f.phone} onChange={set("phone")} /></Field>
          <Field label="Date of birth" id="a-d"><input id="a-d" className="input" type="date" value={f.dateOfBirth} onChange={set("dateOfBirth")} /></Field>
          <Field label="Nationality (2-letter)" id="a-n"><input id="a-n" className="input" maxLength={2} value={f.nationality} onChange={(e) => setF({ ...f, nationality: e.target.value.toUpperCase() })} /></Field>
        </div>
        <Field label="Passport number" id="a-pp"><input id="a-pp" className="input" autoComplete="off" value={f.passportNumber} onChange={set("passportNumber")} /></Field>
        <p className="sub" style={{ margin: 0 }}>Passport details are used only to make bookings. They are never shown again in full and never sent to the AI assistant.</p>
        <button className="btn primary block" disabled={busy}>{busy ? "Saving…" : "Save client"}</button>
      </form>
    </Sheet>
  );
}

export function TravellersView({ api, onAuthError }) {
  const { data, error, loading, reload } = useLoad(() => api.listTravelers(), [api], onAuthError);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  return (
    <div className="stack">
      <div className="row between"><div><h1>Clients</h1><div className="sub">People you book trips for.</div></div>
        <button className="btn primary" onClick={() => setOpen(true)}><Icon name="plus" size={18} />Add</button></div>
      {error && <Banner onClose={reload}>{errText(error)}</Banner>}
      {loading && !data ? <Loading n={2} /> : data && data.length === 0 ? (
        <Empty title="No clients yet" action={<button className="btn primary" onClick={() => setOpen(true)}>Add a client</button>}>A client is needed before anything can be booked.</Empty>
      ) : (
        <div className="grid2">{(data || []).map((t) => (
          <div className="card" key={t.id}>
            <h2>{t.firstName} {t.lastName}</h2>
            <dl className="kv" style={{ marginTop: 8 }}>
              <dt>Email</dt><dd>{t.email || "—"}</dd><dt>Phone</dt><dd>{t.phone || "—"}</dd>
              <dt>Passport</dt><dd className="num">{t.passportMasked || "Not on file"}</dd>
              <dt>Nationality</dt><dd>{t.nationality || "—"}</dd>
            </dl>
            {t.missingForFlights && t.missingForFlights.length > 0 && <div className="sub" style={{ marginTop: 8 }}>Needed for flights: {missingText(t.missingForFlights)}</div>}
            <button className="btn sm" style={{ marginTop: 10 }} onClick={() => setEditing(t)}>Edit details</button>
          </div>))}
        </div>
      )}
      {editing && <Sheet title={`${editing.firstName} ${editing.lastName}`} onClose={() => setEditing(null)}><ProfileForm person={editing} onSave={async (b) => { await api.updateTraveler(editing.id, b); reload(); }} /></Sheet>}
      {open && <AddSheet api={api} onClose={() => setOpen(false)} onDone={() => { setOpen(false); reload(); }} />}
    </div>
  );
}
