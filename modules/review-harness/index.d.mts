import type { Page, BrowserContext, BrowserType } from '@playwright/test';

export const PINS: Readonly<{ '@playwright/test': '1.63.0'; '@axe-core/playwright': '4.13.0'; 'axe-core': '4.13.0' }>;
export interface Versions { pinned: typeof PINS; actual: Record<keyof typeof PINS, string> }
export function resolveVersions(cwd: string): Versions;
export function loadDependencies(cwd: string): Versions & { chromium: BrowserType; AxeBuilder: new (options: { page: Page }) => { withTags(tags: string[]): { analyze(): Promise<unknown> } } };
export interface RuntimeOptions {
  cwd: string; command: string; args?: string[]; env?: Record<string, string>;
  healthPath?: string; readyTimeoutMs?: number; stopTimeoutMs?: number; logDir?: string;
  signal?: AbortSignal;
  secrets?: string[]; fixtures?: (origin: string, signal?: AbortSignal) => Promise<void> | void;
}
export interface Runtime { origin: string; port: number; logPath: string; pid: number; stop(): Promise<void> }
export function startRuntime(options: RuntimeOptions): Promise<Runtime>;
export interface SignInOptions {
  origin: string;
  open: string | URL | ((page: Page, signal?: AbortSignal) => Promise<string | URL | void> | string | URL | void);
  signal?: AbortSignal; timeoutMs?: number;
}
export function signIn(page: Page, options: SignInOptions): Promise<void>;
export function installCollection(context: BrowserContext, options: { origin: string; secrets?: string[] }): Promise<void>;
export interface GateOptions { failOn?: 'serious' | 'any'; expectStatus?: number }
export type CapturePolicy = 'canonical' | 'failures' | 'exhaustive';
export type ImageView = 'viewport' | 'full-page';
export const CAPTURE_POLICIES: readonly CapturePolicy[];
export interface AuditOptions extends GateOptions {
  cwd: string; secrets?: string[]; timeoutMs?: number; keyboard?: boolean; keyboardReason?: string;
}
export interface CaptureOptions extends AuditOptions {
  evidence: string; continueOnFailure?: boolean; capturePolicy?: CapturePolicy;
  canonical?: boolean; imageViews?: ImageView[];
  onCapture?: (entry: CaptureEntry) => Promise<void> | void;
}
export interface Viewport { width: number; height: number }
export const VIEWPORTS: readonly Readonly<Viewport>[];
export const AXE_TAGS: readonly string[];
export interface AuditEntry {
  name: string; width: number; path: string; documentStatus: number | null;
  axe: { counts: Record<'minor' | 'moderate' | 'serious' | 'critical' | 'unknown', number>; violations: { id: string; impact: string | null; help: string; targets: (string | string[])[][] }[] };
  overflow: { viewport: number; document: number; body: number };
  errors: { page: string[]; console: { text: string; url: string; resource: boolean }[]; settle: string[] };
  failedResponses: { url: string; status: number; mainDocument: boolean }[];
  externalRequests: string[]; secretsFound: number[];
  keyboard: { enabled: boolean; passed: boolean; reason?: string };
  gate: { passed: boolean; failures: string[] };
}
export interface CaptureEntry extends AuditEntry {
  canonical: boolean;
  imageRetention: { kept: boolean; reason: 'failure' | 'canonical' | 'exhaustive' | 'passing-state' | 'noncanonical-state' | 'image-creation-failed'; requestedViews: ImageView[] };
  images: { file: string; view: ImageView; bytes: number }[];
}
export function audit(page: Page, name: string, options: AuditOptions): Promise<AuditEntry>;
export function settle(page: Page, options?: { timeoutMs?: number }): Promise<void>;
export function capture(page: Page, name: string, options: CaptureOptions): Promise<CaptureEntry>;
export function evaluateGates(entry: AuditEntry, options?: GateOptions): CaptureEntry['gate'];
export class CaptureError extends Error { entry: CaptureEntry; constructor(entry: CaptureEntry) }
export interface Report {
  schemaVersion: 2; capturePolicy: CapturePolicy; historyLimit: number; versions: Versions & { chromium: string | null }; origin: string;
  startedAt: string; finishedAt: string | null; captures: CaptureEntry[]; errors: string[];
  totals: { captures: number; passed: number; failed: number } | null; passed: boolean;
}
export interface JourneyStep {
  page: Page; context: BrowserContext; width: number; viewport: Viewport; origin: string;
  signal?: AbortSignal;
  capture(name: string, options?: Omit<CaptureOptions, 'cwd' | 'evidence' | 'onCapture' | 'capturePolicy'>): Promise<CaptureEntry>;
}
export interface JourneyOptions extends GateOptions {
  cwd: string; origin: string; evidence: string; widths?: readonly (number | Viewport)[];
  signal?: AbortSignal; secrets?: string[]; timeoutMs?: number; keyboard?: boolean; keyboardReason?: string;
  capturePolicy?: CapturePolicy; historyLimit?: number;
  continueOnFailure?: boolean; run(step: JourneyStep): Promise<void>;
}
export function journey(options: JourneyOptions): Promise<{ report: Report; reportPath: string }>;
export class ReviewError extends Error { report: Report; reportPath: string; constructor(report: Report, reportPath: string) }
export function writeReport(evidence: string, report: Report, secrets?: string[]): Promise<string>;
