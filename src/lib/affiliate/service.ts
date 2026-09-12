import type {
  AffiliateDiscoveryInput,
  AffiliateProvider,
} from './types';

/** Domain-facing use case: callers depend only on the provider contract. */
export function discoverAffiliateProducts(
  provider: AffiliateProvider,
  input: AffiliateDiscoveryInput = {},
) {
  return provider.discoverProducts(input);
}
