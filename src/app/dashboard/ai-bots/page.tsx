'use client';

import { useEffect, useState } from 'react';
import styles from './ai-bots.module.css';
import type { BotTeamStatus, BotRun } from '@/lib/types';

export default function AIBotsPage() {
  const [status, setStatus] = useState<BotTeamStatus | null>(null);
  const [runs, setRuns] = useState<BotRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const loadData = async () => {
      try {
        setLoading(true);
        const [statusRes, runsRes] = await Promise.all([
          fetch('/api/ai-bots/status'),
          fetch('/api/ai-bots/runs'),
        ]);

        if (!statusRes.ok || !runsRes.ok) {
          throw new Error('Failed to load bot status');
        }

        const statusData = await statusRes.json();
        const runsData = await runsRes.json();

        setStatus(statusData.data);
        setRuns(runsData.data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setLoading(false);
      }
    };

    loadData();
    const interval = setInterval(loadData, 30000); // Refresh every 30s
    return () => clearInterval(interval);
  }, []);

  const handleRunBot = async (mode: string) => {
    try {
      const res = await fetch('/api/ai-bots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode,
          source: 'all',
          limit: 10,
        }),
      });

      if (!res.ok) {
        throw new Error('Failed to start bot run');
      }

      // Reload runs
      const runsRes = await fetch('/api/ai-bots/runs');
      const runsData = await runsRes.json();
      setRuns(runsData.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    }
  };

  if (loading) {
    return (
      <div className={styles.container}>
        <div className={styles.loading}>Loading bot infrastructure...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={styles.container}>
        <div className={styles.error}>Error: {error}</div>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <h1>Đội Bot AI SanDeal</h1>
        <p>Professional AI Bot Command Center</p>
      </header>

      {/* System Status */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>System Status</h2>
        {status && (
          <div className={styles.statusGrid}>
            <div className={styles.statusCard}>
              <div className={styles.statusLabel}>Safe Mode</div>
              <div className={styles.statusValue}>{status.safeMode ? 'ON' : 'OFF'}</div>
            </div>
            <div className={styles.statusCard}>
              <div className={styles.statusLabel}>Free Only</div>
              <div className={styles.statusValue}>{status.freeOnly ? 'ON' : 'OFF'}</div>
            </div>
            <div className={styles.statusCard}>
              <div className={styles.statusLabel}>Auto Publish</div>
              <div className={styles.statusValue}>{status.autoPublish ? 'ON' : 'OFF'}</div>
            </div>
            <div className={styles.statusCard}>
              <div className={styles.statusLabel}>Gemini</div>
              <div className={styles.statusValue}>{status.hasGeminiPrimaryToken ? '✓' : '✗'}</div>
            </div>
            <div className={styles.statusCard}>
              <div className={styles.statusLabel}>AccessTrade</div>
              <div className={styles.statusValue}>{status.hasAccessTradePrimaryToken ? '✓' : '✗'}</div>
            </div>
          </div>
        )}
      </section>

      {/* Workflow Controls */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Workflow Controls</h2>
        <div className={styles.buttonGrid}>
          <button className={styles.button} onClick={() => handleRunBot('source_scan')}>
            Scan Sources
          </button>
          <button className={styles.button} onClick={() => handleRunBot('deal_hunt')}>
            Hunt Deals
          </button>
          <button className={styles.button} onClick={() => handleRunBot('score_only')}>
            Score Products
          </button>
          <button className={styles.button} onClick={() => handleRunBot('link_health')}>
            Check Links
          </button>
          <button className={`${styles.button} ${styles.buttonPrimary}`} onClick={() => handleRunBot('full_safe_run')}>
            Run Full Pipeline
          </button>
        </div>
      </section>

      {/* Recent Runs */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Recent Bot Runs</h2>
        {runs.length === 0 ? (
          <div className={styles.empty}>No bot runs yet.</div>
        ) : (
          <div className={styles.runsList}>
            {runs.slice(0, 10).map(run => (
              <div key={run.id} className={styles.runItem}>
                <div className={styles.runMode}>{run.mode}</div>
                <div className={styles.runStatus}>{run.status}</div>
                <div className={styles.runTime}>{new Date(run.startedAt).toLocaleString()}</div>
                <div className={styles.runStats}>
                  {run.candidatesFound} candidates, {run.productsSaved} saved
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Product Stats */}
      {status && (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Product Inventory</h2>
          <div className={styles.statsGrid}>
            <div className={styles.statCard}>
              <div className={styles.statNumber}>{status.productCount}</div>
              <div className={styles.statLabel}>Total</div>
            </div>
            <div className={styles.statCard}>
              <div className={styles.statNumber}>{status.approvedProductCount}</div>
              <div className={styles.statLabel}>Approved</div>
            </div>
            <div className={styles.statCard}>
              <div className={styles.statNumber}>{status.reviewProductCount}</div>
              <div className={styles.statLabel}>Review</div>
            </div>
            <div className={styles.statCard}>
              <div className={styles.statNumber}>{status.brokenLinkCount}</div>
              <div className={styles.statLabel}>Broken</div>
            </div>
            <div className={styles.statCard}>
              <div className={styles.statNumber}>{status.contentPackageCount}</div>
              <div className={styles.statLabel}>Content Packages</div>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
