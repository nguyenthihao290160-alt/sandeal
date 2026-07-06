// ===========================================
// API: Token Vault — Save Credential
// ===========================================

import { NextRequest } from 'next/server';
import { successResponse, errorResponse, serverErrorResponse } from '@/lib/apiResponse';
import { createCredential, replaceCredentialValue } from '@/lib/storage/tokenVault';
import type { CredentialPlatform, CredentialType, CredentialRole } from '@/lib/types/tokenVault';

export const dynamic = 'force-dynamic';

const VALID_PLATFORMS: CredentialPlatform[] = [
  'gemini', 'accesstrade', 'facebook', 'instagram', 'threads',
  'youtube', 'tiktok', 'shopee', 'lazada', 'system', 'other',
];

const VALID_TYPES: CredentialType[] = [
  'api_key', 'user_token', 'page_token', 'access_token', 'refresh_token',
  'client_id', 'client_secret', 'app_secret', 'other',
];

const VALID_ROLES: CredentialRole[] = ['primary', 'backup', 'disabled', 'testing'];

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { platform, credentialType, label, value, role, metadata, replaceId } = body as {
      platform?: string;
      credentialType?: string;
      label?: string;
      value?: string;
      role?: string;
      metadata?: Record<string, unknown>;
      replaceId?: string;
    };

    // --- Replace existing credential ---
    if (replaceId && typeof replaceId === 'string') {
      if (!value || typeof value !== 'string' || value.trim().length === 0) {
        return errorResponse('Giá trị token/API key là bắt buộc.');
      }
      const updated = await replaceCredentialValue(replaceId, value.trim());
      if (!updated) {
        return errorResponse('Không tìm thấy credential để thay thế.', undefined, 404);
      }
      return successResponse('Đã cập nhật giá trị credential.', updated);
    }

    // --- Create new credential ---

    // Validate platform
    if (!platform || !VALID_PLATFORMS.includes(platform as CredentialPlatform)) {
      return errorResponse('Nền tảng không hợp lệ.');
    }

    // Validate type
    if (!credentialType || !VALID_TYPES.includes(credentialType as CredentialType)) {
      return errorResponse('Loại credential không hợp lệ.');
    }

    // Validate value
    if (!value || typeof value !== 'string' || value.trim().length === 0) {
      return errorResponse('Giá trị token/API key là bắt buộc.');
    }

    // Validate role if provided
    if (role && !VALID_ROLES.includes(role as CredentialRole)) {
      return errorResponse('Vai trò không hợp lệ.');
    }

    const credential = await createCredential({
      platform: platform as CredentialPlatform,
      credentialType: credentialType as CredentialType,
      label: label ? String(label).trim() : undefined,
      value: value.trim(),
      role: role as CredentialRole | undefined,
      metadata,
    });

    return successResponse('Đã lưu token/API key.', credential, 201);
  } catch (err) {
    return serverErrorResponse('Không thể lưu credential.', err);
  }
}
