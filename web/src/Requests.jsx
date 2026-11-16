import { useEffect, useState } from "react";
import { useLoad } from "./useLoad.js";
import { Banner, Chip, Field, Icon, Loading, Sheet, errText } from "./ui.jsx";
import { Empty } from "./TripsView.jsx";
import { useSession } from "./session.jsx";
import { approvalLeft, describeItem, formatMoney, timeAgo } from "./format.js";

function CompleteSheet({ r, onClose, onDone, api }) {
  const [f, setF] = useState({ confirmationRef: "", finalPrice: String(r.approvedPrice), note: "" });
  const [st, setSt] = useState({ busy: false, error: null });
  const price = Number(f.finalPrice); const over = price > r.approvedPrice;
  async function submit(e) {
    e.preventDefault(); setSt({ busy: true, error: null });
    try { await api.completeRequest(r.id, { confirmationRef: f.confirmationRef, finalPrice: price, currency: r.currency, note: f.note }); onDone("Marked as booked. The traveller has been emailed."); }
    catch (ex) { setSt({ busy: false, error: errText(ex) }); }
  }
  return (
    <Sheet title="Record the booking" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        {st.error && <Banner>{st.error}</Banner>}
        <p className="sub" style={{ margin: 0 }}>The traveller approved <strong>{formatMoney(r.approvedPrice, r.currency)}</strong>. You can record this booking at that price or lower.</p>
        <Field label="Confirmation reference (PNR or booking number)" id="cp-r"><input id="cp-r" className="input" value={f.confirmationRef} onChange={(e) => setF({ ...f, confirmationRef: e.target.value })} required autoFocus maxLength={80} /></Field>
        <Field label={`Final price paid (${r.currency})`} id="cp-p"><input id="cp-p" className="input num" type="number" step="0.01" min="0.01" value={f.finalPrice} onChange={(e) => setF({ ...f, finalPrice: e.target.value })} required /></Field>
        {over && <Banner tone="warn">That is higher than the traveller approved. Close this and use "Price changed" so they can approve the new price. Nothing can be recorded above their approval.</Banner>}
        <Field label="Note for the traveller (optional)" id="cp-n"><textarea id="cp-n" className="textarea" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} maxLength={1000} placeholder="Seat, baggage, check-in tips" /></Field>
        <button className="btn primary block" disabled={st.busy || over || !f.confirmationRef.trim() || !(price > 0)}>{st.busy ? "Saving…" : "Mark as booked"}</button>
      </form>
    </Sheet>
  );
}

function ReasonSheet({ title, intro, label, placeholder, button, extra, r, onClose, onDone, run }) {
  const [reason, setReason] = useState(""); const [price, setPrice] = useState(String(r.approvedPrice));
  const [st, setSt] = useState({ busy: false, error: null });
  async function submit(e) { e.preventDefault(); setSt({ busy: true, error: null }); try { await run(reason, Number(price)); onDone(); } catch (ex) { setSt({ busy: false, error: errText(ex) }); } }
  return (
    <Sheet title={title} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        {st.error && <Banner>{st.error}</Banner>}
        <p className="sub" style={{ margin: 0 }}>{intro}</p>
        {extra === "price" && <Field label={`New price (${r.currency})`} id="rs-p"><input id="rs-p" className="input num" type="number" step="0.01" min="0.01" value={price} onChange={(e) => setPrice(e.target.value)} required /></Field>}
        <Field label={label} id="rs-r"><textarea id="rs-r" className="textarea" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={placeholder} required minLength={3} maxLength={500} autoFocus /></Field>
        <button className="btn primary block" disabled={st.busy || reason.trim().length < 3 || (extra === "price" && !(Number(price) > 0))}>{st.busy ? "Sending…" : button}</button>
      </form>
    </Sheet>
  );
}

