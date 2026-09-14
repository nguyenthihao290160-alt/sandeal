import { ContentPlan, ContentAction, ContentIntent, ContentCoverage, CannibalizationRisk, ContentEntity } from './types';
import { evaluateCannibalizationRisk } from './cannibalization';
import { CONTENT_INTELLIGENCE_VERSION } from './config';
import { createHash } from 'crypto';

export interface PlannerInputs {
  opportunityId: string;
  policyState: 'ALLOW' | 'BLOCK' | 'QUARANTINE' | 'ALLOW_WITH_REVIEW';
  existingContent: ContentEntity[];
  candidateIntent: ContentIntent;
  candidateSlug: string;
  candidateCanonicalEntityId: string;
  materialChangeDetected: boolean;
  opportunityFingerprint: string;
}

export function generateContentFingerprint(inputs: PlannerInputs): string {
  const hash = createHash('sha256');
  hash.update(inputs.opportunityId);
  hash.update(inputs.policyState);
  hash.update(inputs.candidateIntent);
  hash.update(inputs.candidateCanonicalEntityId);
  hash.update(inputs.materialChangeDetected ? 'material_change' : 'no_change');
  hash.update(inputs.opportunityFingerprint);
  const existingIds = inputs.existingContent.map(c => c.id).sort();
  hash.update(existingIds.join(','));
  hash.update(CONTENT_INTELLIGENCE_VERSION);
  return hash.digest('hex');
}

export function planContent(inputs: PlannerInputs): ContentPlan {
  const reasonCodes: string[] = [];
  const riskCodes: string[] = [];
  let action: ContentAction = 'NO_ACTION';
  
  if (inputs.policyState === 'BLOCK' || inputs.policyState === 'QUARANTINE') {
    reasonCodes.push('POLICY_BLOCKED');
    return createPlan(inputs, 'BLOCK', 'BLOCKED_COVERAGE', 'SAFE', reasonCodes, riskCodes);
  }

  const { risk, reasonCodes: cannibalizationReasons } = evaluateCannibalizationRisk(
    inputs.candidateIntent,
    inputs.candidateSlug,
    inputs.candidateCanonicalEntityId,
    inputs.existingContent
  );
  
  reasonCodes.push(...cannibalizationReasons);

  // Filter existing content to only those that match exactly what we're trying to create
  const exactlyMatchingContent = inputs.existingContent.filter(c => 
    c.intent === inputs.candidateIntent && c.canonicalTarget?.entityId === inputs.candidateCanonicalEntityId
  );

  let coverage: ContentCoverage = 'NO_COVERAGE';
  if (exactlyMatchingContent.length > 0) {
    if (inputs.materialChangeDetected) {
        coverage = 'STALE_COVERAGE';
    } else {
        coverage = 'ADEQUATE_COVERAGE';
    }
  }

  if (risk === 'BLOCK_NEW_CONTENT' || risk === 'CANONICAL_CONFLICT') {
    if (inputs.materialChangeDetected) {
      action = 'REFRESH_EXISTING_CONTENT';
      reasonCodes.push('REFRESH_EXISTING_CANNIBALIZATION_GUARD');
    } else {
      action = 'NO_ACTION';
      reasonCodes.push('NO_MATERIAL_CHANGE');
    }
  } else if (risk === 'OVERLAP' || risk === 'MERGE_RECOMMENDED') {
    action = 'MERGE_CONTENT';
    reasonCodes.push('MERGE_DUE_TO_OVERLAP');
  } else if (risk === 'SAFE') {
    if (exactlyMatchingContent.length === 0) {
      action = 'CREATE_CONTENT_CANDIDATE';
      if (inputs.candidateIntent === 'COMPARISON') action = 'CREATE_COMPARISON_CANDIDATE';
      if (inputs.candidateIntent === 'BUYING_GUIDE') action = 'CREATE_BUYING_GUIDE_CANDIDATE';
      reasonCodes.push('CREATE_NEW_CONTENT_SAFE');
    } else {
      if (inputs.materialChangeDetected) {
        action = 'REFRESH_EXISTING_CONTENT';
        reasonCodes.push('REFRESH_EXISTING_SAFE');
      } else {
        action = 'NO_ACTION';
        reasonCodes.push('NO_MATERIAL_CHANGE_SAFE');
      }
    }
  }

  return createPlan(inputs, action, coverage, risk, reasonCodes, riskCodes);
}

function createPlan(
  inputs: PlannerInputs,
  action: ContentAction,
  coverage: ContentCoverage,
  cannibalizationRisk: CannibalizationRisk,
  reasonCodes: string[],
  riskCodes: string[]
): ContentPlan {
  const fingerprint = generateContentFingerprint(inputs);
  
  return {
    id: `plan-${fingerprint.substring(0, 12)}`,
    action,
    intent: inputs.candidateIntent,
    coverage,
    cannibalizationRisk,
    refreshRequired: action === 'REFRESH_EXISTING_CONTENT',
    mustInclude: [],
    mustAvoid: [],
    affiliateDisclosureRequired: true,
    reasonCodes,
    riskCodes,
    evidenceFingerprint: fingerprint,
    algorithmVersion: CONTENT_INTELLIGENCE_VERSION,
    plannedAt: new Date().toISOString()
  };
}
