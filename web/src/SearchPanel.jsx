import { useEffect, useRef, useState } from "react";
import { Banner, Chip, Field, Icon, errText } from "./ui.jsx";
import { describeOffer, formatMoney } from "./format.js";

const iata = (v) => (/^[A-Za-z]{3}$/.test(v || "") ? v.toUpperCase() : "");

export function SearchPanel({ api, trip, items, onAdded }) {
  const [kind, setKind] = useState("flight");
  const [f, setF] = useState({ origin: iata(trip.origin), destination: iata(trip.destination), departDate: (trip.start_date || "").slice(0, 10), returnDate: (trip.end_date || "").slice(0, 10), adults: 1,
    hotelDest: trip.destination || "", checkIn: (trip.start_date || "").slice(0, 10), checkOut: (trip.end_date || "").slice(0, 10), rooms: 1 });
  const [state, setState] = useState({ phase: "idle", offers: [], error: null, tick: 0 });
  const [added, setAdded] = useState({});
  const [addErr, setAddErr] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const resultsRef = useRef(null);
  useEffect(() => { if (state.phase === "done" && resultsRef.current) resultsRef.current.scrollIntoView({ behavior: "smooth", block: "start" }); }, [state.phase]);
  const have = new Set((items || []).map((i) => i.offer_id));

  async function run(e) {
    e.preventDefault(); setState({ phase: "searching", offers: [], error: null, tick: 0 }); setAddErr(null);
    const tick = (n) => setState((s) => ({ ...s, tick: n }));
    try {
      const r = kind === "flight" ? await api.searchFlights(f, tick) : await api.searchHotels({ destination: f.hotelDest, checkIn: f.checkIn, checkOut: f.checkOut, adults: f.adults, rooms: f.rooms }, tick);
      setState({ phase: "done", offers: r.offers || [], error: null, tick: 0 });
    } catch (ex) { setState({ phase: "error", offers: [], error: ex, tick: 0 }); }
  }
  async function add(o) {
    setAddErr(null);
    try { await api.addItem(trip.id, kind, o.offerId); setAdded((a) => ({ ...a, [o.offerId]: true })); onAdded(); }
    catch (ex) { setAddErr(errText(ex)); }
  }
  const valid = kind === "flight" ? iata(f.origin) && iata(f.destination) && f.departDate && (!f.returnDate || f.returnDate >= f.departDate) : f.hotelDest.trim() && f.checkIn && f.checkOut && f.checkOut > f.checkIn;

  return (
    <div className="stack">
      <div className="tabs" role="tablist" aria-label="Search type">
        {[["flight", "Flights"], ["hotel", "Hotels"]].map(([k, l]) => <button key={k} role="tab" aria-selected={kind === k} onClick={() => { setKind(k); setState({ phase: "idle", offers: [], error: null, tick: 0 }); }}>{l}</button>)}
      </div>
      <form className="card stack" onSubmit={run}>
        {kind === "flight" ? (
          <div className="grid2 tight">
            <Field label="From (airport code)" id="s-o"><input id="s-o" className="input" maxLength={3} value={f.origin} onChange={(e) => setF({ ...f, origin: e.target.value.toUpperCase() })} placeholder="ABV" required /></Field>
            <Field label="To (airport code)" id="s-d"><input id="s-d" className="input" maxLength={3} value={f.destination} onChange={(e) => setF({ ...f, destination: e.target.value.toUpperCase() })} placeholder="LHR" required /></Field>
            <Field label="Depart" id="s-dd"><input id="s-dd" className="input" type="date" value={f.departDate} onChange={set("departDate")} required /></Field>
            <Field label="Return (optional)" id="s-rd"><input id="s-rd" className="input" type="date" min={f.departDate || undefined} value={f.returnDate} onChange={set("returnDate")} /></Field>
            <Field label="Adults" id="s-a"><input id="s-a" className="input num" type="number" min="1" max="9" value={f.adults} onChange={set("adults")} /></Field>
          </div>
        ) : (
          <div className="grid2 tight">
            <Field label="Destination" id="h-d"><input id="h-d" className="input" value={f.hotelDest} onChange={set("hotelDest")} placeholder="London" required /></Field>
            <Field label="Rooms" id="h-r"><input id="h-r" className="input num" type="number" min="1" max="5" value={f.rooms} onChange={set("rooms")} /></Field>
            <Field label="Check in" id="h-ci"><input id="h-ci" className="input" type="date" value={f.checkIn} onChange={set("checkIn")} required /></Field>
            <Field label="Check out" id="h-co"><input id="h-co" className="input" type="date" min={f.checkIn || undefined} value={f.checkOut} onChange={set("checkOut")} required /></Field>
            <Field label="Adults" id="h-a"><input id="h-a" className="input num" type="number" min="1" max="9" value={f.adults} onChange={set("adults")} /></Field>
          </div>
        )}
        <button className="btn primary" disabled={!valid || state.phase === "searching"}><Icon name="search" size={18} />{state.phase === "searching" ? "Searching…" : `Search ${kind === "flight" ? "flights" : "hotels"}`}</button>
      </form>

      <div aria-live="polite" ref={resultsRef} style={{ scrollMarginTop: 12 }}>
        {state.phase === "searching" && <Banner tone="info">Searching suppliers{state.tick > 1 ? ` (still working, ${state.tick})` : ""}…</Banner>}
        {state.error && <Banner>{errText(state.error)}</Banner>}
        {addErr && <Banner onClose={() => setAddErr(null)}>{addErr}</Banner>}
      </div>

      {state.phase === "done" && (state.offers.length === 0 ? <div className="empty"><h2>No results</h2>Try different dates or nearby airports.</div> : (
        <div className="stack">
          <div className="sub">{state.offers.length} result{state.offers.length === 1 ? "" : "s"}, cheapest first. Prices are estimates until you approve and they are rechecked.</div>
          {state.offers.map((o) => {
            const d = describeOffer(kind, o); const isIn = added[o.offerId] || have.has(o.offerId);
            return (
              <div className="card item" key={o.offerId}>
                <div className="top">
                  <div className="row" style={{ alignItems: "start" }}><span className="ico"><Icon name={kind === "flight" ? "plane" : "bed"} /></span>
                    <div><strong>{d.title}</strong><div className="lines">{d.lines.map((l, i) => <span key={i}>{l}</span>)}</div></div></div>
                  <div style={{ textAlign: "right" }}><div className="price num">{formatMoney(o.price, o.currency)}</div><Chip tone="warn">Estimate</Chip></div>
                </div>
                <button className="btn" disabled={isIn} onClick={() => add(o)}>{isIn ? "Added to trip" : "Add to trip"}</button>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
