import { DomainStorageError } from './domainStorage';

/** Domain optional properties are absent JSON fields, not durable undefined values. */
export function domainJson<T>(value: T): T {
  const ancestors = new Set<object>();
  function visit(item: unknown, depth: number): unknown {
    if (depth > 64) throw new DomainStorageError('DOMAIN_PAYLOAD_INVALID');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (!item || typeof item !== 'object' || ancestors.has(item)) throw new DomainStorageError('DOMAIN_PAYLOAD_INVALID');
    ancestors.add(item);
    try {
      if (Array.isArray(item)) {
        if (Object.keys(item).length !== item.length) throw new DomainStorageError('DOMAIN_PAYLOAD_INVALID');
        return item.map(child => visit(child, depth + 1));
      }
      if (![Object.prototype, null].includes(Object.getPrototypeOf(item)) || Object.getOwnPropertySymbols(item).length) {
        throw new DomainStorageError('DOMAIN_PAYLOAD_INVALID');
      }
      const result: Record<string, unknown> = {};
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
        if (!descriptor.enumerable || !('value' in descriptor)) throw new DomainStorageError('DOMAIN_PAYLOAD_INVALID');
        if (descriptor.value !== undefined) Object.defineProperty(result, key, {
          value: visit(descriptor.value, depth + 1), enumerable: true, writable: true, configurable: true,
        });
      }
      return result;
    } finally { ancestors.delete(item); }
  }
  return visit(value, 0) as T;
}
