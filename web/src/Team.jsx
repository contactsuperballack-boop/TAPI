import { useState } from "react";
import { useLoad } from "./useLoad.js";
import { Banner, Chip, Field, Loading, Sheet, Icon, errText } from "./ui.jsx";
import { Empty } from "./TripsView.jsx";
import { ROLE_LABEL, useSession } from "./session.jsx";

function InviteSheet({ api, onClose, onDone }) {
  const [f, setF] = useState({ email: "", fullName: "", role: "agent" });
  const [st, setSt] = useState({ busy: false, error: null });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  async function submit(e) {
    e.preventDefault(); setSt({ busy: true, error: null });
    try { await api.inviteStaff(f); onDone(); } catch (ex) { setSt({ busy: false, error: errText(ex) }); }
  }
  return (
    <Sheet title="Invite a team member" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        {st.error && <Banner>{st.error}</Banner>}
        <Field label="Full name" id="iv-n"><input id="iv-n" className="input" value={f.fullName} onChange={set("fullName")} required autoFocus /></Field>
        <Field label="Email" id="iv-e"><input id="iv-e" className="input" type="email" value={f.email} onChange={set("email")} required /></Field>
        <Field label="Role" id="iv-r"><select id="iv-r" className="select" value={f.role} onChange={set("role")}><option value="agent">Agent: books for clients</option><option value="admin">Admin: also manages the team</option></select></Field>
        <p className="sub" style={{ margin: 0 }}>They get an email with a link to set their password. The link works once and expires in 7 days.</p>
        <button className="btn primary block" disabled={st.busy}>{st.busy ? "Sending…" : "Send invite"}</button>
      </form>
    </Sheet>
  );
}

export function TeamView({ onAuthError }) {
  const { api, principal } = useSession();
  const { data, error, loading, reload } = useLoad(() => api.listStaff(), [api], onAuthError);
  const [open, setOpen] = useState(false); const [err, setErr] = useState(null);
  async function toggle(m) { setErr(null); try { await api.setStaffStatus(m.membershipId, m.status === "active" ? "disabled" : "active"); await reload(); } catch (ex) { setErr(errText(ex)); } }
  return (
    <div className="stack">
      <div className="row between"><div><h1>Team</h1><div className="sub">People who book on behalf of your clients.</div></div>
        <button className="btn primary" onClick={() => setOpen(true)}><Icon name="plus" size={18} />Invite</button></div>
      {error && <Banner onClose={reload}>{errText(error)}</Banner>}
      {err && <Banner onClose={() => setErr(null)}>{err}</Banner>}
      {loading && !data ? <Loading n={2} /> : data && data.length === 0 ? <Empty title="Just you so far" action={<button className="btn primary" onClick={() => setOpen(true)}>Invite a team member</button>}>Invite agents so they can plan and book for clients.</Empty> : (
        <div className="stack">{(data || []).map((m) => (
          <div className="card row between" key={m.membershipId}>
            <div><strong>{m.fullName}</strong><div className="sub">{m.email}</div>
              <div className="row wrap" style={{ marginTop: 6 }}><Chip tone="info">{ROLE_LABEL[m.role]}</Chip>{!m.inviteAccepted && <Chip tone="warn">Invite pending</Chip>}{m.status === "disabled" && <Chip tone="muted">Disabled</Chip>}</div></div>
            {m.userId !== principal.userId && <button className="btn sm" onClick={() => toggle(m)}>{m.status === "active" ? "Disable" : "Enable"}</button>}
          </div>))}
        </div>
      )}
      {open && <InviteSheet api={api} onClose={() => setOpen(false)} onDone={() => { setOpen(false); reload(); }} />}
    </div>
  );
}
