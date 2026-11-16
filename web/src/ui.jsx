import { useEffect } from "react";

const P = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" };
export const Icon = ({ name, size = 20 }) => {
  const paths = {
    plane: <path d="M10.2 13.8 3 11l1.4-1.4 7.8.9 4-4-9-3.3L8.6 1.5l11 2.7 2.2-2.2c1-.6 2 .4 1.4 1.4l-2.2 2.2 2.7 11-1.4 1.4-3.3-9-4 4 .9 7.8L11.4 22l-2.8-7.2" transform="translate(-1 0) scale(.95)" />,
    bed: <><path d="M3 18V6M3 14h18v4M21 14v-2a3 3 0 0 0-3-3h-7v5"/><circle cx="7" cy="11" r="1.6"/></>,
    trips: <><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></>,
    users: <><circle cx="9" cy="8" r="3.2"/><path d="M3 20c.5-3.4 3-5 6-5s5.500 1.600 6 5M16 5.200a3 3 0 0 1 0 5.600M18 15c2 .6 3.300 2 3.700 5"/></>,
    plus: <path d="M12 5v14M5 12h14"/>, check: <path d="m5 12.500 4.500 4.500L19 7.500"/>, back: <path d="m15 5-7 7 7 7"/>,
    chat: <path d="M4 5h16v11H9l-5 4V5z"/>, search: <><circle cx="11" cy="11" r="6.500"/><path d="m20 20-4.200-4.200"/></>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>, refresh: <path d="M20 11a8 8 0 1 0-2.300 5.700M20 4v7h-7"/>, alert: <><path d="M12 3 2.500 20h19L12 3z"/><path d="M12 10v4M12 17.500v.01"/></>,
    send: <path d="M4 12 20 4l-5 16-3-6.500L4 12z"/>, list: <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...P}>{paths[name] || null}</svg>;
};

export const Chip = ({ tone = "muted", children, title }) => <span className={`chip ${tone}`} title={title}>{children}</span>;

export function Banner({ tone = "bad", children, onClose }) {
  return <div className={`banner ${tone}`} role={tone === "bad" ? "alert" : "status"}><Icon name="alert" size={18} /><div>{children}</div>{onClose && <button onClick={onClose} aria-label="Dismiss">×</button>}</div>;
}

export function Sheet({ title, onClose, children }) {
  useEffect(() => { const h = (e) => e.key === "Escape" && onClose(); window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h); }, [onClose]);
  return (
    <div className="sheet-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="row between"><h2>{title}</h2><button className="btn ghost sm" onClick={onClose}>Close</button></div>
        {children}
      </div>
    </div>
  );
}

export const Field = ({ label, id, children }) => <div className="field"><label htmlFor={id}>{label}</label>{children}</div>;
export const Loading = ({ n = 3 }) => <div className="stack" aria-busy="true" aria-label="Loading">{Array.from({ length: n }, (_, i) => <div key={i} className="skeleton" />)}</div>;
export const errText = (e) => (e && e.message) || "Something went wrong.";
