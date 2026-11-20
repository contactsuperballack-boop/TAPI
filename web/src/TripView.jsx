import { useEffect, useState } from "react";
import { useLoad } from "./useLoad.js";
import { useSession, isTraveller, needsConsent } from "./session.jsx";
import { Banner, Chip, Field, Icon, Loading, Sheet, errText } from "./ui.jsx";
import { Empty } from "./TripsView.jsx";
import { SearchPanel } from "./SearchPanel.jsx";
import { ChatPanel } from "./ChatPanel.jsx";
import { budgetState, dateRange, describeItem, formatDate, formatMoney, itemStatusMeta, minutesLeft, priceLabelMeta, totalsByCurrency, tripStatusMeta } from "./format.js";

// What a blocked booking means, in plain words. Nothing was booked or charged in any of these.
export function blockedMessage(b) {
  const code = b && b.code;
  const live = b && b.livePrice != null ? formatMoney(b.livePrice, b.currency) : null;
  switch (code) {
    case "PRICE_INCREASED": return `The price went up${live ? ` to ${live}` : ""}. Nothing was booked. Review the new price and approve again if you still want it.`;
    case "PRICE_CHANGED": return "The supplier changed the price. Nothing was booked. Search again to see the current price.";
    case "OFFER_EXPIRED": case "OFFER_NO_LONGER_VALID": return "This offer has expired. Nothing was booked. Search again for current options.";
    case "SOLD_OUT": return "This is no longer available. Nothing was booked.";
    case "APPROVAL_EXPIRED": return "Your approval timed out. Nothing was booked. Approve again to continue.";
    case "APPROVAL_ALREADY_USED_OR_EXPIRED": case "APPROVAL_CONSUMED": return "This approval was already used or has expired. Check the booking status before trying again.";
    case "PROFILE_INCOMPLETE": return `${(b && b.detail) || "Traveller details are missing."} Nothing was booked.`;
    case "EMAIL_NOT_VERIFIED": return "Confirm your email address first. Use the link we sent you. Nothing was booked.";
    case "SELF_BOOKING_DISABLED": return "This agency completes bookings for its clients. Choose \"Have an agent book it\".";
    case "BOOKING_UNCONFIRMED": return (b && b.detail) || "We could not confirm this booking yet. Please do not approve it again.";
    case "BOOKING_FAILED": return (b && b.detail) || "The supplier did not accept this booking. Nothing was booked.";
    case "SUPPLIER_UNAVAILABLE": return "We could not reach the supplier just now. Nothing was booked and your approval is still valid. Try again in a moment.";
    case "NOT_UNDER_REVIEW": return "This booking is no longer under review.";
    case "HANDLED_BY_AGENT": return "This booking was sent to an agent, so it cannot be booked automatically.";
    case "ALREADY_STARTED": return "An agent has already started on this, so it cannot be withdrawn. Wait for their update.";
    default: return (b && (b.detail || b.title)) || "The booking could not be started. Nothing was charged.";
  }
}

