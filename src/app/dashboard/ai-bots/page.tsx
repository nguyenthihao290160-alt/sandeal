'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import styles from './ai-bots.module.css';
import type { BotTeamStatus, BotRun } from '@/lib/types';

const BOTS = [
  { id: 'orchestrator', name: 'AI Boss Orchestrator', desc: 'Oversees all workflows' },
  { id: 'source_scout', name: 'Source Scout Bot', desc: 'Finds products from sources' },
  { id: 'deal_hunter', name: 'Deal Hunter Bot', desc: 'Identifies promising deals' },
  { id: 'product_normalizer', name: 'Product Normalizer Bot', desc: 'Standardizes product data' },
  { id: 'image_resolver', name: 'Image Resolver Bot', desc: 'Fetches and validates images' },
  { id: 'gemini_analyst', name: 'Gemini Analyst Bot', desc: 'Analyzes with Gemini API' },
  { id: 'deal_scorer', name: 'Deal Scorer Bot', desc: 'Scores opportunity value' },
  { id: 'content_review', name: 'Content Review Bot', desc: 'Generates product content' },
  { id: 'compliance_guard', name: 'Compliance Guard Bot', desc: 'Ensures safe content' },
  { id: 'link_health', name: 'Link Health Bot', desc: 'Checks affiliate links' },
  { id: 'product_cleanup', name: 'Product Cleanup Bot', desc: 'Archives broken products' },
  { id: 'content_package', name: 'Content Package Bot', desc: 'Prepares multi-platform content' },
  { id: 'app_health', name: 'App Health Bot', desc: 'Monitors system status' },
];

