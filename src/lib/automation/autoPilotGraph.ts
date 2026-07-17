import type { AutomationExecutionPlanStep } from './types';

export const AUTOPILOT_GRAPH_VERSION = 'autopilot-graph-v1';

const STEPS: Array<{ id: string; capability: string; write: string[]; external: boolean; risk?: 'LOW' | 'MEDIUM' }> = [
  { id: 'runtime-preflight', capability: 'RUNTIME_PREFLIGHT', write: [], external: false, risk: 'LOW' },
  { id: 'source-budget-check', capability: 'CHECK_SOURCE_BUDGET', write: [], external: false, risk: 'LOW' },
  { id: 'source-discovery', capability: 'DISCOVER_PRODUCTS', write: ['candidate-queue'], external: true },
  { id: 'candidate-ingestion', capability: 'INGEST_CANDIDATES', write: ['candidate-queue', 'automation-jobs'], external: false },
  { id: 'classification', capability: 'CLASSIFY_RECORD', write: ['products'], external: false },
  { id: 'normalization', capability: 'NORMALIZE_PRODUCT', write: ['products'], external: false },
  { id: 'evidence-capture', capability: 'CAPTURE_EVIDENCE', write: ['evidence-facts', 'products'], external: false },
  { id: 'health-validation', capability: 'VALIDATE_HEALTH', write: ['products', 'evidence-facts'], external: true },
  { id: 'duplicate-resolution', capability: 'DETECT_DUPLICATES', write: ['duplicate-groups', 'products'], external: false },
  { id: 'price-verification', capability: 'VERIFY_PRICE', write: ['price-history', 'evidence-facts'], external: false },
  { id: 'scoring', capability: 'CALCULATE_CONFIDENCE', write: ['products'], external: false },
  { id: 'content-preparation', capability: 'PREPARE_CONTENT_DRAFT', write: ['content-drafts', 'products'], external: false },
  { id: 'editorial-validation', capability: 'VALIDATE_EDITORIAL', write: ['products'], external: false },
  { id: 'readiness-evaluation', capability: 'EVALUATE_PUBLISH_READINESS', write: ['products'], external: false },
  { id: 'autonomous-publish-or-quarantine', capability: 'AUTO_SAFE_PUBLISH', write: ['products', 'automation-jobs'], external: true },
  { id: 'monitoring-schedule', capability: 'POST_PUBLISH_MONITOR', write: ['automation-jobs'], external: false },
  { id: 'cycle-summary', capability: 'SUMMARIZE_AUTOPILOT_CYCLE', write: ['automation-audit'], external: false, risk: 'LOW' },
];

export function buildAutoPilotExecutionPlan(): AutomationExecutionPlanStep[] {
  return STEPS.map((step, index) => ({
    id: step.id,
    capability: step.capability,
    dependsOn: index ? [STEPS[index - 1].id] : [],
    reason: `Autonomous pipeline step ${index + 1}/${STEPS.length}.`,
    status: 'PENDING',
    risk: step.risk || 'MEDIUM',
    approvalRequired: false,
    expectedWrite: [...step.write],
    externalCall: step.external,
    fallback: step.id === 'content-preparation' ? ['LOCAL_TEMPLATE'] : ['LOCAL_RULES'],
  }));
}
