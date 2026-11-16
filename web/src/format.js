export function formatMoney(amount, currency) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return "—";
  try { return new Intl.NumberFormat("en", { style: "currency", currency: currency || "USD", maximumFractionDigits: n % 1 ? 2 : 0 }).format(n); }
  catch (_) { return `${n.toFixed(2)} ${currency || ""}`.trim(); }
}

export function formatDate(d, opts = { day: "numeric", month: "short" }) {
  if (!d) return "";
  const dt = new Date(String(d).length === 10 ? `${d}T00:00:00Z` : d);
  if (isNaN(dt)) return String(d);
  return new Intl.DateTimeFormat("en-GB", { ...opts, timeZone: "UTC" }).format(dt);
}

export function dateRange(a, b) {
  if (!a && !b) return "Dates not set";
  if (a && !b) return formatDate(a);
  return `${formatDate(a)} – ${formatDate(b, { day: "numeric", month: "short", year: "numeric" })}`;
}

// How sure are we about this price? (labels are set by the server from supplier state)
export const PRICE_LABELS = {
  confirmed: { text: "Confirmed price", tone: "ok", hint: "Rechecked with the supplier just now." },
  estimated: { text: "Estimated price", tone: "warn", hint: "Not final yet. It is rechecked before booking." },
  unverified: { text: "Unverified price", tone: "muted", hint: "Not checked with a supplier. Do not rely on it." },
};
export const priceLabelMeta = (l) => PRICE_LABELS[l] || PRICE_LABELS.unverified;

export const ITEM_STATUS = {
  proposed: { text: "Proposed", tone: "muted" },
  selected: { text: "Needs new approval", tone: "warn" },
  approved: { text: "Approved", tone: "info" },
  agent_requested: { text: "Waiting for an agent", tone: "info" },
  agent_working: { text: "Agent is booking", tone: "info" },
  booking: { text: "Booking in progress", tone: "info" },
  confirmed: { text: "Confirmed", tone: "ok" },
  action_required: { text: "Action needed", tone: "warn" },
  failed: { text: "Failed", tone: "bad" },
  reconciliation_required: { text: "Under review", tone: "warn" },
  cancelled: { text: "Cancelled", tone: "muted" },
};
export const itemStatusMeta = (s) => ITEM_STATUS[s] || { text: s || "Unknown", tone: "muted" };

export const TRIP_STATUS = {
  draft: { text: "Draft", tone: "muted" }, researching: { text: "Planning", tone: "info" },
  itinerary_ready: { text: "Ready to review", tone: "info" }, awaiting_approval: { text: "Awaiting approval", tone: "warn" },
  booking: { text: "Booking", tone: "info" }, booked: { text: "Booked", tone: "ok" },
  partially_booked: { text: "Partly booked", tone: "warn" }, needs_attention: { text: "Needs attention", tone: "bad" },
  cancelled: { text: "Cancelled", tone: "muted" }, completed: { text: "Completed", tone: "muted" },
};
export const tripStatusMeta = (s) => TRIP_STATUS[s] || { text: s || "Unknown", tone: "muted" };

// Total of items still in play, grouped by currency (never adds different currencies together).
export function totalsByCurrency(items) {
  const out = {};
  for (const i of items || []) {
    if (["cancelled", "failed"].includes(i.status)) continue;
    const p = Number(i.quoted_price);
    if (!Number.isFinite(p)) continue;
    out[i.currency] = (out[i.currency] || 0) + p;
  }
  return out;
}

export function budgetState(trip, totals) {
  const budget = Number(trip && trip.budget);
  if (!Number.isFinite(budget) || !trip.currency) return null;
  const spent = totals[trip.currency] || 0;
  const other = Object.keys(totals).filter((c) => c !== trip.currency);
  return { budget, spent, left: budget - spent, over: spent > budget, mixedCurrency: other.length > 0 };
}

// Supplier leg shape is unverified (raw.outbound passes through untouched), so read it defensively.
export function describeLeg(leg) {
  if (!leg) return null;
  if (typeof leg === "string") return { summary: leg };
  const l = Array.isArray(leg) ? { segments: leg } : leg;
  const segs = Array.isArray(l.segments) ? l.segments : null;
  const first = segs ? segs[0] : l, last = segs ? segs[segs.length - 1] : l;
  const pick = (o, keys) => { for (const k of keys) if (o && o[k]) return o[k]; return null; };
  const from = pick(first, ["origin", "from", "departure_airport", "departureAirport"]);
  const to = pick(last, ["destination", "to", "arrival_airport", "arrivalAirport"]);
  const dep = pick(first, ["departure", "departure_time", "departureTime", "depart_at"]);
  const arr = pick(last, ["arrival", "arrival_time", "arrivalTime", "arrive_at"]);
  const dur = pick(l, ["duration", "duration_minutes", "durationMinutes"]);
  const t = (v) => { const d = new Date(v); return isNaN(d) ? String(v) : new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }).format(d) + " UTC"; };
  const parts = [from && to ? `${from} → ${to}` : null, dep ? `dep ${t(dep)}` : null, arr ? `arr ${t(arr)}` : null, dur ? (typeof dur === "number" ? `${Math.floor(dur / 60)}h ${dur % 60}m` : String(dur)) : null].filter(Boolean);
  return parts.length ? { summary: parts.join(" · ") } : null;
}

export function describeItem(item) {
  const d = item.details || {};
  if (item.kind === "flight") {
    const out = describeLeg(d.outbound);
    return { title: d.airline ? `${d.airline} flight` : "Flight", lines: [out && out.summary, d.inbound ? (describeLeg(d.inbound) || {}).summary : null, d.stops != null ? (d.stops === 0 ? "Direct" : `${d.stops} stop${d.stops > 1 ? "s" : ""}`) : null, d.baggage ? `Baggage: ${typeof d.baggage === "string" ? d.baggage : "included"}` : null].filter(Boolean) };
  }
  if (item.kind === "hotel") {
    return { title: d.hotelName || "Hotel", lines: [d.checkIn && d.checkOut ? `${formatDate(d.checkIn)} – ${formatDate(d.checkOut)}` : null, d.roomType, d.cancellationPolicy ? `Cancellation: ${typeof d.cancellationPolicy === "string" ? d.cancellationPolicy : "see policy"}` : null].filter(Boolean) };
  }
  return { title: item.kind, lines: [] };
}

export function describeOffer(kind, o) {
  return describeItem({ kind, details: o });
}

export function minutesLeft(iso, now = new Date()) {
  if (!iso) return null;
  return Math.max(0, Math.round((new Date(iso) - now) / 60000));
}

// Whole hours left on an approval, for the agent queue ("31h left"); under an hour shows minutes.
export function approvalLeft(iso, now = new Date()) {
  if (!iso) return null;
  const mins = Math.round((new Date(iso) - now) / 60000);
  if (mins <= 0) return { text: "Approval expired", expired: true };
  return { text: mins >= 120 ? `${Math.floor(mins / 60)}h left` : mins >= 60 ? `1h ${mins % 60}m left` : `${mins} min left`, expired: false };
}
export function timeAgo(iso, now = new Date()) {
  const mins = Math.max(0, Math.round((now - new Date(iso)) / 60000));
  return mins < 1 ? "just now" : mins < 60 ? `${mins} min ago` : mins < 2880 ? `${Math.floor(mins / 60)}h ago` : `${Math.floor(mins / 1440)}d ago`;
}