export default function AIBotsPage() {
  const [status, setStatus] = useState<BotTeamStatus | null>(null);
  const [runs, setRuns] = useState<BotRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [runLoading, setRunLoading] = useState(false);

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
        setRuns(runsData.data || []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setLoading(false);
      }
    };

    loadData();
    const interval = setInterval(loadData, 30000);
    return () => clearInterval(interval);
  }, []);

  const handleRunBot = async (mode: string) => {
    try {
      setRunLoading(true);
      const res = await fetch('/api/ai-bots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode,
          source: 'all',
          limit: 10,
          costMode: 'safe_free',
        }),
      });

      if (!res.ok) {
        throw new Error('Failed to start bot run');
      }

      const runsRes = await fetch('/api/ai-bots/runs');
      const runsData = await runsRes.json();
      setRuns(runsData.data || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setRunLoading(false);
    }
  };

  if (loading) {
    return (
      <div className={styles.container}>
        <div className={styles.loading}>Initializing AI Command Center...</div>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <div className={styles.topbar}>
        <div>
          <h1 className={styles.pageTitle}>AI Command Center SanDeal</h1>
          <p className={styles.pageSubtitle}>Professional AI Bot Operations System</p>
        </div>
        <div className={styles.statusBadges}>
          {status && (
            <>
              <span className={`${styles.badge} ${styles.badgeSafe}`}>
                {status.safeMode ? '🔒' : ''} Safe Mode
              </span>
              <span className={`${styles.badge} ${status.freeOnly ? styles.badgeActive : styles.badgeInactive}`}>
                {status.freeOnly ? '✓' : '×'} Free Only
              </span>
              <span className={`${styles.badge} ${styles.badgeInactive}`}>
                × Auto Publish OFF
              </span>
            </>
          )}
        </div>
      </div>

      {error && (
        <div className={styles.alertError}>
          <strong>Error:</strong> {error}
        </div>
      )}

      {/* Mission Control */}
      {status && (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Mission Control</h2>
          <div className={styles.missionGrid}>
            <div className={styles.missionCard}>
              <div className={styles.missionLabel}>Mode</div>
              <div className={styles.missionValue}>
                {status.freeOnly ? 'Safe Free' : status.safeMode ? 'Smart Test' : 'Premium'}
              </div>
            </div>
            <div className={styles.missionCard}>
              <div className={styles.missionLabel}>Gemini Status</div>
              <div className={styles.missionValue}>
                {status.hasGeminiPrimaryToken ? '✓ Ready' : '✗ Not Set'}
              </div>
            </div>
            <div className={styles.missionCard}>
              <div className={styles.missionLabel}>AccessTrade Status</div>
              <div className={styles.missionValue}>
                {status.hasAccessTradePrimaryToken ? '✓ Ready' : '✗ Not Set'}
              </div>
            </div>
            <div className={styles.missionCard}>
              <div className={styles.missionLabel}>Products in Review</div>
              <div className={styles.missionValue}>{status.reviewProductCount}</div>
            </div>
            <div className={styles.missionCard}>
              <div className={styles.missionLabel}>Broken Links</div>
              <div className={styles.missionValue}>{status.brokenLinkCount}</div>
            </div>
            <div className={styles.missionCard}>
              <div className={styles.missionLabel}>Content Packages</div>
              <div className={styles.missionValue}>{status.contentPackageCount}</div>
            </div>
          </div>
        </section>
      )}

      {/* Run Workflow Panel */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Run Workflows</h2>
        <div className={styles.workflowGrid}>
          <button 
            className={`${styles.workflowBtn} ${runLoading ? styles.btnDisabled : ''}`}
            onClick={() => handleRunBot('source_scan')}
            disabled={runLoading}
          >
            Quét nguồn sản phẩm
          </button>
          <button 
            className={`${styles.workflowBtn} ${runLoading ? styles.btnDisabled : ''}`}
            onClick={() => handleRunBot('deal_hunt')}
            disabled={runLoading}
          >
            Tìm deal hot
          </button>
          <button 
            className={`${styles.workflowBtn} ${runLoading ? styles.btnDisabled : ''}`}
            onClick={() => handleRunBot('score_only')}
            disabled={runLoading}
          >
            Chấm điểm sản phẩm
          </button>
          <button 
            className={`${styles.workflowBtn} ${runLoading ? styles.btnDisabled : ''}`}
            onClick={() => handleRunBot('gemini_analysis')}
            disabled={runLoading}
          >
            Phân tích bằng Gemini
          </button>
          <button 
            className={`${styles.workflowBtn} ${runLoading ? styles.btnDisabled : ''}`}
            onClick={() => handleRunBot('content_review')}
            disabled={runLoading}
          >
            Tạo bài review
          </button>
          <button 
            className={`${styles.workflowBtn} ${runLoading ? styles.btnDisabled : ''}`}
            onClick={() => handleRunBot('link_health')}
            disabled={runLoading}
          >
            Kiểm tra link
          </button>
          <button 
            className={`${styles.workflowBtn} ${runLoading ? styles.btnDisabled : ''}`}
            onClick={() => handleRunBot('cleanup')}
            disabled={runLoading}
          >
            Dọn sản phẩm lỗi
          </button>
          <button 
            className={`${styles.workflowBtn} ${styles.workflowBtnPrimary} ${runLoading ? styles.btnDisabled : ''}`}
            onClick={() => handleRunBot('full_safe_run')}
            disabled={runLoading}
          >
            Chạy toàn bộ quy trình an toàn
          </button>
        </div>
      </section>

      {/* Bot Team Grid */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Bot Team</h2>
        <div className={styles.botGrid}>
          {BOTS.map(bot => (
            <div key={bot.id} className={styles.botCard}>
              <div className={styles.botName}>{bot.name}</div>
              <div className={styles.botDesc}>{bot.desc}</div>
              <div className={styles.botStatus}>
                <span className={`${styles.statusDot} ${styles.statusDotIdle}`}></span>
                <span className={styles.statusText}>Idle</span>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Recent Bot Runs */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Bot Run Logs</h2>
        {runs.length === 0 ? (
          <div className={styles.empty}>
            <p>No bot runs yet. Start a workflow above to begin operations.</p>
          </div>
        ) : (
          <div className={styles.runsTable}>
            <div className={styles.runsTableHeader}>
              <div className={styles.runsCol1}>Run ID</div>
              <div className={styles.runsCol2}>Mode</div>
              <div className={styles.runsCol3}>Status</div>
              <div className={styles.runsCol4}>Started</div>
              <div className={styles.runsCol5}>Stats</div>
            </div>
            {runs.slice(0, 20).map(run => (
              <div key={run.id} className={styles.runsTableRow}>
                <div className={styles.runsCol1}>{run.id.slice(0, 8)}</div>
                <div className={styles.runsCol2}>{run.mode}</div>
                <div className={styles.runsCol3}>
                  <span className={`${styles.statusBadge} ${styles[`status${run.status}`]}`}>
                    {run.status}
                  </span>
                </div>
                <div className={styles.runsCol4}>
                  {new Date(run.startedAt).toLocaleString('vi-VN')}
                </div>
                <div className={styles.runsCol5}>
                  {run.candidatesFound} found, {run.productsSaved} saved
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Product Inventory */}
      {status && (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Product Inventory</h2>
          <div className={styles.inventoryGrid}>
            <div className={styles.inventoryCard}>
              <div className={styles.inventoryNumber}>{status.productCount}</div>
              <div className={styles.inventoryLabel}>Total Products</div>
            </div>
            <div className={styles.inventoryCard}>
              <div className={styles.inventoryNumber}>{status.approvedProductCount}</div>
              <div className={styles.inventoryLabel}>Published</div>
            </div>
            <div className={styles.inventoryCard}>
              <div className={styles.inventoryNumber}>{status.reviewProductCount}</div>
              <div className={styles.inventoryLabel}>In Review</div>
            </div>
            <div className={styles.inventoryCard}>
              <div className={styles.inventoryNumber}>{status.brokenLinkCount}</div>
              <div className={styles.inventoryLabel}>Broken Links</div>
            </div>
          </div>
          <div className={styles.inventoryActions}>
            <Link href="/dashboard/products" className={styles.linkBtn}>
              View All Products →
            </Link>
            <Link href="/dashboard/token-vault" className={styles.linkBtn}>
              Token Vault →
            </Link>
          </div>
        </section>
      )}
    </div>
  );
}
