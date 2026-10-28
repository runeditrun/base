import type { AuthorityGrant, Context, Offer, Options, PartyRef, Predicate, ResolvedSelection, Selection, Snapshot } from './types.ts';
import { addDecimals, validateDecimal } from './decimal.ts';
import { priceExtension, validateArithmetic } from './arithmetic.ts';
import { allowed } from './store.ts';
import { bounded, equal, integer, item, LIMITS, object, party, refuse, selection, text } from './validation.ts';

export async function grant(options: Options, ctx: Context, action: Parameters<Options['authority']['authorize']>[1], subject: PartyRef): Promise<AuthorityGrant> {
  party(subject);
  const value = await options.authority.authorize(ctx, action, subject);
  if (!value) refuse('authority_refused');
  text(value.revision); if (!['commercial', 'cost'].includes(value.fields)) refuse('authority_refused');
  await allowed(options.db, value.guard, 'authority_refused');
  return value;
}
export function validateOffer(offer: Offer, subject: PartyRef): void {
  object(offer, ['item','offerId','revision','description','unit','price','currency','currencyExponent','audience','termsRevision']);
  item(offer.item); text(offer.offerId); text(offer.revision); text(offer.description, LIMITS.text);
  text(offer.unit); text(offer.currency, 3); if (!/^[A-Z]{3}$/.test(offer.currency)) refuse('currency_mismatch');
  integer(offer.currencyExponent, 0, 6); party(offer.audience); text(offer.termsRevision);
  if (!equal(offer.audience, subject)) refuse('authority_refused');
  if (offer.price !== null) validateDecimal(offer.price);
}
export async function resolve(options: Options, ctx: Context, input: Selection): Promise<{ commercial: ResolvedSelection; guards: Predicate[] }> {
  selection(input);
  let loaded: Awaited<ReturnType<Options['offers']['load']>>;
  try { loaded = await options.offers.load(ctx, input.subject, input.lines); }
  catch { refuse('source_unavailable'); }
  if (loaded.offers.length !== input.lines.length) refuse('unavailable_offer');
  const lines = input.lines.map((line, index) => {
    const offer = loaded.offers[index];
    if (!offer) refuse('unavailable_offer'); validateOffer(offer, input.subject);
    if (!equal(offer.item, line.item) || offer.offerId !== line.offerId) refuse('unavailable_offer');
    if (offer.price === null) refuse('unpriced_offer');
    return { selection: line, offer };
  });
  let quote: Awaited<ReturnType<Options['pricing']['resolve']>>;
  try { quote = await options.pricing.resolve(ctx, input.subject, lines); }
  catch { refuse('source_unavailable'); }
  if (quote.lines.length !== lines.length) refuse('invalid_input');
  const currency = lines[0]!.offer.currency, currencyExponent = lines[0]!.offer.currencyExponent;
  let totalScale: number | null = null;
  const priced = lines.map(({ selection: line, offer }, index) => {
    const pricing = quote.lines[index]!;
    object(pricing, ['id','price','conversion','arithmetic','breakdown','calculation']);
    if (pricing.id !== line.id) refuse('invalid_input');
    if (offer.currency !== currency || offer.currencyExponent !== currencyExponent) refuse('currency_mismatch');
    if (!Array.isArray(pricing.breakdown) || pricing.breakdown.length > LIMITS.breakdown) refuse('capacity');
    for (const part of pricing.breakdown) {
      object(part, ['kind','amount','source','visibility']);
      if (!['price','discount','tax','cost','fee'].includes(part.kind) || !['commercial','cost'].includes(part.visibility) || (part.kind === 'cost' && part.visibility !== 'cost')) refuse('invalid_input');
      validateDecimal(part.amount); item(part.source);
    }
    let computed: ReturnType<typeof priceExtension>;
    try { validateArithmetic(pricing.arithmetic); computed = priceExtension(line.quantity, pricing.price, pricing.arithmetic, pricing.conversion); }
    catch { refuse('invalid_quantity'); }
    object(pricing.calculation, ['basis','extension','inputFingerprint']);
    let extension = computed.extension, inputFingerprint: string | null = null;
    if (pricing.calculation.basis === 'native-final') {
      text(pricing.calculation.inputFingerprint, 128);
      inputFingerprint = pricing.calculation.inputFingerprint;
      extension = validateDecimal(pricing.calculation.extension);
      if (extension.scale !== pricing.arithmetic.extensionScale) refuse('invalid_quantity');
    } else if (pricing.calculation.basis !== 'exact') refuse('invalid_input');
    totalScale = Math.max(totalScale ?? 0, extension.scale);
    return { id: line.id, offer: { ...offer, price: validateDecimal(pricing.price) }, quantity: validateDecimal(line.quantity), baseQuantity: computed.baseQuantity, baseQuantityRatio: computed.baseQuantityRatio,
      conversion: pricing.conversion, extension, arithmetic: pricing.arithmetic,
      calculationBasis: pricing.calculation.basis, inputFingerprint, breakdown: pricing.breakdown };
  });
  const terms = quote.terms;
  object(terms, ['revision','description','counterparty','delivery','payment','facts']);
  text(terms.revision); text(terms.description, LIMITS.text); party(terms.counterparty);
  for (const field of [terms.delivery, terms.payment]) if (field !== null) text(field, LIMITS.text);
  if (!terms.facts || typeof terms.facts !== 'object' || Array.isArray(terms.facts) || Object.keys(terms.facts).length > LIMITS.facts) refuse('capacity');
  for (const [key, value] of Object.entries(terms.facts)) { text(key); if (value !== null && typeof value !== 'boolean') text(value, LIMITS.text); }
  const commercial: ResolvedSelection = { subject: input.subject, currency, currencyExponent, lines: priced, total: addDecimals(priced.map(l => l.extension), totalScale!), terms };
  bounded(commercial);
  await allowed(options.db, loaded.guard, 'stale_review');
  await allowed(options.db, quote.guard, 'stale_review');
  return { commercial, guards: [loaded.guard, quote.guard] };
}
export function project<T extends ResolvedSelection | Snapshot>(value: T, fields: AuthorityGrant['fields']): T {
  if (fields === 'cost' || ('status' in value && value.status === 'legacy')) return value;
  return { ...value, lines: (value as ResolvedSelection).lines.map(line => ({ ...line, breakdown: line.breakdown.filter(part => part.visibility !== 'cost') })) };
}
