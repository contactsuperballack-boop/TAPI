import { useState } from "react";
import { useLoad } from "./useLoad.js";
import { Banner, Chip, Field, Icon, Loading, Sheet, errText } from "./ui.jsx";
import { dateRange, formatMoney, tripStatusMeta } from "./format.js";

function NewTripSheet({ api, onClose, onCreated }) {
  const [f, setF] = useState({ title: "", origin: "", destination: "", startDate: "", endDate: "", budget: "", currency: "USD" });
  const [err, setErr] = useState(null); const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  async function submit(e) {
    e.preventDefault(); setBusy(true); setErr(null);
    try {
      const body = { title: f.title.trim(), origin: f.origin.trim().toUpperCase() || undefined, destination: f.destination.trim() || undefined,
        startDate: f.startDate || undefined, endDate: f.endDate || undefined, budget: f.budget ? Number(f.budget) : undefined, currency: f.budget ? f.currency : undefined };
      onCreated(await api.createTrip(body));
    } catch (ex) { setErr(errText(ex)); setBusy(false); }
  }
  return (
    <Sheet title="New trip" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        {err && <Banner>{err}</Banner>}
        <Field label="Trip name" id="t-title"><input id="t-title" className="input" value={f.title} onChange={set("title")} placeholder="London conference" required autoFocus /></Field>
        <div className="grid2 tight">
          <Field label="From (airport code)" id="t-o"><input id="t-o" className="input" value={f.origin} onChange={set("origin")} placeholder="ABV" maxLength={3} /></Field>
          <Field label="To (city or airport)" id="t-d"><input id="t-d" className="input" value={f.destination} onChange={set("destination")} placeholder="London" /></Field>
          <Field label="Start" id="t-s"><input id="t-s" className="input" type="date" value={f.startDate} onChange={set("startDate")} /></Field>
          <Field label="End" id="t-e"><input id="t-e" className="input" type="date" min={f.startDate || undefined} value={f.endDate} onChange={set("endDate")} /></Field>
          <Field label="Budget (optional)" id="t-b"><input id="t-b" className="input num" type="number" min="0" step="1" value={f.budget} onChange={set("budget")} /></Field>
          <Field label="Currency" id="t-c"><select id="t-c" className="select" value={f.currency} onChange={set("currency")}>{["USD", "EUR", "GBP", "NGN"].map((c) => <option key={c}>{c}</option>)}</select></Field>
        </div>
        <button className="btn primary block" disabled={busy || !f.title.trim()}>{busy ? "Creating…" : "Create trip"}</button>
      </form>
    </Sheet>
  );
}

export function Empty({ title, children, action }) {
  return <div className="empty"><h2>{title}</h2><p style={{ margin: "0 0 14px" }}>{children}</p>{action}</div>;
}

export function TripsView({ api, go, onAuthError }) {
  const { data: trips, error, loading, reload } = useLoad(() => api.listTrips(), [api], onAuthError);
  const [open, setOpen] = useState(false);
  return (
    <div className="stack">
      <div className="row between">
        <div><h1>Your trips</h1><div className="sub">Plan, approve and track bookings in one place.</div></div>
        <button className="btn primary" onClick={() => setOpen(true)}><Icon name="plus" size={18} />New trip</button>
      </div>
      {error && <Banner onClose={reload}>{errText(error)}</Banner>}
      {loading && !trips ? <Loading /> : trips && trips.length === 0 ? (
        <Empty title="No trips yet" action={<button className="btn primary" onClick={() => setOpen(true)}>Plan your first trip</button>}>
          Start a trip, search flights and hotels, add what you like, and approve each booking yourself.
        </Empty>
      ) : (
        <div className="stack">
          {(trips || []).map((t) => {
            const st = tripStatusMeta(t.status);
            return (
              <button key={t.id} className="card click" onClick={() => go(`#/trips/${t.id}`)}>
                <div className="row between" style={{ alignItems: "start" }}>
                  <div><h2>{t.title}</h2><div className="sub">{[t.origin, t.destination].filter(Boolean).join(" → ") || "Route not set"} · {dateRange(t.start_date, t.end_date)}</div></div>
                  <Chip tone={st.tone}>{st.text}</Chip>
                </div>
                <div className="row wrap" style={{ marginTop: 10 }}>
                  <span className="sub">{t.item_count} item{t.item_count === 1 ? "" : "s"}{t.confirmed_count ? ` · ${t.confirmed_count} confirmed` : ""}</span>
                  {t.budget != null && <span className="sub num">· Budget {formatMoney(t.budget, t.currency)}</span>}
                </div>
              </button>
            );
          })}
        </div>
      )}
      {open && <NewTripSheet api={api} onClose={() => setOpen(false)} onCreated={(t) => go(`#/trips/${t.id}`)} />}
    </div>
  );
}
