// ===========================================
// POST /api/ai-bots/run-now
// Manual dashboard trigger for Safe AutoPilot
// ===========================================
// Rules:
// - Authentication is required.
// - Safe Mode / Free Only / Safe Publish are enforced by AutoPilot Runner.
// - Paid AI must never be enabled from this route.
// - Idempotency and duplicate prevention are enforced by the durable job store.
// - Invalid JSON or invalid mode must never silently start a workflow.

import { type NextRequest, NextResponse } from 'next/server';
import { getServerActor, requirePermission } from '@/lib/auth';
import { enqueueBotExecution } from '@/lib/automation/enqueue';
import { publicAutomationJob } from '@/lib/automation/store';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

type AutoPilotMode = 'full_safe_run' | 'source_scan' | 'health_check' | 'cleanup_broken_products';

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

export async function POST(request: NextRequest) {
  try {
    const authError = await requirePermission(request, 'MANAGE_AUTOMATION');

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

    const result = await enqueueBotExecution({
      actor: getServerActor(),
      mode,
      trigger: 'dashboard',
      requestedExecutionMode: 'AUTO',
    });

    return createJsonResponse(
        {
          ok: true,
          success: true,
          code: result.code,
          message: result.created ? 'Đã đưa AutoPilot vào hàng đợi bền vững.' : 'Tác vụ tương đương đã tồn tại; không tạo lần chạy thứ hai.',
          data: {
            job: publicAutomationJob(result.job),
            jobId: result.job.id,
            operationId: result.job.operationId,
            trackingRoute: `/api/automation/jobs/${result.job.id}`,
          },
          policy: {
            safeMode: true,
            freeOnly: true,
            safePublish: true,
            allowPaidAi: false,
            costMode: 'safe_free',
          },
        },
        result.created ? 202 : 200,
    );
  } catch (error) {
    return createJsonResponse(
        {
          ok: false,
          success: false,
          message: 'Không thể chạy AutoPilot.',
          error: error instanceof Error && ['INVALID_IDEMPOTENCY_KEY', 'BOT_NOT_AVAILABLE'].includes(error.message) ? error.message : 'VALIDATION_ERROR',
          policy: {
            safeMode: true,
            freeOnly: true,
            safePublish: true,
            allowPaidAi: false,
            costMode: 'safe_free',
          },
        },
        400,
    );
  }
}
