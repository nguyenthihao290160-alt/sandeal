import { type NextRequest, NextResponse } from 'next/server';
import { getServerActor, requireAuth } from '@/lib/auth';
import { ensurePreCanarySnapshot } from '@/lib/autonomous/backupManager';
import { approveControlledPublishWave, previewControlledModeTransition, previewControlledPublishWave, type CanaryWave, type ControlledModeTransitionPreview } from '@/lib/automation/canaryController';
import { applyBootstrapLaunchProfile, previewBootstrapLaunchProfile } from '@/lib/automation/launchInventory';
import { getAutomationControl, updateAutomationControl } from '@/lib/automation/store';
import type { AutonomousMode } from '@/lib/automation/types';
import { getAutomationSettings } from '@/lib/storage/automationSettings';

const CONFIRMED_ACTIONS = new Set([
  'enable_kill_switch',
  'disable_kill_switch',
  'set_mode',
  'apply_bootstrap_profile',
  'approve_publish_wave',
]);

function modeGateError(preview: ControlledModeTransitionPreview) {
  const blockers = preview.gates.filter(item => !item.passed);
  const first = blockers[0]?.code;
  const code = first === 'OWNER_CONFIRMATION' ? 'CONFIRMATION_REQUIRED'
    : first === 'CONFIRMATION_FRESH' ? 'CONFIRMATION_EXPIRED'
      : first === 'BACKUP_VERIFIED' ? 'BACKUP_NOT_VERIFIED'
        : first === 'CONTROLLED_LAUNCH_PLAN' ? 'CONTROLLED_LAUNCH_REQUIRED'
          : first === 'CONTROLLED_LAUNCH_STATE' ? 'CONTROLLED_LAUNCH_INACTIVE'
            : first === 'LAUNCH_WAVE' ? 'LAUNCH_WAVE_INVALID'
              : first === 'KILL_SWITCH' ? 'KILL_SWITCH_ACTIVE'
                : first === 'NO_CRITICAL_BLOCKER' ? 'CRITICAL_BLOCKER_ACTIVE'
                  : 'CONTROLLED_LAUNCH_HEALTH_FAILED';
  return NextResponse.json({
    ok: false,
    code,
    message: 'Không thể đổi sang chế độ phát hành: controlled launch chưa đạt đầy đủ cổng an toàn.',
    data: { targetMode: preview.targetMode, blockers: blockers.map(item => item.code), gates: preview.gates },
  }, { status: 409 });
}

export async function GET(request: NextRequest) {
  const authError = await requireAuth(request); if (authError) return authError;
  if (request.nextUrl.searchParams.get('profile') === 'BOOTSTRAP_LAUNCH') {
    return NextResponse.json({ ok: true, code: 'PROFILE_PREVIEW', message: 'Đã tạo bản xem trước; settings chưa thay đổi.', data: await previewBootstrapLaunchProfile() });
  }
  const wave = Number(request.nextUrl.searchParams.get('wave'));
  if ([1, 2, 3].includes(wave)) {
    return NextResponse.json({ ok: true, code: 'CONTROLLED_WAVE_PREVIEW', message: 'Bản xem trước read-only; chưa thay đổi settings hoặc tạo backup.', data: await previewControlledPublishWave(wave as CanaryWave) });
  }
  return NextResponse.json({ ok: true, code: 'OK', message: 'Đã tải trạng thái điều khiển.', data: await getAutomationControl() });
}