function ApproveSheet({ item, onClose, onConfirm, busy, consentNeeded, forceAgent }) {
  const d = describeItem(item); const pl = priceLabelMeta(item.price_label);
  const [consent, setConsent] = useState(false);
  const [mode, setMode] = useState(forceAgent ? "agent_assisted" : "automated");
  const [note, setNote] = useState("");
  const agent = mode === "agent_assisted";
  return (
    <Sheet title="Approve this booking" onClose={onClose}>
      <div className="stack">
        <div><strong>{d.title}</strong><div className="lines">{d.lines.map((l, i) => <span key={i}>{l}</span>)}</div></div>
        <div className="card" style={{ background: "var(--surface-2)", boxShadow: "none" }}>
          <div className="sub">You are approving</div>
          <div className="price num" style={{ fontSize: 30 }}>{formatMoney(item.quoted_price, item.currency)}</div>
          <Chip tone={pl.tone} title={pl.hint}>{pl.text}</Chip>
        </div>
        {forceAgent ? <Banner tone="info">This agency books for its clients, so an agent will complete this booking for you.</Banner> : (
          <fieldset className="choice" aria-label="How should this be booked?">
            <label className={`opt${!agent ? " on" : ""}`}><input type="radio" name="mode" checked={!agent} onChange={() => setMode("automated")} /><span><strong>Book it automatically</strong><span className="sub">TAPI sends it to the supplier. You then press Book now.</span></span></label>
            <label className={`opt${agent ? " on" : ""}`}><input type="radio" name="mode" checked={agent} onChange={() => setMode("agent_assisted")} /><span><strong>Have an agent book it</strong><span className="sub">A human agent completes it and sends you the confirmation.</span></span></label>
          </fieldset>
        )}
        {agent && <Field label="Anything the agent should know? (optional)" id="ap-note"><textarea id="ap-note" className="textarea" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Seat preference, baggage, special requests" /></Field>}
        <ul className="sub" style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 4 }}>
          {agent ? (<>
            <li>The agent can book it only at this price or lower. If the price is higher, they send it back to you to approve again.</li>
            <li>Your approval stays valid long enough for an agent to act, then expires.</li>
            <li>Payment is arranged with your agent. This app does not collect it yet.</li>
          </>) : (<>
            <li>The price is rechecked with the supplier when you book. If it has gone up, nothing is booked.</li>
            <li>This approval is for this one offer and expires in 30 minutes.</li>
            <li>Approving does not book or pay anything by itself. Booking is a separate step.</li>
          </>)}
        </ul>
        {consentNeeded && <label className="check"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />My client has agreed to this price and booking. This is recorded with the approval.</label>}
        <button className="btn primary block sticky-cta" onClick={() => onConfirm({ consent, fulfilment: agent ? "agent_assisted" : undefined, travellerNote: agent ? note.trim() : "" })} disabled={busy || (consentNeeded && !consent)}>
          {busy ? "Approving…" : agent ? `Approve and send to an agent: ${formatMoney(item.quoted_price, item.currency)}` : `Approve ${formatMoney(item.quoted_price, item.currency)}`}
        </button>
      </div>
    </Sheet>
  );
}

function ResolveSheet({ item, onClose, onDone, api, tripId }) {
  const [outcome, setOutcome] = useState("confirmed"); const [ref, setRef] = useState(""); const [note, setNote] = useState("");
  const [st, setSt] = useState({ busy: false, error: null });
  async function submit(e) {
    e.preventDefault(); setSt({ busy: true, error: null });
    try { await api.resolveItem(tripId, item.id, { outcome, reference: outcome === "confirmed" ? ref : undefined, note: note || undefined }); onDone(outcome); }
    catch (ex) { setSt({ busy: false, error: errText(ex) }); }
  }
  return (
    <Sheet title="Resolve this booking" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        {st.error && <Banner>{st.error}</Banner>}
        <p className="sub" style={{ margin: 0 }}>We could not confirm this booking automatically. Check with the supplier, then record what you found. This does not book anything.</p>
        <fieldset className="choice" aria-label="Outcome">
          <label className={`opt${outcome === "confirmed" ? " on" : ""}`}><input type="radio" name="oc" checked={outcome === "confirmed"} onChange={() => setOutcome("confirmed")} /><span><strong>It was booked at the supplier</strong><span className="sub">Needs the supplier's confirmation reference.</span></span></label>
          <label className={`opt${outcome === "not_booked" ? " on" : ""}`}><input type="radio" name="oc" checked={outcome === "not_booked"} onChange={() => setOutcome("not_booked")} /><span><strong>It was not booked</strong><span className="sub">The traveller is told and can approve again.</span></span></label>
        </fieldset>
        {outcome === "confirmed" && <Field label="Supplier confirmation reference" id="rv-r"><input id="rv-r" className="input" value={ref} onChange={(e) => setRef(e.target.value)} maxLength={80} required /></Field>}
        <Field label="Note (optional)" id="rv-n"><textarea id="rv-n" className="textarea" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} /></Field>
        <button className="btn primary block" disabled={st.busy || (outcome === "confirmed" && !ref.trim())}>{st.busy ? "Saving…" : "Save outcome"}</button>
      </form>
    </Sheet>
  );
}

