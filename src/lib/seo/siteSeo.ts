import { config } from '../config';

export function buildSiteJsonLd(): Array<Record<string, unknown>> {
  const searchTarget = new URL('/deals?q={search_term_string}', config.siteUrl).toString();
  return [
    {
      '@context': 'https://schema.org',
      '@type': 'Organization',
      '@id': new URL('/#organization', config.siteUrl).toString(),
      name: 'SanDeal',
      url: config.siteUrl,
      description: 'Nền tảng khám phá deal, so sánh giá và phân tích sản phẩm dựa trên dữ liệu có nguồn.',
    },
    {
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      '@id': new URL('/#website', config.siteUrl).toString(),
      name: 'SanDeal',
      url: config.siteUrl,
      publisher: { '@id': new URL('/#organization', config.siteUrl).toString() },
      potentialAction: {
        '@type': 'SearchAction',
        target: { '@type': 'EntryPoint', urlTemplate: searchTarget },
        'query-input': 'required name=search_term_string',
      },
    },
  ];
}
