// ===========================================
// Token Vault Types — Strict credential management
// ===========================================

// ---- Platform & Credential Enums ----

export type CredentialPlatform =
  | 'gemini'
  | 'accesstrade'
  | 'facebook'
  | 'instagram'
  | 'threads'
  | 'youtube'
  | 'tiktok'
  | 'shopee'
  | 'lazada'
  | 'system'
  | 'other';

export type CredentialType =
  | 'api_key'
  | 'user_token'
  | 'page_token'
  | 'access_token'
  | 'refresh_token'
  | 'client_id'
  | 'client_secret'
  | 'app_secret'
  | 'other';

export type CredentialStatus =
  | 'unchecked'
  | 'valid'
  | 'invalid'
  | 'expired'
  | 'missing_permission'
  | 'disabled'
  | 'error';

export type CredentialRole =
  | 'primary'
  | 'backup'
  | 'disabled'
  | 'testing';

export type GeminiBillingMode = 'free_confirmed' | 'paid' | 'unknown';
export type GeminiKeyType = 'auth' | 'restricted_standard' | 'standard' | 'unknown';
export type GeminiGenerationStatus =
  | 'unchecked'
  | 'available'
  | 'rate_limited'
  | 'quota_exhausted'
  | 'cooldown'
  | 'transient_error'
  | 'model_unavailable'
  | 'region_restricted'
  | 'provider_unavailable'
  | 'invalid'
  | 'missing_permission'
  | 'disabled';
export type GeminiLightTestStatus = 'unchecked' | 'available' | 'invalid' | 'missing_permission' | 'transient_error';
export type GeminiDiagnosticCategory =
  | 'READY'
  | 'FREE_POLICY_UNVERIFIED'
  | 'INVALID_KEY'
  | 'PERMISSION_DENIED'
  | 'QUOTA_EXCEEDED'
  | 'RATE_LIMITED'
  | 'MODEL_NOT_AVAILABLE'
  | 'REGION_RESTRICTED'
  | 'NETWORK_TIMEOUT'
  | 'PROVIDER_UNAVAILABLE'
  | 'TRANSIENT_ERROR'
  | 'UNKNOWN_PROVIDER_ERROR';

export interface GeminiCredentialMetadata {
  provider?: 'gemini';
  priority?: number;
  projectAlias?: string;
  quotaGroupId?: string;
  billingMode: GeminiBillingMode;
  keyType: GeminiKeyType;
  supportedModels: string[];
  supportedGenerateContentModels?: string[];
  preferredModel?: string;
  testedModel?: string;
  lightTestStatus: GeminiLightTestStatus;
  generationStatus: GeminiGenerationStatus;
  generationReady?: boolean;
  generationReadinessReason?: string;
  freePolicyEligible?: boolean;
  adapterReady?: boolean;
  runtimeRouteReady?: boolean;
  diagnosticCategory?: GeminiDiagnosticCategory;
  retryable?: boolean;
  providerHttpStatus?: number;
  discoveredModelCount?: number;
  lastCheckedAt?: string;
  lastLightTestAt?: string;
  lastGenerationTestAt?: string;
  generationVerifiedAt?: string;
  lastGenerationSucceededAt?: string;
  lastSuccessfulRequestAt?: string;
  lastFailureAt?: string;
  lastErrorCode?: string;
  errorCategory?: string;
  failureStreak: number;
  cooldownUntil?: string;
  nextProbeAt?: string;
  quotaExhaustedUntil?: string;
  requestsTodayEstimated: number;
  inputTokensTodayEstimated: number;
  outputTokensTodayEstimated: number;
  healthScore: number;
}

// ---- Stored Credential (server-side full object) ----

