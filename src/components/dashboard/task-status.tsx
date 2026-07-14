'use client';

import type { DashboardOperation } from '@/lib/dashboard/operations';
import { dashboardStrings } from '@/lib/dashboard/strings';
import { DashboardIcon, type DashboardIconName } from './dashboard-icon';
import styles from './task-status.module.css';

export function TaskStatus({ operation }: { operation: DashboardOperation }) {
  const label = dashboardStrings.status[operation.status];
  const tone = ['failed', 'blocked'].includes(operation.status)
    ? styles.danger
    : operation.status === 'completed'
      ? styles.success
      : operation.status === 'unavailable'
        ? styles.neutral
        : styles.info;
  const icon: DashboardIconName = ['failed', 'blocked'].includes(operation.status)
    ? 'warning'
    : operation.status === 'completed'
      ? 'check'
      : operation.requiresApproval
        ? 'approval'
        : 'task';

  return (
    <section className={`${styles.root} ${tone}`} aria-live="polite" aria-busy={operation.status === 'running'}>
      <div className={styles.header}>
        <div className={styles.title}>
          <span className={styles.statusIcon}><DashboardIcon name={icon} size={19} /></span>
          <span>
          <span className={styles.eyebrow}>Trạng thái tác vụ</span>
          <strong>{label}</strong>
          </span>
        </div>
        {operation.jobId && <span className={styles.job}>Mã tác vụ: {operation.jobId}</span>}
      </div>
      <p>{operation.message}</p>
      {operation.progress !== null && (
        <div className={styles.progress} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={operation.progress}>
          <span style={{ width: `${operation.progress}%` }} />
        </div>
      )}
      {operation.requiresApproval && <div className={styles.approval}>Tác vụ cần được phê duyệt trước khi tiếp tục.</div>}
      <details>
        <summary>Chi tiết kỹ thuật</summary>
        <dl>
          <div><dt>Mã thao tác</dt><dd>{operation.operationId}</dd></div>
          <div><dt>Cập nhật</dt><dd>{new Date(operation.updatedAt).toLocaleString('vi-VN')}</dd></div>
          {operation.errorCode && <div><dt>Mã lỗi</dt><dd>{operation.errorCode}</dd></div>}
        </dl>
      </details>
    </section>
  );
}
