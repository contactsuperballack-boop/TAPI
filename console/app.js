const keyInput = document.querySelector('#apiKey');
const errorBox = document.querySelector('#error');
const api = (path) => fetch(`/v1/mobility${path}`, { headers: { Authorization: `Bearer ${localStorage.getItem('tapi_api_key') || keyInput.value}` } }).then(async r => { const body = await r.json(); if (!r.ok) throw new Error(body.detail || body.message || `HTTP ${r.status}`); return body; });

function renderMetrics(summary) {
  const metrics = [
    ['Active trips', summary.trips.active], ['Total trips', summary.trips.total], ['Active holds', summary.holds.active],
    ['Confirmed bookings', summary.bookings.confirmed], ['Gross amount', summary.bookings.gross_amount], ['Pending settlements', summary.settlements.pending],
  ];
  document.querySelector('#metrics').innerHTML = metrics.map(([label, value]) => `<div class="card"><small>${label}</small><div class="metric">${value ?? 0}</div></div>`).join('');
}
async function refresh() {
  errorBox.textContent = '';
  const key = localStorage.getItem('tapi_api_key') || keyInput.value;
  if (!key) { errorBox.textContent = 'Enter an agency API key to load live operations data.'; return; }
  // Invalidate all server-derived views before reloading them.
  ['metrics','trips','bookings','integrations','settlements'].forEach(id => { document.querySelector(`#${id}`).innerHTML = ''; });
  try {
    const [summary, trips, bookings, integrations, settlements] = await Promise.all([
      api('/dashboard/summary'), api('/trips'), api('/bookings'), api('/integrations').catch(() => ({ integrations: [] })), api('/settlements'),
    ]);
    renderMetrics(summary);
    document.querySelector('#trips').innerHTML = trips.trips.map(t => `<tr><td>${t.trip_code}</td><td>${t.origin} → ${t.destination}</td><td>${new Date(t.departure_at).toLocaleString()}</td><td>${t.status}</td><td>${t.available_seats}</td><td>${t.total_seats}</td></tr>`).join('') || '<tr><td colspan="6">No trips</td></tr>';
    document.querySelector('#bookings').innerHTML = bookings.bookings.map(b => `<tr><td>${b.reference}</td><td>${b.trip_code}</td><td>${b.origin} → ${b.destination}</td><td>${b.status}</td><td>${b.total_amount} ${b.currency}</td></tr>`).join('') || '<tr><td colspan="5">No bookings</td></tr>';
    document.querySelector('#integrations').innerHTML = (integrations.integrations || []).map(i => `<p><strong>${i.provider}</strong>: ${i.status}</p>`).join('') || '<p>No integrations</p>';
    document.querySelector('#settlements').innerHTML = settlements.settlements.map(s => `<p><strong>${s.operator_name}</strong>: ${s.amount} ${s.currency} (${s.status})</p>`).join('') || '<p>No settlements</p>';
    document.querySelector('#updated').innerHTML = `<small>Updated ${new Date().toLocaleTimeString()}</small>`;
  } catch (err) { errorBox.textContent = err.message; }
}
document.querySelector('#save').onclick = () => { localStorage.setItem('tapi_api_key', keyInput.value.trim()); refresh(); };
document.querySelector('#refresh').onclick = () => { localStorage.removeItem('tapi_mobility_cache'); refresh(); };
keyInput.value = localStorage.getItem('tapi_api_key') || '';