function RequestCard({ r, scope, userId, api, onChanged, setNotice }) {
  const [sheet, setSheet] = useState(null); const [details, setDetails] = useState(null); const [busy, setBusy] = useState(false);
  const d = describeItem({ kind: r.itemKind, details: r.item }); const left = approvalLeft(r.approvalExpiresAt);
  const mine = r.status === "claimed" && (!r.claimedByUserId || r.claimedByUserId === userId || scope === "mine");
  async function act(fn, ok) { setBusy(true); try { await fn(); if (ok) setNotice({ tone: "ok", text: ok }); onChanged(); } catch (ex) { setNotice({ tone: ex.status === 409 ? "warn" : "bad", text: errText(ex) }); onChanged(); } finally { setBusy(false); } }
  async function reveal() { setBusy(true); try { setDetails(await api.revealTraveller(r.id)); } catch (ex) { setNotice({ tone: "bad", text: errText(ex) }); } finally { setBusy(false); } }
  const done = (msg) => { setSheet(null); setDetails(null); setNotice({ tone: "ok", text: msg }); onChanged(); };
  return (
    <article className="card item" aria-label={`${r.travellerName || "Traveller"} ${d.title}`}>
      <div className="top">
        <div className="row" style={{ alignItems: "start" }}><span className="ico"><Icon name={r.itemKind === "flight" ? "plane" : "bed"} /></span>
          <div><strong>{d.title}</strong><div className="lines">{d.lines.map((l, i) => <span key={i}>{l}</span>)}</div>
            <div className="sub" style={{ marginTop: 4 }}>{r.travellerName || "Traveller"} · {r.tripTitle} · requested {timeAgo(r.createdAt)}</div></div></div>
        <div style={{ textAlign: "right" }}><div className="price num">{formatMoney(r.approvedPrice, r.currency)}</div><div className="sub">approved ceiling</div></div>
      </div>
      <div className="row wrap">
        {r.status === "open" && <Chip tone="info">Open</Chip>}
        {r.status === "claimed" && <Chip tone="info">Claimed{r.claimedBy ? ` by ${r.claimedBy}` : ""}</Chip>}
        {r.status === "completed" && <Chip tone="ok">Booked</Chip>}
        {r.status === "declined" && <Chip tone="bad">Declined</Chip>}
        {r.status === "cancelled" && <Chip tone="muted">{/^Withdrawn/.test(r.agentNote || "") ? "Withdrawn" : "Sent back for a new price"}</Chip>}
        {left && ["open", "claimed"].includes(r.status) && <Chip tone={left.expired ? "bad" : "muted"}><Icon name="clock" size={13} />{left.text}</Chip>}
      </div>
      {r.travellerNote && <div className="card" style={{ background: "var(--surface-2)", boxShadow: "none", padding: 12 }}><div className="sub">Note from the traveller</div>{r.travellerNote}</div>}
      {r.status === "completed" && <div className="sub num">Confirmation <strong>{r.confirmationRef}</strong> · final {formatMoney(r.finalPrice, r.currency)}</div>}
      {r.declineReason && <div className="sub">Reason: {r.declineReason}</div>}
      {details && (
        <div className="reveal" role="region" aria-label="Traveller details">
          <strong>Traveller details</strong> <span className="sub">This view is logged.</span>
          <dl className="kv"><dt>Name</dt><dd>{details.firstName} {details.lastName}</dd><dt>Date of birth</dt><dd className="num">{details.dateOfBirth || "—"}</dd>
            <dt>Passport</dt><dd className="num">{details.passportNumber || "—"}</dd><dt>Nationality</dt><dd>{details.nationality || "—"}</dd><dt>Email</dt><dd>{details.email || "—"}</dd><dt>Phone</dt><dd>{details.phone || "—"}</dd></dl>
          <button className="btn sm" style={{ marginTop: 8 }} onClick={() => setDetails(null)}>Hide</button>
        </div>
      )}
      <div className="row wrap">
        {r.status === "open" && <button className="btn primary" disabled={busy} onClick={() => act(() => api.claimRequest(r.id), "Claimed. It is now under Mine.")}>Claim</button>}
        {mine && <>
          <button className="btn" disabled={busy} onClick={reveal}>Show traveller details</button>
          <button className="btn primary" disabled={busy} onClick={() => setSheet("complete")}>Record booking</button>
          <button className="btn" disabled={busy} onClick={() => setSheet("reprice")}>Price changed</button>
          <button className="btn danger" disabled={busy} onClick={() => setSheet("decline")}>Cannot book</button>
          <button className="btn ghost" disabled={busy} onClick={() => act(() => api.releaseRequest(r.id), "Handed back to the queue.")}>Hand back</button>
        </>}
      </div>
      {sheet === "complete" && <CompleteSheet r={r} api={api} onClose={() => setSheet(null)} onDone={done} />}
      {sheet === "reprice" && <ReasonSheet r={r} title="Price changed" intro="The traveller will be asked to approve the new price. Nothing is booked until they do." extra="price" label="Why did the price change?" placeholder="Fare class sold out; next fare is higher" button="Send back for approval" onClose={() => setSheet(null)} onDone={() => done("Sent back to the traveller for approval.")} run={(reason, price) => api.repriceRequest(r.id, { newPrice: price, note: reason })} />}
      {sheet === "decline" && <ReasonSheet r={r} title="Cannot book this" intro="The traveller is told nothing was booked and can choose another option." label="What should the traveller know?" placeholder="Sold out on those dates" button="Tell the traveller" onClose={() => setSheet(null)} onDone={() => done("The traveller has been told.")} run={(reason) => api.declineRequest(r.id, reason)} />}
    </article>
  );
}

export function RequestsView({ onAuthError }) {
  const { api, principal } = useSession();
  const [scope, setScope] = useState("open"); const [notice, setNotice] = useState(null);
  const { data, error, loading, reload } = useLoad(() => api.listRequests(scope), [api, scope], onAuthError);
  // New requests arrive while someone is looking: refresh quietly every 20 seconds.
  useEffect(() => { const t = setInterval(() => reload(), 20000); return () => clearInterval(t); }, [reload]);
  const tabs = [["open", "Open"], ["mine", "Mine"], ["done", "Done"]];
  return (
    <div className="stack">
      <div><h1>Requests</h1><div className="sub">Bookings travellers asked an agent to complete.</div></div>
      <div className="tabs" role="tablist" aria-label="Request lists">{tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={scope === k} onClick={() => { setScope(k); setNotice(null); }}>{l}</button>)}</div>
      <div aria-live="polite">{notice && <Banner tone={notice.tone} onClose={() => setNotice(null)}>{notice.text}</Banner>}</div>
      {error && <Banner onClose={reload}>{errText(error)}</Banner>}
      {loading && !data ? <Loading n={2} /> : data && data.length === 0
        ? <Empty title={scope === "open" ? "Nothing waiting" : scope === "mine" ? "Nothing claimed" : "Nothing finished yet"}>{scope === "open" ? "New requests appear here when a traveller asks an agent to book." : scope === "mine" ? "Claim a request from Open to start working on it." : "Completed, declined and withdrawn requests appear here."}</Empty>
        : <div className="stack">{(data || []).map((r) => <RequestCard key={r.id} r={r} scope={scope} userId={principal.userId} api={api} onChanged={reload} setNotice={setNotice} />)}</div>}
    </div>
  );
}