function ItemCard({ item, canBook, onApprove, onBook, onRefresh, onWithdraw, onRetry, onResolve, isStaff, busy, canApprove, approveHint }) {
  const d = describeItem(item); const st = itemStatusMeta(item.status); const pl = priceLabelMeta(item.price_label);
  const left = minutesLeft(item.approval_expires_at);
  const approvedLive = item.status === "approved" && item.approval_id;
  return (
    <article className="card item" aria-label={d.title}>
      <div className="top">
        <div className="row" style={{ alignItems: "start" }}><span className="ico"><Icon name={item.kind === "flight" ? "plane" : "bed"} /></span>
          <div><strong>{d.title}</strong><div className="lines">{d.lines.map((l, i) => <span key={i}>{l}</span>)}</div></div></div>
        <div style={{ textAlign: "right" }}><div className="price num">{formatMoney(item.quoted_price, item.currency)}</div></div>
      </div>
      <div className="row wrap"><Chip tone={st.tone}>{st.text}</Chip><Chip tone={pl.tone} title={pl.hint}>{pl.text}</Chip>
        {approvedLive && <Chip tone="info"><Icon name="clock" size={13} />{left} min left</Chip>}</div>
      {item.status === "selected" && <div className="sub">The price changed or needs a fresh decision. Review it and approve again.</div>}
      {item.status === "approved" && !item.approval_id && <div className="sub">The approval timed out. Approve again to continue.</div>}
      {item.booking_id && <div className="sub num">Booking reference: {item.booking_id}</div>}
      {item.confirmation_ref && <div className="sub num">Confirmation: <strong>{item.confirmation_ref}</strong></div>}
      {item.status === "reconciliation_required" && <div className="sub">We could not confirm this booking yet. Please do not approve it again: we are checking so you are not booked twice.</div>}
      {item.status === "agent_requested" && <div className="sub">Waiting for an agent to pick this up. You will get an email when it is done.</div>}
      {item.status === "agent_working" && <div className="sub">{item.request_agent_name ? `${item.request_agent_name} is` : "An agent is"} booking this now.</div>}
      {item.status === "failed" && item.request_decline_reason && <div className="sub">Your agent could not book this: {item.request_decline_reason}. Nothing was booked.</div>}
      {item.status === "selected" && item.request_status === "cancelled" && item.request_agent_note && !/^Withdrawn/.test(item.request_agent_note) && <div className="sub">Your agent says: {item.request_agent_note}</div>}
      <div className="row wrap">
        {["proposed", "selected"].includes(item.status) && <button className="btn primary" disabled={busy || !canApprove} onClick={() => onApprove(item)}><Icon name="check" size={18} />Review and approve</button>}
        {item.status === "approved" && !item.approval_id && <button className="btn primary" disabled={busy || !canApprove} onClick={() => onApprove(item)}>Approve again</button>}
        {!canApprove && ["proposed", "selected"].includes(item.status) && approveHint && <span className="sub">{approveHint}</span>}
        {approvedLive && <button className="btn primary" disabled={busy || !canBook} onClick={() => onBook(item)}>{busy ? "Booking…" : "Book now"}</button>}
        {approvedLive && !canBook && <span className="sub">Choose a traveller above to book.</span>}
        {item.status === "agent_requested" && <button className="btn" disabled={busy} onClick={() => onWithdraw(item)}>Withdraw request</button>}
        {item.status === "reconciliation_required" && item.retry_approval_id && <button className="btn primary" disabled={busy} onClick={() => onRetry(item)}>{busy ? "Checking…" : "Try confirming again"}</button>}
        {item.status === "reconciliation_required" && isStaff && <button className="btn" disabled={busy} onClick={() => onResolve(item)}>Resolve this booking</button>}
        {item.booking_id && ["booking", "action_required", "reconciliation_required", "confirmed"].includes(item.status) && <button className="btn" disabled={busy} onClick={() => onRefresh(item)}><Icon name="refresh" size={17} />Check status</button>}
      </div>
    </article>
  );
}

