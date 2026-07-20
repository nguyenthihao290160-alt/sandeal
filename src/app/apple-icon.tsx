import { ImageResponse } from 'next/og';

export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

export default function AppleIcon() {
  return new ImageResponse(
    <div style={{ display: 'flex', width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center', color: 'white', background: 'linear-gradient(145deg, #3157c8, #0f7b8d)', borderRadius: 38, fontSize: 124, fontWeight: 900 }}>S</div>,
    size,
  );
}
