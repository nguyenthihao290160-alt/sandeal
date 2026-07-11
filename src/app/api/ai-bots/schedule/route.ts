import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { getAutomationSettings, updateAutomationSettings } from '@/lib/storage/automationSettings';
import { getRunLockStatus } from '@/lib/bots/runLock';
import { listRunLogs } from '@/lib/bots/runLogs';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const authError = await requireAuth(request);
  if (authError) return authError;

  try {
    const settings = await getAutomationSettings();
    const lockStatus = await getRunLockStatus();
    const recentLogs = await listRunLogs(20); // Get latest 20 logs
    const lastRun = recentLogs.length > 0 ? recentLogs[0] : null;

    // Calculate daily usage
    const tzOffset = 7 * 60 * 60 * 1000;
    const nowMs = Date.now() + tzOffset;
    const todayStr = new Date(nowMs).toISOString().split('T')[0];

    let dailyUsage = 0;
    for (const log of recentLogs) {
      if (log.status !== 'completed' && log.status !== 'failed') continue;
      if (!log.finishedAt) continue;
      
      const logMs = new Date(log.finishedAt).getTime() + tzOffset;
      if (isNaN(logMs)) continue;
      
      const logDateStr = new Date(logMs).toISOString().split('T')[0];
      if (logDateStr === todayStr && log.summary?.saved) {
        dailyUsage += log.summary.saved;
      }
    }

    // Calculate next run
    let nextRunAt = null;
    if (settings.enabled && settings.intervalHours) {
      if (lastRun && lastRun.finishedAt) {
        const lastFinishedMs = new Date(lastRun.finishedAt).getTime();
        nextRunAt = new Date(lastFinishedMs + settings.intervalHours * 60 * 60 * 1000).toISOString();
      } else {
        // If no last run, run immediately
        nextRunAt = new Date().toISOString();
      }
    }

    const currentStatus = lockStatus.isLocked ? 'running' : (settings.enabled ? 'idle' : 'paused');

    return NextResponse.json({
      settings,
      currentStatus,
      activeLock: lockStatus.isLocked ? lockStatus.lock : null,
      lastRun,
      nextRunAt,
      recentRuns: recentLogs.slice(0, 5),
      dailyUsage,
      dailyRemaining: Math.max(0, settings.maxItemsPerDay - dailyUsage),
      policy: {
        safeMode: settings.safePublish,
        freeOnly: settings.freeOnly,
        safePublish: settings.safePublish,
        allowPaidAi: settings.allowPaidAi,
        costMode: settings.costMode,
      },
    });
  } catch (err) {
    return NextResponse.json({ error: 'Failed to fetch schedule data' }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  const authError = await requireAuth(request);
  if (authError) return authError;

  try {
    const contentType = request.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      return NextResponse.json({ error: 'Content-Type must be application/json' }, { status: 400 });
    }

    const body = await request.json();
    
    // Check for policy violations directly in the payload
    if (
      body.safePublish === false ||
      body.freeOnly === false ||
      body.allowPaidAi === true ||
      (body.costMode && body.costMode !== 'safe_free') ||
      body.safeMode === false
    ) {
      return NextResponse.json({ 
        error: 'Policy violation: Cannot override safety immutables.' 
      }, { status: 403 });
    }

    // Pick only allowed fields
    const updates: any = {};
    const allowedFields = [
      'enabled', 'sourceScanEnabled', 'intervalHours', 'mode', 'source',
      'maxItemsPerRun', 'maxItemsPerDay', 'autoClassify', 'autoCheckPrice',
      'autoCheckLink', 'autoCheckImage', 'autoScore', 'duplicateProtection'
    ];

    for (const field of allowedFields) {
      if (body[field] !== undefined) {
        updates[field] = body[field];
      }
    }

    const updatedSettings = await updateAutomationSettings(updates);

    return NextResponse.json({
      success: true,
      settings: updatedSettings
    });
  } catch (err: any) {
    if (err instanceof SyntaxError) {
      return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 });
    }
    return NextResponse.json({ 
      error: err.message || 'Failed to update schedule settings' 
    }, { status: 500 });
  }
}
