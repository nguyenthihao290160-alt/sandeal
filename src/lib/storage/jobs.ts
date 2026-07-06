// ===========================================
// Jobs / Scheduler Storage
// ===========================================

import type { Job, JobStatus } from '../types';
import { readCollection, writeCollection, findById, generateId } from './adapter';

const COLLECTION = 'jobs';

export async function getAllJobs(): Promise<Job[]> {
  return readCollection<Job>(COLLECTION);
}

export async function getJobById(id: string): Promise<Job | null> {
  return findById<Job>(COLLECTION, id);
}

export async function createJob(data: Omit<Job, 'id' | 'createdAt' | 'updatedAt' | 'logs'>): Promise<Job> {
  const items = await readCollection<Job>(COLLECTION);
  const job: Job = {
    ...data,
    id: generateId(),
    logs: [`[${new Date().toISOString()}] Tạo job`],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  items.push(job);
  await writeCollection(COLLECTION, items);
  return job;
}

export async function updateJobStatus(id: string, status: JobStatus, message?: string): Promise<Job | null> {
  const items = await readCollection<Job>(COLLECTION);
  const index = items.findIndex(j => j.id === id);
  if (index === -1) return null;

  items[index].status = status;
  items[index].updatedAt = new Date().toISOString();
  if (message) {
    items[index].errorMessage = status === 'failed' ? message : undefined;
    items[index].logs.push(`[${new Date().toISOString()}] ${message}`);
  }
  await writeCollection(COLLECTION, items);
  return items[index];
}

export async function addJobLog(id: string, log: string): Promise<void> {
  const items = await readCollection<Job>(COLLECTION);
  const index = items.findIndex(j => j.id === id);
  if (index === -1) return;
  items[index].logs.push(`[${new Date().toISOString()}] ${log}`);
  await writeCollection(COLLECTION, items);
}

export async function getJobStats(): Promise<{
  total: number;
  scheduled: number;
  failed: number;
  published: number;
  waitingReview: number;
}> {
  const items = await readCollection<Job>(COLLECTION);
  return {
    total: items.length,
    scheduled: items.filter(j => j.status === 'scheduled').length,
    failed: items.filter(j => j.status === 'failed').length,
    published: items.filter(j => j.status === 'published').length,
    waitingReview: items.filter(j => j.status === 'waiting_review').length,
  };
}
