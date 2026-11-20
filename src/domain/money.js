// Exact money arithmetic. All settlement and FX maths happens on INTEGER minor units (kobo, cents, pence); floats
// never touch a balance. Anything that cannot be represented exactly is rejected, not rounded silently.
const EXPONENTS = { JPY: 0, KRW: 0, UGX: 0, VND: 0, XOF: 0, XAF: 0, RWF: 0, CLP: 0, KWD: 3, BHD: 3, JOD: 3, OMR: 3, TND: 3 };

const exponent = (currency) => (currency in EXPONENTS ? EXPONENTS[currency] : 2);

/** "1234.56" | 1234.56 -> 123456. Throws if more precision than the currency allows. */
function toMinor(amount, currency) {
  const exp = exponent(currency);
  let s = typeof amount === "number" ? amount.toFixed(Math.min(exp + 6, 12)) : String(amount).trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new Error(`Invalid money amount '${amount}'`);
  const neg = s.startsWith("-");
  if (neg) s = s.slice(1);
  let [int, frac = ""] = s.split(".");
  if (frac.length > exp) {
    if (/[^0]/.test(frac.slice(exp))) throw new Error(`Amount '${amount}' has more precision than ${currency} allows (${exp} decimals)`);
    frac = frac.slice(0, exp);
  }
  const minor = Number(int + frac.padEnd(exp, "0")) * (neg ? -1 : 1);
  if (!Number.isSafeInteger(minor)) throw new Error(`Amount '${amount}' is too large`);
  return minor;
}

function fromMinor(minor, currency) {
  if (!Number.isSafeInteger(minor)) throw new Error("minor units must be a safe integer");
  const exp = exponent(currency);
  const neg = minor < 0;
  const digits = String(Math.abs(minor)).padStart(exp + 1, "0");
  const out = exp === 0 ? digits : `${digits.slice(0, -exp)}.${digits.slice(-exp)}`;
  return neg ? `-${out}` : out;
}

/** Split totalMinor proportionally to weights using largest-remainder, so parts ALWAYS sum to the total. */
function allocate(totalMinor, weights) {
  if (!Number.isSafeInteger(totalMinor) || totalMinor < 0) throw new Error("total must be a non-negative integer");
  if (!weights.length) throw new Error("no weights to allocate over");
  const w = weights.map(BigInt);
  if (w.some((x) => x < 0n)) throw new Error("weights must be non-negative");
  const sum = w.reduce((a, b) => a + b, 0n);
  if (sum === 0n) throw new Error("weights sum to zero");
  const T = BigInt(totalMinor);
  const parts = w.map((x) => (T * x) / sum);
  let rest = Number(T - parts.reduce((a, b) => a + b, 0n));
  const order = w.map((x, i) => ({ i, rem: (T * x) % sum })).sort((a, b) => (a.rem === b.rem ? a.i - b.i : a.rem > b.rem ? -1 : 1));
  for (let k = 0; rest > 0; k++, rest--) parts[order[k % order.length].i] += 1n;
  return parts.map(Number);
}

module.exports = { exponent, toMinor, fromMinor, allocate };
