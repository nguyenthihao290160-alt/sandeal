// ===========================================
// API: Token Vault — Test Credential
// ===========================================
// Tests a credential by its platform/type.
// Updates status, lastCheckedAt, permissions, lastError.
// Server-side only — raw values never sent to client.

import { NextRequest } from 'next/server';
import { successResponse, errorResponse, serverErrorResponse } from '@/lib/apiResponse';
import { getCredentialById, getRawCredentialValue, getSafeCredentialById, updateCredential } from '@/lib/storage/tokenVault';
import type { CredentialStatus } from '@/lib/types/tokenVault';
import { requireAuth } from '@/lib/auth';
import { lightTestCredential } from '@/lib/ai/geminiCredentialProbe';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const authError = await requireAuth(request);
  if (authError) return authError;
  try {
    const body = await request.json();
    const { id } = body as { id?: string };

    if (!id || typeof id !== 'string') {
      return errorResponse('ID credential là bắt buộc.');
    }

    const cred = await getCredentialById(id);
    if (!cred) {
      return errorResponse('Không tìm thấy credential.', undefined, 404);
    }

    if (cred.platform === 'gemini') {
      const diagnostic = await lightTestCredential(id);
      const updated = await getSafeCredentialById(id);
      if (!updated) return errorResponse('Không thể tải kết quả kiểm tra.');
      return successResponse(diagnostic.message, { ...updated, providerDiagnostic: diagnostic });
    }

    const rawValue = await getRawCredentialValue(id);
    if (!rawValue) {
      return errorResponse('Không thể đọc giá trị credential.');
    }

    // Test by platform
    let status: CredentialStatus = 'unchecked';
    let permissions: string[] | undefined;
    let lastError: string | undefined;
    let metadata: Record<string, unknown> | undefined = cred.metadata;

    switch (cred.platform) {
      case 'accesstrade':
        ({ status, lastError } = await testAccessTradeKey(rawValue));
        break;

      case 'facebook':
        ({ status, permissions, lastError, metadata } = await testFacebookToken(rawValue, cred.credentialType));
        break;

      case 'instagram':
        status = 'unchecked';
        lastError = undefined;
        metadata = {
          ...metadata,
          note: 'Instagram cần Page đã liên kết tài khoản Business/Creator và token có quyền phù hợp.',
        };
        break;

      case 'threads':
        status = 'unchecked';
        lastError = undefined;
        metadata = {
          ...metadata,
          note: 'Threads token đã lưu. Kiểm tra đăng bài sẽ được thêm ở module Channel Manager.',
        };
        break;

      default:
        // YouTube, TikTok, Shopee, Lazada, System, Other
        status = 'unchecked';
        lastError = undefined;
        metadata = {
          ...metadata,
          note: 'Chưa hỗ trợ kiểm tra tự động cho nền tảng này.',
        };
        break;
    }

    // Update credential
    const updated = await updateCredential(id, {
      status,
      permissions,
      metadata,
      lastError,
      lastCheckedAt: new Date().toISOString(),
    });

    if (!updated) {
      return errorResponse('Không thể cập nhật kết quả kiểm tra.');
    }

    // Build user-facing message
    let message = 'Đã kiểm tra credential.';
    if (status === 'valid') message = 'Token hợp lệ.';
    else if (status === 'invalid') message = 'Token không hợp lệ hoặc đã hết hạn.';
    else if (status === 'expired') message = 'Token đã hết hạn.';
    else if (status === 'missing_permission') message = 'Thiếu quyền cần thiết.';
    else if (status === 'error') message = lastError || 'Lỗi khi kiểm tra.';
    else if (status === 'unchecked') message = 'Chưa hỗ trợ kiểm tra tự động cho loại token này.';

    return successResponse(message, updated);
  } catch (err) {
    return serverErrorResponse('Lỗi khi kiểm tra credential.', err);
  }
}

// ---- AccessTrade Test ----