export async function PATCH(request: NextRequest) {
  const authError = await requireAuth(request); if (authError) return authError;
  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; }
  catch { return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR', message: 'Dữ liệu điều khiển không hợp lệ.' }, { status: 400 }); }
  const action = body.action;
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  const optionalReasonActions = new Set(['pause_worker', 'resume_worker', 'pause_scheduler', 'resume_scheduler', 'pause_autopilot', 'resume_autopilot']);
  if (typeof action !== 'string' || (!optionalReasonActions.has(action) && reason.length < 8)) return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR', message: 'Vui lòng chọn thao tác và nhập lý do ít nhất 8 ký tự.' }, { status: 400 });
  if (CONFIRMED_ACTIONS.has(action) && body.confirmed !== true) return NextResponse.json({ ok: false, code: 'CONFIRMATION_REQUIRED', message: 'Thay đổi chế độ vận hành cần được xác nhận rõ ràng.' }, { status: 409 });

  if (action === 'apply_bootstrap_profile') {
    if (body.profile !== 'BOOTSTRAP_LAUNCH') return NextResponse.json({ ok: false, code: 'PROFILE_INVALID', message: 'Profile bootstrap không hợp lệ.' }, { status: 400 });
    try {
      const data = await applyBootstrapLaunchProfile({ actor: getServerActor(), reason, confirmed: true });
      return NextResponse.json({ ok: true, code: 'BOOTSTRAP_PROFILE_APPLIED', message: 'Đã áp dụng profile bootstrap; launch vẫn tắt và không có sản phẩm nào được public.', data });
    } catch (error) {
      return NextResponse.json({ ok: false, code: error instanceof Error ? error.message : 'PROFILE_APPLY_FAILED', message: 'Không thể áp dụng profile bootstrap.' }, { status: 409 });
    }
  }

  if (action === 'approve_publish_wave') {
    const requestedWave = Number(body.wave);
    if (![1, 2, 3].includes(requestedWave)) return NextResponse.json({ ok: false, code: 'WAVE_INVALID', message: 'Wave phải là 1, 2 hoặc 3.' }, { status: 400 });
    try {
      const data = await approveControlledPublishWave({ requestedWave: requestedWave as CanaryWave, actor: getServerActor(), reason, confirmed: true });
      return NextResponse.json({ ok: true, code: 'CONTROLLED_WAVE_APPROVED', message: 'Wave đã được phê duyệt sau khi kiểm tra health và backup.', data });
    } catch (error) {
      const code = error instanceof Error ? error.message.slice(0, 500) : 'WAVE_APPROVAL_FAILED';
      return NextResponse.json({ ok: false, code, message: 'Wave vẫn bị chặn; publish settings không thay đổi.' }, { status: 409 });
    }
  }

  const requestedMode = typeof body.mode === 'string' ? body.mode as AutonomousMode : undefined;
  if (action === 'set_mode' && (!requestedMode || !['OBSERVE', 'SHADOW', 'CANARY', 'AUTONOMOUS', 'EMERGENCY_STOP'].includes(requestedMode))) {
    return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR', message: 'Chế độ vận hành không hợp lệ.' }, { status: 400 });
  }
  let currentControl = await getAutomationControl();
  if (action === 'set_mode' && (requestedMode === 'CANARY' || requestedMode === 'AUTONOMOUS')) {
    const changesPublishSafety = currentControl.mode !== requestedMode || currentControl.effectiveMode !== requestedMode;
    if (changesPublishSafety) {
      const gateOptions = {
        ownerConfirmed: body.confirmed === true,
        confirmationAt: typeof body.confirmedAt === 'string' ? body.confirmedAt : undefined,
      };
      let preliminary: ControlledModeTransitionPreview;
      try { preliminary = await previewControlledModeTransition(requestedMode, gateOptions); }
      catch {
        return NextResponse.json({
          ok: false, code: 'CONTROLLED_LAUNCH_GATE_UNAVAILABLE',
          message: 'Không thể đánh giá đầy đủ controlled launch gate; chế độ vận hành không thay đổi.',
        }, { status: 503 });
      }
      const nonBackupBlockers = preliminary.gates.filter(item => !item.passed && item.code !== 'BACKUP_VERIFIED');
      if (nonBackupBlockers.length) return modeGateError({ ...preliminary, gates: nonBackupBlockers, eligible: false });
      try { await ensurePreCanarySnapshot({ targetMode: requestedMode, retention: 30 }); }
      catch { return NextResponse.json({ ok: false, code: 'PRE_CANARY_BACKUP_FAILED', message: 'Không thể xác minh bản sao lưu trước khi đổi chế độ vận hành.' }, { status: 503 }); }
      let verified: ControlledModeTransitionPreview;
      try { verified = await previewControlledModeTransition(requestedMode, { ...gateOptions, backupVerified: true }); }
      catch {
        return NextResponse.json({
          ok: false, code: 'CONTROLLED_LAUNCH_GATE_UNAVAILABLE',
          message: 'Không thể xác minh lại controlled launch gate sau backup; chế độ vận hành không thay đổi.',
        }, { status: 503 });
      }
      if (!verified.eligible) return modeGateError(verified);
      currentControl = await getAutomationControl();
      if (currentControl.killSwitch) return NextResponse.json({ ok: false, code: 'KILL_SWITCH_ACTIVE', message: 'Kill switch đang bật; chế độ vận hành không thay đổi.' }, { status: 409 });
    }
  }
  const changedAt = new Date();
  const settings = optionalReasonActions.has(action) && (action === 'resume_scheduler' || action === 'resume_autopilot') ? await getAutomationSettings() : null;
  const resumedNextRunAt = settings ? new Date(changedAt.getTime() + settings.intervalHours * 60 * 60_000).toISOString() : undefined;
  const pauseReason = reason || 'Tạm dừng từ bảng điều khiển.';
  const effectiveReason = reason || (action.startsWith('resume_') ? 'Tiếp tục từ bảng điều khiển.' : pauseReason);
  const updates = action === 'pause_worker' ? { workerPaused: true } : action === 'resume_worker' ? { workerPaused: false }
    : action === 'pause_scheduler' ? { schedulerPaused: true, pausedAt: changedAt.toISOString(), pauseReason, schedulerNextRunAt: undefined }
      : action === 'resume_scheduler' ? { schedulerPaused: false, pausedAt: undefined, pauseReason: undefined, schedulerNextRunAt: resumedNextRunAt }
      : action === 'pause_autopilot' ? { schedulerPaused: true, publishPausedByOperator: true, pausedAt: changedAt.toISOString(), pauseReason, schedulerNextRunAt: undefined }
        : action === 'resume_autopilot' ? { schedulerPaused: false, publishPausedByOperator: false, pausedAt: undefined, pauseReason: undefined, schedulerNextRunAt: resumedNextRunAt }
          : action === 'set_mode' && requestedMode === 'EMERGENCY_STOP' ? {
            mode: requestedMode, killSwitch: true, publishBlockedByPolicy: true,
            publishPolicyReasons: ['KILL_SWITCH_ACTIVE'], ingestionPaused: true,
          }
            : action === 'set_mode' && (requestedMode === 'CANARY' || requestedMode === 'AUTONOMOUS') ? {
              mode: requestedMode, effectiveMode: requestedMode, publishBlockedByPolicy: false, publishPolicyReasons: [],
            }
              : action === 'set_mode' && (requestedMode === 'OBSERVE' || requestedMode === 'SHADOW') ? {
                mode: requestedMode, effectiveMode: requestedMode, killSwitch: false,
                publishBlockedByPolicy: true, publishPolicyReasons: ['EFFECTIVE_MODE_NOT_PUBLISHABLE'],
                ingestionPaused: requestedMode === 'OBSERVE',
              }
              : action === 'enable_kill_switch' ? {
                mode: 'EMERGENCY_STOP' as const, killSwitch: true, publishBlockedByPolicy: true,
                publishPolicyReasons: ['KILL_SWITCH_ACTIVE'], ingestionPaused: true,
              }
                : action === 'disable_kill_switch' ? {
                  mode: 'OBSERVE' as const, effectiveMode: 'OBSERVE' as const, killSwitch: false,
                  publishBlockedByPolicy: true, publishPolicyReasons: ['EFFECTIVE_MODE_NOT_PUBLISHABLE'], ingestionPaused: true,
                } : null;
  if (!updates) return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR', message: 'Thao tác điều khiển không hợp lệ.' }, { status: 400 });
  const state = await updateAutomationControl({ ...updates, reason: effectiveReason }, 'dashboard-admin');
  return NextResponse.json({ ok: true, code: 'OK', message: 'Đã cập nhật trạng thái vận hành.', data: state });
}
