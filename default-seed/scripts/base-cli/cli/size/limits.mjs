import { d1NativeLimits } from '../../modules/d1-transport/limits.mjs';

// D1 changed how it enforces these limits without notice on 10 Nov 2026, so a
// statement fails here before it reaches them. This is the one place the margin is written.
export const SIZE_MARGIN = 10;

export const d1Limits = Object.freeze({ fromItems: d1NativeLimits.fromItems, depth: d1NativeLimits.exprDepth });
// A statement fails at or above these.
export const failAt = Object.freeze({ fromItems: d1Limits.fromItems - SIZE_MARGIN, depth: d1Limits.depth - SIZE_MARGIN });
