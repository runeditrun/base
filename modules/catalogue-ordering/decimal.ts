/** Exact value: coefficient / 10**scale. Coefficients have no leading zeroes. */
export type Decimal = { coefficient: string; scale: number };
/** A positive conversion factor; exact base-quantity ratios use the same shape. */
export type Rational = { numerator: string; denominator: string };

const MAX_SCALE = 18;
const INPUT_DIGITS = 36;
const COMPUTED_DIGITS = 96;
type Rounding = 'half-away' | 'exact';

function checkedScale(scale: number, maxScale = MAX_SCALE): number {
  if (!Number.isInteger(maxScale) || maxScale < 0 || maxScale > MAX_SCALE) {
    throw new RangeError('Maximum decimal scale must be between zero and eighteen');
  }
  if (!Number.isInteger(scale) || scale < 0 || scale > maxScale) {
    throw new RangeError('Decimal scale is outside the supported range');
  }
  return scale;
}

function integer(text: string, digits: number): bigint {
  if (typeof text !== 'string' || !/^[+-]?\d+$/.test(text)) {
    throw new TypeError('Decimal coefficient must be an integer string');
  }
  if (text.length - (text[0] === '-' || text[0] === '+' ? 1 : 0) > digits) {
    throw new RangeError('Decimal coefficient exceeds its digit limit');
  }
  return BigInt(text);
}

function readDecimal(input: Decimal, maxScale: number, digits: number): Decimal {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('A decimal coefficient and scale are required');
  }
  const scale = checkedScale(input.scale, maxScale);
  return { coefficient: integer(input.coefficient, digits).toString(), scale };
}

function computed(coefficient: bigint, scale: number): Decimal {
  const text = coefficient.toString();
  if (text.length - (coefficient < 0n ? 1 : 0) > COMPUTED_DIGITS) {
    throw new RangeError('Computed decimal exceeds its digit limit');
  }
  return { coefficient: text, scale };
}

function divide(numerator: bigint, denominator: bigint, rounding: Rounding): bigint {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder === 0n) return quotient;
  if (rounding === 'exact') throw new RangeError('Decimal conversion would lose precision');
  const magnitude = remainder < 0n ? -remainder : remainder;
  return magnitude * 2n >= denominator ? quotient + (numerator < 0n ? -1n : 1n) : quotient;
}

/** Parse plain decimal notation; whitespace and exponent notation are rejected. */
export function parseDecimal(text: string, maxScale = MAX_SCALE): Decimal {
  checkedScale(0, maxScale);
  if (typeof text !== 'string') throw new TypeError('Decimal text must be a string');
  // Check the length before scanning or constructing a bigint.
  if (text.length > INPUT_DIGITS + 2) throw new RangeError('Decimal input exceeds its digit limit');
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (match === null) throw new TypeError('Decimal text must use plain decimal notation');
  const fraction = match[3] ?? '';
  const scale = checkedScale(fraction.length, maxScale);
  return { coefficient: integer(`${match[1]}${match[2]}${fraction}`, INPUT_DIGITS).toString(), scale };
}

/** Validate external input. Arithmetic operations also accept computed values up to 96 digits. */
export function validateDecimal(input: Decimal, maxScale = MAX_SCALE): Decimal {
  return readDecimal(input, maxScale, INPUT_DIGITS);
}

/** Validate, canonicalize and reduce a positive, bounded conversion factor. */
export function validateRational(input: Rational): Rational {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('A rational numerator and denominator are required');
  }
  const numerator = integer(input.numerator, INPUT_DIGITS);
  const denominator = integer(input.denominator, INPUT_DIGITS);
  if (numerator <= 0n || denominator <= 0n) {
    throw new RangeError('Conversion numerator and denominator must be positive');
  }
  let a = numerator;
  let b = denominator;
  while (b !== 0n) [a, b] = [b, a % b];
  return { numerator: (numerator / a).toString(), denominator: (denominator / a).toString() };
}

/** Rescale with exact division or signed magnitude half-away rounding. */
export function rescale(value: Decimal, scale: number, rounding: Rounding): Decimal {
  checkedScale(scale);
  if (rounding !== 'exact' && rounding !== 'half-away') throw new TypeError('Unsupported decimal rounding');
  const input = readDecimal(value, MAX_SCALE, COMPUTED_DIGITS);
  const coefficient = BigInt(input.coefficient);
  const difference = scale - input.scale;
  const result = difference >= 0
    ? coefficient * 10n ** BigInt(difference)
    : divide(coefficient, 10n ** BigInt(-difference), rounding);
  return computed(result, scale);
}

/** Add without discarding any input precision. An empty sum is zero at the requested scale. */
export function addDecimals(values: readonly Decimal[], scale: number): Decimal {
  checkedScale(scale);
  if (!Array.isArray(values)) throw new TypeError('Decimal values must be an array');
  let total = 0n;
  for (const value of values) total += BigInt(rescale(value, scale, 'exact').coefficient);
  return computed(total, scale);
}

/** Convert exactly; a nonterminating or over-precision decimal conversion is refused. */
export function convertQuantity(value: Decimal, factor: Rational, scale: number): Decimal {
  checkedScale(scale);
  const input = readDecimal(value, MAX_SCALE, COMPUTED_DIGITS);
  const ratio = validateRational(factor);
  let numerator = BigInt(input.coefficient) * BigInt(ratio.numerator);
  let denominator = BigInt(ratio.denominator);
  const difference = scale - input.scale;
  if (difference >= 0) numerator *= 10n ** BigInt(difference);
  else denominator *= 10n ** BigInt(-difference);
  return computed(divide(numerator, denominator, 'exact'), scale);
}

export function compareDecimals(a: Decimal, b: Decimal): number {
  const left = readDecimal(a, MAX_SCALE, COMPUTED_DIGITS);
  const right = readDecimal(b, MAX_SCALE, COMPUTED_DIGITS);
  const scale = Math.max(left.scale, right.scale);
  const lhs = BigInt(left.coefficient) * 10n ** BigInt(scale - left.scale);
  const rhs = BigInt(right.coefficient) * 10n ** BigInt(scale - right.scale);
  return lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
}