export interface StoredCredential {
  id: string;
  platform: CredentialPlatform;
  credentialType: CredentialType;
  role: CredentialRole;
  label: string;
  /** Encrypted value — server-side only, NEVER sent to frontend */
  encryptedValue: string;
  /** Masked value safe for frontend display */
  maskedValue: string;
  status: CredentialStatus;
  permissions?: string[];
  metadata?: Record<string, unknown>;
  lastCheckedAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

// ---- Safe Credential (frontend projection — no secrets) ----

export type SafeCredential = Omit<StoredCredential, 'encryptedValue'> & {
  readiness?: {
    state: 'stored' | 'valid' | 'generation_ready' | 'cooldown' | 'quota_limited' | 'invalid' | 'disabled' | 'missing_permission' | 'unknown';
    stored: boolean;
    valid: boolean;
    generationReady: boolean;
    reasonCode: 'ready' | 'not_applicable' | 'credential_not_checked' | 'credential_not_valid' | 'generation_not_verified' | 'generation_check_stale' | 'generation_temporarily_unavailable' | 'cooldown_active' | 'quota_limited' | 'free_policy_unverified' | 'billing_not_confirmed' | 'quota_group_missing' | 'model_not_verified' | 'model_not_available' | 'region_restricted' | 'provider_unavailable' | 'invalid' | 'disabled' | 'missing_permission' | 'unknown';
    priority: number;
    preferredModel: string | null;
    testedModel: string | null;
    projectLabel: string | null;
    quotaGroup: string | null;
    cooldownUntil: string | null;
    lastCheckedAt: string | null;
    lastGenerationSucceededAt: string | null;
    diagnosticCategory: GeminiDiagnosticCategory | null;
    retryable: boolean;
    freePolicyEligible: boolean;
    adapterReady: boolean;
    errorCategory: string | null;
    httpStatus: number | null;
  };
};

// ---- Input for creating a credential ----

export interface CreateCredentialInput {
  platform: CredentialPlatform;
  credentialType: CredentialType;
  label?: string;
  value: string;
  role?: CredentialRole;
  metadata?: Record<string, unknown>;
}

// ---- Input for replacing a credential value ----

export interface ReplaceCredentialInput {
  id: string;
  value: string;
}

// ---- Filters for listing credentials ----

export interface CredentialFilters {
  platform?: CredentialPlatform;
  credentialType?: CredentialType;
  status?: CredentialStatus;
  role?: CredentialRole;
}

// ---- Grouped credentials for UI display ----

export interface CredentialGroup {
  platform: CredentialPlatform;
  label: string;
  icon: string;
  credentials: SafeCredential[];
}

// ---- Vault statistics (for health check) ----

export interface VaultStats {
  totalCredentials: number;
  geminiKeysCount: number;
  geminiPrimaryConfigured: boolean;
  accessTradeConfigured: boolean;
  socialTokensCount: number;
  affiliateKeysCount: number;
  disabledCount: number;
  errorCount: number;
  lastCheckTime?: string;
}

// ---- Platform metadata for UI ----

export const PLATFORM_CONFIG: Record<CredentialPlatform, { label: string; icon: string; group: string }> = {
  gemini: { label: 'Gemini', icon: '🤖', group: 'AI Providers' },
  accesstrade: { label: 'AccessTrade', icon: '🔗', group: 'Affiliate Sources' },
  shopee: { label: 'Shopee', icon: '🛒', group: 'Affiliate Sources' },
  lazada: { label: 'Lazada', icon: '🏪', group: 'Affiliate Sources' },
  tiktok: { label: 'TikTok', icon: '🎵', group: 'Social Channels' },
  facebook: { label: 'Facebook', icon: '📘', group: 'Social Channels' },
  instagram: { label: 'Instagram', icon: '📷', group: 'Social Channels' },
  threads: { label: 'Threads', icon: '🧵', group: 'Social Channels' },
  youtube: { label: 'YouTube', icon: '▶️', group: 'Social Channels' },
  system: { label: 'Hệ thống', icon: '⚙️', group: 'System' },
  other: { label: 'Khác', icon: '🔌', group: 'System' },
};

export const CREDENTIAL_TYPE_LABELS: Record<CredentialType, string> = {
  api_key: 'Khóa API (khóa truy cập dịch vụ)',
  user_token: 'Mã truy cập người dùng',
  page_token: 'Mã truy cập trang',
  access_token: 'Mã truy cập',
  refresh_token: 'Mã làm mới kết nối',
  client_id: 'Mã ứng dụng',
  client_secret: 'Khóa bí mật ứng dụng',
  app_secret: 'Khóa bí mật hệ thống',
  other: 'Khác',
};

export const CREDENTIAL_STATUS_LABELS: Record<CredentialStatus, { label: string; badge: string }> = {
  unchecked: { label: 'Chưa kiểm tra', badge: 'badge-neutral' },
  valid: { label: 'Hợp lệ', badge: 'badge-success' },
  invalid: { label: 'Không hợp lệ', badge: 'badge-danger' },
  expired: { label: 'Hết hạn', badge: 'badge-danger' },
  missing_permission: { label: 'Thiếu quyền', badge: 'badge-warning' },
  disabled: { label: 'Đã tắt', badge: 'badge-neutral' },
  error: { label: 'Lỗi', badge: 'badge-danger' },
};

export const CREDENTIAL_ROLE_LABELS: Record<CredentialRole, { label: string; badge: string }> = {
  primary: { label: 'Chính', badge: 'badge-purple' },
  backup: { label: 'Dự phòng', badge: 'badge-neutral' },
  disabled: { label: 'Đã tắt', badge: 'badge-neutral' },
  testing: { label: 'Thử nghiệm', badge: 'badge-info' },
};