async function testAccessTradeKey(apiKey: string): Promise<{
  status: CredentialStatus;
  lastError?: string;
}> {
  if (!apiKey || apiKey.length < 5) {
    return { status: 'invalid', lastError: 'API key quá ngắn.' };
  }

  try {
    const res = await fetch('https://api.accesstrade.vn/v1/offers_informations?limit=1', {
      method: 'GET',
      headers: {
        'Authorization': `Token ${apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (res.ok) {
      return { status: 'valid' };
    }

    if (res.status === 401 || res.status === 403) {
      return {
        status: 'invalid',
        lastError: `AccessTrade API trả về lỗi ${res.status}. Key không hợp lệ hoặc hết hạn.`,
      };
    }

    return {
      status: 'error',
      lastError: `AccessTrade API trả về HTTP ${res.status}.`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Lỗi không xác định';
    return {
      status: 'error',
      lastError: `Không thể kết nối AccessTrade API: ${msg.slice(0, 200)}`,
    };
  }
}

// ---- Facebook Test ----

async function testFacebookToken(
  token: string,
  credentialType: string
): Promise<{
  status: CredentialStatus;
  permissions?: string[];
  lastError?: string;
  metadata?: Record<string, unknown>;
}> {
  if (!token || token.length < 10) {
    return { status: 'invalid', lastError: 'Token quá ngắn.' };
  }

  const result: {
    status: CredentialStatus;
    permissions?: string[];
    lastError?: string;
    metadata?: Record<string, unknown>;
  } = {
    status: 'unchecked',
    metadata: {},
  };

  // Test /me endpoint
  try {
    const meRes = await fetch(
      `https://graph.facebook.com/me?fields=id,name&access_token=${token}`,
      { signal: AbortSignal.timeout(10000) }
    );

    if (meRes.ok) {
      const meData = await meRes.json() as { id?: string; name?: string };
      result.status = 'valid';
      result.metadata = {
        ...result.metadata,
        userId: meData.id,
        userName: meData.name,
      };
    } else if (meRes.status === 190 || meRes.status === 401 || meRes.status === 400) {
      const errData = await meRes.json().catch(() => null) as { error?: { message?: string } } | null;
      result.status = 'invalid';
      result.lastError = errData?.error?.message || `Facebook trả về lỗi ${meRes.status}.`;
      return result;
    } else {
      result.status = 'error';
      result.lastError = `Facebook API trả về HTTP ${meRes.status}.`;
      return result;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Lỗi không xác định';
    result.status = 'error';
    result.lastError = `Không thể kết nối Facebook API: ${msg.slice(0, 200)}`;
    return result;
  }

  // Test /me/accounts for page tokens (don't fail if this errors)
  if (credentialType === 'user_token' || credentialType === 'page_token') {
    try {
      const accountsRes = await fetch(
        `https://graph.facebook.com/me/accounts?fields=id,name,access_token,tasks&access_token=${token}`,
        { signal: AbortSignal.timeout(10000) }
      );

      if (accountsRes.ok) {
        const accountsData = await accountsRes.json() as {
          data?: Array<{ id?: string; name?: string; tasks?: string[] }>;
        };
        const pages = accountsData.data || [];
        result.metadata = {
          ...result.metadata,
          pagesCount: pages.length,
          pages: pages.map(p => ({
            id: p.id,
            name: p.name,
            tasks: p.tasks,
          })),
        };
        if (pages.length > 0) {
          result.permissions = pages[0].tasks || [];
        }
      } else {
        // Don't fail the whole test — just note missing permission
        result.metadata = {
          ...result.metadata,
          pagesNote: 'Token thiếu quyền hoặc chưa có quyền quản lý Page.',
        };
        if (result.status === 'valid') {
          result.status = 'missing_permission';
        }
      }
    } catch {
      result.metadata = {
        ...result.metadata,
        pagesNote: 'Không thể kiểm tra quyền quản lý Page.',
      };
    }
  }

  return result;
}
