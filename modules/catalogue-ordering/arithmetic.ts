import { convertQuantity, rescale, validateDecimal, validateRational } from './decimal.ts';
import type { Decimal, Rational } from './decimal.ts';

export type Arithmetic = {
  id: string;
  revision: string;
  quantityScale: number;
  extensionScale: number;
  rounding: 'half-away' | 'exact';
};

export const CENTS_WHOLE: Arithmetic = Object.freeze({
  id: 'cents-whole', revision: '1', quantityScale: 0, extensionScale: 2, rounding: 'half-away',
});
export const CENTS_THOUSANDTH: Arithmetic = Object.freeze({
  id: 'cents-thousandth', revision: '1', quantityScale: 3, extensionScale: 2, rounding: 'half-away',
});
export const CENTS_MILLIONTH: Arithmetic = Object.freeze({
  id: 'cents-millionth', revision: '1', quantityScale: 6, extensionScale: 2, rounding: 'half-away',
});
export const EXACT_TWELVE: Arithmetic = Object.freeze({
  id: 'exact-twelve', revision: '1', quantityScale: 6, extensionScale: 12, rounding: 'exact',
});
export const SIX_PLACE: Arithmetic = Object.freeze({
  id: 'six-place', revision: '1', quantityScale: 6, extensionScale: 6, rounding: 'half-away',
});
export const RATIONAL_EIGHTEEN: Arithmetic = Object.freeze({
  id: 'rational-eighteen', revision: '1', quantityScale: 18, extensionScale: 2, rounding: 'half-away',
});

export const ARITHMETIC = Object.freeze({
  CENTS_WHOLE, CENTS_THOUSANDTH, CENTS_MILLIONTH, EXACT_TWELVE, SIX_PLACE, RATIONAL_EIGHTEEN,
});

/** Only the complete, versioned built-in profiles are accepted. */
export function validateArithmetic(input: Arithmetic): Arithmetic {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('An arithmetic profile is required');
  }
  const keys = Object.keys(input);
  if (keys.length !== 5 || !keys.every(key => ['id', 'revision', 'quantityScale', 'extensionScale', 'rounding'].includes(key))) {
    throw new TypeError('Arithmetic profile fields are not supported');
  }
  const profile = Object.values(ARITHMETIC).find(value => value.id === input.id && value.revision === input.revision);
  if (profile === undefined || input.quantityScale !== profile.quantityScale
    || input.extensionScale !== profile.extensionScale || input.rounding !== profile.rounding) {
    throw new RangeError('Arithmetic profile is not supported');
  }
  return profile;
}

function baseRatio(quantity: Decimal, factor: Rational): Rational {
  const numerator = BigInt(quantity.coefficient) * BigInt(factor.numerator);
  const denominator = 10n ** BigInt(quantity.scale) * BigInt(factor.denominator);
  let a = numerator;
  let b = denominator;
  while (b !== 0n) [a, b] = [b, a % b];
  return { numerator: (numerator / a).toString(), denominator: (denominator / a).toString() };
}

function extend(ratio: Rational, price: Decimal, arithmetic: Arithmetic): Decimal {
  const numerator = BigInt(ratio.numerator) * BigInt(price.coefficient) * 10n ** BigInt(arithmetic.extensionScale);
  const denominator = BigInt(ratio.denominator) * 10n ** BigInt(price.scale);
  let coefficient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder !== 0n) {
    if (arithmetic.rounding === 'exact') throw new RangeError('Price extension would lose precision');
    const magnitude = remainder < 0n ? -remainder : remainder;
    if (magnitude * 2n >= denominator) coefficient += numerator < 0n ? -1n : 1n;
  }
  // Rescale validates the common 96-digit computed coefficient bound.
  return rescale({ coefficient: coefficient.toString(), scale: arithmetic.extensionScale }, arithmetic.extensionScale, 'exact');
}

/**
 * Multiply the exact converted quantity and price before a single final rounding.
 * Rational eighteen retains an exact ratio when its base quantity has no decimal
 * representation within eighteen places. Every other profile requires one.
 */
export function priceExtension(
  quantity: Decimal,
  price: Decimal,
  arithmetic: Arithmetic,
  factor: Rational = { numerator: '1', denominator: '1' },
): { baseQuantity: Decimal | null; baseQuantityRatio: Rational; extension: Decimal } {
  const profile = validateArithmetic(arithmetic);
  const inputQuantity = validateDecimal(quantity, profile.quantityScale);
  if (BigInt(inputQuantity.coefficient) <= 0n) throw new RangeError('Quantity must be positive');
  const priceScale = profile.id === RATIONAL_EIGHTEEN.id ? 18
    : profile.id === EXACT_TWELVE.id || profile.id === SIX_PLACE.id ? 6 : 2;
  const inputPrice = validateDecimal(price, priceScale);
  const conversion = validateRational(factor);
  const ratio = baseRatio(inputQuantity, conversion);
  const scaledNumerator = BigInt(ratio.numerator) * 10n ** BigInt(profile.quantityScale);
  const representable = scaledNumerator % BigInt(ratio.denominator) === 0n;
  const baseQuantity = profile.id === RATIONAL_EIGHTEEN.id && !representable
    ? null : convertQuantity(inputQuantity, conversion, profile.quantityScale);
  return { baseQuantity, baseQuantityRatio: ratio, extension: extend(ratio, inputPrice, profile) };
}
