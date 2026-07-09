'use client';

export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="vi">
      <body
        style={{
          margin: 0,
          fontFamily:
            'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
          background: '#f8fbff',
        }}
      >
        <div
          style={{
            minHeight: '100vh',
            display: 'grid',
            placeItems: 'center',
            padding: '40px 24px',
            textAlign: 'center',
          }}
        >
          <div style={{ maxWidth: 480 }}>
            <div
              style={{
                width: 56,
                height: 56,
                margin: '0 auto 20px',
                borderRadius: 18,
                display: 'grid',
                placeItems: 'center',
                background: 'linear-gradient(135deg, #4f46e5, #06b6d4)',
                color: '#ffffff',
                fontWeight: 900,
                fontSize: 24,
              }}
            >
              !
            </div>

            <h2
              style={{
                fontSize: 22,
                fontWeight: 900,
                margin: '0 0 12px',
                color: '#0f172a',
              }}
            >
              Hệ thống gặp sự cố
            </h2>

            <p
              style={{
                color: '#64748b',
                lineHeight: 1.7,
                margin: '0 0 24px',
              }}
            >
              Đã xảy ra lỗi không mong muốn. Vui lòng thử tải lại trang.
            </p>

            <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
              <button
                type="button"
                onClick={reset}
                style={{
                  padding: '12px 24px',
                  borderRadius: 12,
                  border: '1px solid #e2e8f0',
                  background: '#ffffff',
                  color: '#0f172a',
                  fontWeight: 800,
                  cursor: 'pointer',
                }}
              >
                Tải lại trang
              </button>

              <a
                href="/"
                style={{
                  padding: '12px 24px',
                  borderRadius: 12,
                  border: 'none',
                  background: 'linear-gradient(135deg, #4f46e5, #06b6d4)',
                  color: '#ffffff',
                  fontWeight: 800,
                  textDecoration: 'none',
                }}
              >
                Về trang chủ
              </a>
            </div>
          </div>
        </div>
      </body>
    </html>
  );
}
