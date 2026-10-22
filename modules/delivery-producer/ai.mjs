import { validateRequest } from '../ai/native/policy.mjs';
/** Packaging asks for capability; this never approves installation spending. */
export function validateAiDeclaration(value) { return validateRequest(value); }
export function validateAiSpec(spec) {
  if (spec.ai === undefined) return;
  const ai = validateAiDeclaration(spec.ai);
  if (!spec.resources.some(r => r.kind === 'r2' && r.binding === ai.imageBinding)) throw Error('AI requires its declared private R2 binding');
  const budget = spec.durableObjects.find(r => r.binding === ai.budgetBinding);
  if (!budget || !spec.durableObjectMigrations.some(m => m.newSqliteClasses?.includes(budget.className))) throw Error('AI requires its declared SQLite budget authority');
}
export function refuseAiHosting(declaration, mode) {
  if (declaration?.ai !== undefined) {
    validateAiDeclaration(declaration.ai);
    const error = new Error(`Native AI ${mode} requires installation approval and held-key provider proof; no inference or deployment was attempted`);
    error.code = 'ai_hosting_unproven';
    throw error;
  }
}
