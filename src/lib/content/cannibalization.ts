import { CannibalizationRisk, ContentEntity, ContentIntent } from './types';

export function evaluateCannibalizationRisk(
  candidateIntent: ContentIntent,
  candidateSlug: string,
  candidateCanonicalEntityId: string,
  existingContent: ContentEntity[]
): { risk: CannibalizationRisk; reasonCodes: string[] } {
  const reasonCodes: string[] = [];

  for (const existing of existingContent) {
    if (existing.lifecycle === 'BLOCKED' || existing.lifecycle === 'ARCHIVED') {
      continue;
    }

    const sameIntent = existing.intent === candidateIntent;
    const sameEntity = existing.canonicalTarget?.entityId === candidateCanonicalEntityId;
    
    let slugConflict = false;
    if (existing.canonicalTarget && existing.canonicalTarget.url.endsWith(candidateSlug)) {
        slugConflict = true;
    }

    if (sameEntity && sameIntent) {
      reasonCodes.push('SAME_PRODUCT_SAME_INTENT');
      return { risk: 'BLOCK_NEW_CONTENT', reasonCodes };
    }

    if (slugConflict) {
      reasonCodes.push('DUPLICATE_SLUG');
      return { risk: 'CANONICAL_CONFLICT', reasonCodes };
    }

    if (sameEntity && !sameIntent) {
      // Different intent, but same product. Might be acceptable depending on intent
      if (candidateIntent === 'COMPARISON' || candidateIntent === 'HOW_TO') {
        reasonCodes.push('DISTINCT_INTENT_SAME_PRODUCT');
      } else {
        reasonCodes.push('OVERLAP_INTENT_SAME_PRODUCT');
        return { risk: 'OVERLAP', reasonCodes };
      }
    }
  }

  reasonCodes.push('NO_CANNIBALIZATION_RISK');
  return { risk: 'SAFE', reasonCodes };
}
