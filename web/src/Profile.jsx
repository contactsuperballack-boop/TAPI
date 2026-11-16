import { useState } from "react";
import { useLoad } from "./useLoad.js";
import { Banner, Chip, Field, Loading, errText } from "./ui.jsx";
import { useSession } from "./session.jsx";

const LABELS = { firstName: "first name", lastName: "last name", email: "email", dateOfBirth: "date of birth", passportNumber: "passport number", nationality: "nationality", profile: "profile" };
export const missingText = (m) => (m || []).map((k) => LABELS[k] || k).join(", ");

// Shared by travellers (their own details) and staff (a client's details). Empty fields are not sent, so
// saving never wipes anything; the passport is write-only here (only the masked value comes back).
export function ProfileForm({ person, onSave, saveLabel = "Save details" }) {
  const [f, setF] = useState({ firstName: person.firstName || "", lastName: person.lastName || "", phone: person.phone || "", dateOfBirth: person.dateOfBirth || "", nationality: person.nationality || "", passportNumber: "" });
  const [st, setSt] = useState({ busy: false, error: null, saved: false });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  async function submit(e) {
    e.preventDefault(); setSt({ busy: true, error: null, saved: false });
    const body = {};
    for (const [k, v] of Object.entries(f)) { const t = String(v).trim(); if (t) body[k] = t; else if (k === "phone" && person.phone) body.phone = ""; }
    try { await onSave(body); setF((x) => ({ ...x, passportNumber: "" })); setSt({ busy: false, error: null, saved: true }); } catch (ex) { setSt({ busy: false, error: errText(ex), saved: false }); }
  }
  return (
    <form className="stack" onSubmit={submit}>
      {st.error && <Banner>{st.error}</Banner>}
      {st.saved && <Banner tone="ok">Saved.</Banner>}
      <div className="grid2 tight">
        <Field label="First name" id="pf-f"><input id="pf-f" className="input" value={f.firstName} onChange={set("firstName")} required /></Field>
        <Field label="Last name" id="pf-l"><input id="pf-l" className="input" value={f.lastName} onChange={set("lastName")} required /></Field>
        <Field label="Date of birth" id="pf-d"><input id="pf-d" className="input" type="date" value={f.dateOfBirth} onChange={set("dateOfBirth")} /></Field>
        <Field label="Nationality (2 letters)" id="pf-n"><input id="pf-n" className="input" maxLength={2} value={f.nationality} onChange={(e) => setF({ ...f, nationality: e.target.value.toUpperCase() })} placeholder="NG" /></Field>
      </div>
      <Field label={person.passportMasked ? `Passport number (on file: ${person.passportMasked}). Enter a new one to replace it` : "Passport number"} id="pf-p">
        <input id="pf-p" className="input" autoComplete="off" value={f.passportNumber} onChange={set("passportNumber")} />
      </Field>
      <Field label="Phone" id="pf-ph"><input id="pf-ph" className="input" type="tel" value={f.phone} onChange={set("phone")} /></Field>
      <p className="sub" style={{ margin: 0 }}>Passport details are used only to make bookings. They are never shown again in full and never sent to the AI assistant.</p>
      <button className="btn primary" disabled={st.busy}>{st.busy ? "Saving…" : saveLabel}</button>
    </form>
  );
}

export function MyDetails({ onAuthError }) {
  const { api } = useSession();
  const { data, error, loading, reload } = useLoad(() => api.myProfile(), [api], onAuthError);
  if (loading && !data) return <Loading n={2} />;
  return (
    <div className="stack">
      <div><h1>My details</h1><div className="sub">What we send to airlines and hotels when you book.</div></div>
      {error && <Banner onClose={reload}>{errText(error)}</Banner>}
      {data && (
        <>
          <div className="card"><dl className="kv"><dt>Email</dt><dd>{data.email}</dd></dl></div>
          {data.missingForFlights.length > 0
            ? <Banner tone="warn">To book flights we still need your {missingText(data.missingForFlights)}.</Banner>
            : <Chip tone="ok">Ready to book flights</Chip>}
          <div className="card"><ProfileForm person={data} onSave={async (b) => { await api.updateMyProfile(b); await reload(); }} /></div>
        </>
      )}
    </div>
  );
}
