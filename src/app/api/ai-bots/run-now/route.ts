// ===========================================
// POST /api/ai-bots/run-now
// Manual dashboard trigger for Safe AutoPilot
// ===========================================
// Rules:
// - Authentication is required.
// - Safe Mode / Free Only / Safe Publish are enforced by AutoPilot Runner.
// - Paid AI must never be enabled from this route.
// - Run locking and duplicate-run prevention remain inside runAutoPilot().
// - Invalid JSON or invalid mode must never silently start a workflow.

import { type NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import {
  runAutoPilot,
  type AutoPilotMode,
} from '@/lib/bots/autoPilotRunner';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

const DEFAULT_MODE: AutoPilotMode = 'full_safe_run';

const VALID_MODES: readonly AutoPilotMode[] = [
  'full_safe_run',
  'source_scan',
  'health_check',
  'cleanup_broken_products',
] as const;

type RunNowRequestBody = {
  mode?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(
      value &&
      typeof value === 'object' &&
      !Array.isArray(value),
  );
}

function isValidMode(value: unknown): value is AutoPilotMode {
  return (
      typeof value === 'string' &&
      VALID_MODES.includes(value as AutoPilotMode)
  );
}

function createJsonResponse(
    body: Record<string, unknown>,
    status = 200,
) {
  return NextResponse.json(body, {
    status,
    headers: {
      'Cache-Control':
          'no-store, no-cache, must-revalidate, proxy-revalidate',
      Pragma: 'no-cache',
      Expires: '0',
    },
  });
}

async function readRequestBody(
    request: NextRequest,
): Promise<
    | {
  ok: true;
  body: RunNowRequestBody;
}
    | {
  ok: false;
  response: NextResponse;
}
> {
  let rawBody = '';

  try {
    rawBody = await request.text();
  } catch {
    return {
      ok: false,
      response: createJsonResponse(
          {
            ok: false,
            success: false,
            message: 'Không thể đọc dữ liệu yêu cầu.',
            error: 'request_body_read_failed',
          },
          400,
      ),
    };
  }

  if (!rawBody.trim()) {
    return {
      ok: true,
      body: {},
    };
  }

  let parsedBody: unknown;

  try {
    parsedBody = JSON.parse(rawBody);
  } catch {
    return {
      ok: false,
      response: createJsonResponse(
          {
            ok: false,
            success: false,
            message: 'Dữ liệu JSON không hợp lệ.',
            error: 'invalid_json_body',
          },
          400,
      ),
    };
  }

  if (!isRecord(parsedBody)) {
    return {
      ok: false,
      response: createJsonResponse(
          {
            ok: false,
            success: false,
            message: 'Nội dung yêu cầu phải là một JSON object.',
            error: 'invalid_request_body',
          },
          400,
      ),
    };
  }

  return {
    ok: true,
    body: parsedBody as RunNowRequestBody,
  };
}

function getResultStatusCode(status: unknown): number {
  if (status === 'skipped') return 409;
  if (status === 'failed') return 500;

  return 200;
}

function isSuccessfulResult(status: unknown): boolean {
  return status !== 'failed' && status !== 'skipped';
}

export async function POST(request: NextRequest) {
  try {
    const authError = await requireAuth(request);

    if (authError) {
      return authError;
    }

    const parsedRequest = await readRequestBody(request);

    if (!parsedRequest.ok) {
      return parsedRequest.response;
    }

    const requestedMode = parsedRequest.body.mode;

    if (
        requestedMode !== undefined &&
        !isValidMode(requestedMode)
    ) {
      return createJsonResponse(
          {
            ok: false,
            success: false,
            message: 'Chế độ AutoPilot không hợp lệ.',
            error: 'invalid_autopilot_mode',
            allowedModes: VALID_MODES,
          },
          400,
      );
    }

    const mode = isValidMode(requestedMode)
        ? requestedMode
        : DEFAULT_MODE;

    console.info('[api/ai-bots/run-now] AutoPilot requested', {
      mode,
      trigger: 'dashboard',
      safeMode: true,
      freeOnly: true,
      safePublish: true,
      allowPaidAi: false,
    });

    const result = await runAutoPilot({
      mode,
      trigger: 'dashboard',
    });

    const statusCode = getResultStatusCode(result.status);
    const successful = isSuccessfulResult(result.status);

    console.info('[api/ai-bots/run-now] AutoPilot finished', {
      mode,
      status: result.status,
      successful,
    });

    return createJsonResponse(
        {
          ok: successful,
          success: successful,
          message:
              result.message ||
              result.error ||
              (successful
                  ? 'AutoPilot đã hoàn tất.'
                  : result.status === 'skipped'
                      ? 'AutoPilot đang chạy hoặc lượt chạy này đã được bỏ qua.'
                      : 'AutoPilot chạy thất bại.'),
          data: result,
          policy: {
            safeMode: true,
            freeOnly: true,
            safePublish: true,
            allowPaidAi: false,
            costMode: 'safe_free',
          },
        },
        statusCode,
    );
  } catch (error) {
    console.error('[api/ai-bots/run-now] Error:', error);

    return createJsonResponse(
        {
          ok: false,
          success: false,
          message: 'Không thể chạy AutoPilot.',
          error:
              error instanceof Error
                  ? error.message
                  : 'Lỗi không xác định',
          policy: {
            safeMode: true,
            freeOnly: true,
            safePublish: true,
            allowPaidAi: false,
            costMode: 'safe_free',
          },
        },
        500,
    );
  }
}