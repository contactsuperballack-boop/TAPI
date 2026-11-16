// Best-effort emails to travellers about their bookings. A failure here must never undo a booking or fail a
// request, so errors are logged (without message bodies) and swallowed. Plain text, no secrets, one link.
const clean = (t, n = 80) => String(t || "").replace(/[\r\n]+/g, " ").trim().slice(0, n);
const money = (p, c) => `${c} ${Number(p).toFixed(2)}`;

function createNotifier({ getMailer, baseUrl = "http://localhost:3000", log = console.error } = {}) {
  const link = (tripId) => `${baseUrl}/app/#/trips/${tripId}`;
  async function send(to, subject, text) {
    const mailer = getMailer && getMailer();
    if (!mailer || !to) return false;
    try { await mailer.send({ to, subject: clean(subject, 120), text }); return true; }
    catch (err) { log(`[notify] send failed (${err.code || "error"}): ${err.message}`); return false; }
  }
  return {
    bookingConfirmed: ({ to, tripTitle, tripId, itemKind, ref, finalPrice, currency }) =>
      send(to, `Your ${itemKind} is booked: ${clean(tripTitle, 50)}`, `Good news. Your ${itemKind} for "${clean(tripTitle)}" is booked.\nConfirmation reference: ${clean(ref, 80)}\nFinal price: ${money(finalPrice, currency)}\n\nSee your trip: ${link(tripId)}`),
    bookingDeclined: ({ to, tripTitle, tripId, itemKind, reason }) =>
      send(to, `We could not book your ${itemKind}: ${clean(tripTitle, 50)}`, `Your agent could not complete the ${itemKind} for "${clean(tripTitle)}".\nReason: ${clean(reason, 500)}\nNothing was booked.\n\nYou can choose another option here: ${link(tripId)}`),
    repriced: ({ to, tripTitle, tripId, itemKind, newPrice, currency, note }) =>
      send(to, `Please review a new price: ${clean(tripTitle, 50)}`, `The price for your ${itemKind} on "${clean(tripTitle)}" changed to ${money(newPrice, currency)}.\nNote from your agent: ${clean(note, 500)}\nNothing was booked. Review and approve the new price if you still want it:\n${link(tripId)}`),
  };
}
module.exports = { createNotifier };
