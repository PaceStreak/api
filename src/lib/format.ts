/**
 * Python number formatting, bit-for-bit (DESIGN.md §4 "Floats"):
 * - `pyRound(x, n)`  = Python `round(x, n)`: round-half-even on the exact binary value,
 * - `formatG(x)`     = Python `"%g" % x` / `format(x, "g")`,
 * - `pyStr(x)`       = Python `str(x)` / `repr(x)` for floats.
 * JS `toFixed`/`toPrecision` round exact ties away from zero, so ties are decided here on exact decimal digits.
 */

/** x = digits × 10^-scale exactly, for finite x >= 0. */
function exactDecimal(x: number): { digits: bigint; scale: number } {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  const bits = view.getBigUint64(0);
  const expBits = Number((bits >> 52n) & 0x7ffn);
  const frac = bits & 0xfffffffffffffn;
  const mantissa = expBits === 0 ? frac : frac | (1n << 52n);
  const e = (expBits === 0 ? 1 : expBits) - 1075;
  if (e >= 0) return { digits: mantissa << BigInt(e), scale: 0 };
  return { digits: mantissa * 5n ** BigInt(-e), scale: -e };
}

/** round-half-even of n / 10^s for s > 0. */
function divRoundHalfEven(n: bigint, s: number): bigint {
  const p = 10n ** BigInt(s);
  const q = n / p;
  const twice = 2n * (n % p);
  if (twice > p) return q + 1n;
  if (twice < p) return q;
  return q % 2n === 0n ? q : q + 1n;
}

/**
 * Python `round(x)` (ndigits omitted: an integer, so never -0) and `round(x, ndigits)` (a float, which keeps -0.0
 * like CPython does).
 */
export function pyRound(x: number, ndigits?: number): number {
  if (ndigits === undefined) {
    const r = pyRound(x, 0);
    return r === 0 ? 0 : r;
  }
  if (!Number.isFinite(x) || x === 0) return x;
  const { digits, scale } = exactDecimal(Math.abs(x));
  if (ndigits >= scale) return x;
  const n = divRoundHalfEven(digits, scale - ndigits);
  // value = n × 10^-ndigits; parse a decimal string so the result is the double nearest to it, as Python does.
  const r = Number(`${n}e${-ndigits}`);
  return x < 0 ? -r : r;
}

/** Python `"%g" % x` (precision 6 by default; `"%.{p}g"` otherwise). */
export function formatG(x: number, precision = 6): string {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  const p = precision === 0 ? 1 : precision;
  const sign = x < 0 || Object.is(x, -0) ? "-" : "";
  if (x === 0) return `${sign}0`;
  const { digits, scale } = exactDecimal(Math.abs(x));
  let d = digits.toString();
  let exp = d.length - 1 - scale;
  const cut = d.length - p;
  if (cut > 0) {
    let r = divRoundHalfEven(digits, cut).toString();
    if (r.length > p) {
      r = r.slice(0, p);
      exp += 1;
    }
    d = r;
  } else {
    d = d.padEnd(p, "0");
  }
  if (exp < -4 || exp >= p) {
    const mant = trimZeros(`${d[0]}.${d.slice(1)}`);
    const e = Math.abs(exp).toString().padStart(2, "0");
    return `${sign}${mant}e${exp < 0 ? "-" : "+"}${e}`;
  }
  return sign + trimZeros(placePoint(d, exp));
}

/** Python `repr(float)`: shortest round-trip digits, exponent when exp < -4 or exp >= 16, `.0` on integers. */
export function pyStr(x: number): string {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
  const sign = x < 0 ? "-" : "";
  const [mant = "", e = "0"] = Math.abs(x).toExponential().split("e");
  const d = mant.replace(".", "");
  const exp = Number(e);
  if (exp < -4 || exp >= 16) {
    const m = d.length > 1 ? `${d[0]}.${d.slice(1)}` : d;
    return `${sign}${m}e${exp < 0 ? "-" : "+"}${Math.abs(exp).toString().padStart(2, "0")}`;
  }
  const fixed = placePoint(d, exp);
  return sign + (fixed.includes(".") ? fixed : `${fixed}.0`);
}

/** Digits `d` (first digit at 10^exp) as a plain decimal string. */
function placePoint(d: string, exp: number): string {
  if (exp < 0) return `0.${"0".repeat(-exp - 1)}${d}`;
  if (exp + 1 >= d.length) return d + "0".repeat(exp + 1 - d.length);
  return `${d.slice(0, exp + 1)}.${d.slice(exp + 1)}`;
}

function trimZeros(s: string): string {
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}