export function TripView({ api, tripId, go, onAuthError }) {
  const { principal } = useSession(); const trav = isTraveller(principal);
  const { data: trip, error, loading, reload } = useLoad(() => api.getTrip(tripId), [api, tripId], onAuthError);
  const { data: travellers } = useLoad(() => api.listTravelers(), [api], onAuthError);
  const [tab, setTab] = useState("plan");
  const [notice, setNotice] = useState(null);
  const [approving, setApproving] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [events, setEvents] = useState(null);
  const [resolving, setResolving] = useState(null);

  useEffect(() => { if (tab === "activity") api.events(tripId).then(setEvents).catch(() => setEvents([])); }, [tab, tripId, api, trip]);

  if (loading && !trip) return <Loading />;
  if (error && !trip) return <div className="stack"><button className="back" onClick={() => go("#/trips")}><Icon name="back" size={18} />Trips</button><Banner onClose={reload}>{error.status === 404 ? "That trip could not be found." : errText(error)}</Banner></div>;
  if (!trip) return null;

  const items = trip.items || []; const totals = totalsByCurrency(items); const b = budgetState(trip, totals); const st = tripStatusMeta(trip.status);
  const traveller = (travellers || []).find((t) => t.id === trip.traveler_id);
  const flash = (tone, text) => setNotice({ tone, text });
  const unverified = principal.type === "session" && !principal.emailVerified;
  const selfBookingOff = trav && principal.travellerSelfBooking === false;
  const canApprove = !unverified;
  const approveHint = unverified ? "Confirm your email to approve." : "";

  async function confirmApprove({ consent, fulfilment, travellerNote }) {
    setBusyId(approving.id);
    try { const r = await api.approve(trip.id, approving, { clientConsent: consent, fulfilment, travellerNote }); setApproving(null); flash("ok", r.fulfilment === "agent_assisted" ? "Sent to an agent. You will get an email when it is done." : "Approved. You can now book. This approval lasts 30 minutes."); await reload(); }
    catch (ex) { setApproving(null); flash("bad", ex.code === "PRICE_MISMATCH" ? "The price changed while you were reviewing. Review the new price and try again." : blockedMessage({ ...ex.body, code: ex.code })); await reload(); }
    finally { setBusyId(null); }
  }
  async function book(item, approvalId = item.approval_id) {
    setBusyId(item.id); setNotice(null);
    try { const r = await api.book(trip.id, item.id, approvalId); flash("ok", `Booking started (${r.status}). Check the status for updates.`); }
    catch (ex) { flash([400, 403, 409, 502, 503].includes(ex.status) ? "warn" : "bad", blockedMessage({ ...ex.body, code: ex.code, currency: item.currency })); }
    finally { setBusyId(null); await reload(); }
  }
  async function refresh(item) {
    setBusyId(item.id);
    try { const r = await api.refresh(trip.id, item.id); flash("info", `Status: ${itemStatusMeta(r.itemStatus).text}.`); } catch (ex) { flash("bad", errText(ex)); }
    finally { setBusyId(null); await reload(); }
  }
  async function withdraw(item) {
    setBusyId(item.id);
    try { await api.cancelRequest(trip.id, item.id); flash("info", "Request withdrawn. You can approve it again whenever you like."); } catch (ex) { flash("warn", blockedMessage({ ...ex.body, code: ex.code })); }
    finally { setBusyId(null); await reload(); }
  }
  async function pickTraveller(e) { try { await api.patchTrip(trip.id, { travelerId: e.target.value }); await reload(); } catch (ex) { flash("bad", errText(ex)); } }

  const EV = { item_proposed: "Added an offer to the trip", item_approved: "Approved an item", agent_requested: "Sent to an agent", agent_claimed: "An agent picked this up", agent_released: "An agent handed this back to the queue", agent_completed: "An agent completed the booking", agent_declined: "An agent could not book this", agent_repriced: "An agent asked for a new price approval", agent_request_withdrawn: "Request withdrawn", booking_started: "Booking started", booking_blocked: "Booking stopped before any charge", booking_unconfirmed: "Booking could not be confirmed and is under review", booking_failed: "The supplier did not accept the booking", booking_resolved: "A person closed out a booking that was under review", trip_updated: "Trip updated" };

  return (
    <div className="stack">
      <button className="back" onClick={() => go("#/trips")}><Icon name="back" size={18} />Trips</button>
      <div className="stack" style={{ gap: 8 }}>
        <div className="row between" style={{ alignItems: "start" }}><h1>{trip.title}</h1><Chip tone={st.tone}>{st.text}</Chip></div>
        <div className="sub">{[trip.origin, trip.destination].filter(Boolean).join(" → ") || "Route not set"} · {dateRange(trip.start_date, trip.end_date)}</div>
      </div>

      <div className="card stack" style={{ gap: 12 }}>
        <div className="grid2">
          {trav ? <div><div className="sub" style={{ fontWeight: 650 }}>Travelling</div><div>{principal.fullName}</div></div> : (
          <div className="field"><label htmlFor="tv">Traveller</label>
            <select id="tv" className="select" value={trip.traveler_id || ""} onChange={pickTraveller}>
              <option value="" disabled>{(travellers || []).length ? "Choose a client" : "No clients yet"}</option>
              {(travellers || []).map((t) => <option key={t.id} value={t.id}>{t.firstName} {t.lastName}</option>)}
            </select>
            {!trip.traveler_id && <span className="sub">Needed to book.{(travellers || []).length === 0 && <> <a href="#/clients">Add a client</a></>}</span>}
          </div>)}
          <div>
            <div className="sub" style={{ fontWeight: 650 }}>Estimated total</div>
            {Object.keys(totals).length === 0 ? <div className="sub">Nothing added yet</div> : Object.entries(totals).map(([c, v]) => <div key={c} className="price num">{formatMoney(v, c)}</div>)}
            {b && <div className="sub num">{b.over ? `Over budget by ${formatMoney(-b.left, trip.currency)}` : `${formatMoney(b.left, trip.currency)} left of ${formatMoney(b.budget, trip.currency)}`}{b.mixedCurrency ? " (other currencies not included)" : ""}</div>}
          </div>
        </div>
        {b && <div className={`meter${b.over ? " over" : ""}`} role="img" aria-label="Budget used"><i style={{ width: `${Math.min(100, (b.spent / b.budget) * 100)}%` }} /></div>}
      </div>

      <div aria-live="polite">{notice && <Banner tone={notice.tone} onClose={() => setNotice(null)}>{notice.text}</Banner>}</div>

      <div className="tabs" role="tablist" aria-label="Trip sections">
        {[["plan", "Plan"], ["find", "Find"], ["assistant", "Assistant"], ["activity", "Activity"]].map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{l}</button>)}
      </div>

      {tab === "plan" && (items.length === 0
        ? <Empty title="Nothing in this trip yet" action={<button className="btn primary" onClick={() => setTab("find")}>Find flights and hotels</button>}>Search, add what you like, then approve each booking yourself.</Empty>
        : <div className="stack">{items.map((i) => <ItemCard key={i.id} item={i} busy={busyId === i.id} canBook={!!trip.traveler_id} canApprove={canApprove} approveHint={approveHint} onApprove={setApproving} onBook={book} onRefresh={refresh} onWithdraw={withdraw} onRetry={(it) => book(it, it.retry_approval_id)} onResolve={setResolving} isStaff={!trav} />)}</div>)}
      {tab === "find" && <SearchPanel api={api} trip={trip} items={items} onAdded={reload} />}
      {tab === "assistant" && <ChatPanel api={api} trip={trip} onChanged={reload} />}
      {tab === "activity" && (events === null ? <Loading n={2} /> : events.length === 0 ? <Empty title="No activity yet">Approvals, bookings and changes will appear here.</Empty>
        : <div className="timeline">{events.map((e) => <div key={e.id}><strong>{EV[e.type] || e.type}</strong><div className="sub">{formatDate(e.created_at, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}{e.payload && e.payload.reason ? ` · ${e.payload.reason}` : ""}</div></div>)}</div>)}

      {resolving && <ResolveSheet item={resolving} api={api} tripId={trip.id} onClose={() => setResolving(null)} onDone={(o) => { setResolving(null); flash("ok", o === "confirmed" ? "Marked as booked. The traveller has been emailed." : "Marked as not booked. The traveller can approve it again."); reload(); }} />}
      {approving && <ApproveSheet item={approving} busy={busyId === approving.id} consentNeeded={needsConsent(principal)} forceAgent={selfBookingOff} onClose={() => setApproving(null)} onConfirm={confirmApprove} />}
    </div>
  );
}
