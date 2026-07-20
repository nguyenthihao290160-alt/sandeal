import { ImageResponse } from 'next/og';

export const dynamic = 'force-static';

export async function GET(_request: Request, { params }: { params: Promise<{ size: string }> }) {
  const rawSize = (await params).size.replace(/\.png$/i, '');
  const maskable = rawSize === '512-maskable';
  const dimension = rawSize === '192' ? 192 : rawSize === '512' || maskable ? 512 : null;
  if (!dimension) return new Response('Not found', { status: 404 });
  return new ImageResponse(
    <div style={{ display: 'flex', width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center', color: 'white', background: 'linear-gradient(145deg, #3157c8, #0f7b8d)', borderRadius: maskable ? 0 : Math.round(dimension * 0.2), fontSize: Math.round(dimension * (maskable ? 0.54 : 0.68)), fontWeight: 900 }}>S</div>,
    { width: dimension, height: dimension, headers: { 'Cache-Control': 'public, max-age=31536000, immutable' } },
  );
}
