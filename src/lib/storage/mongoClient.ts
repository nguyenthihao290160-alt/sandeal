import { createHash } from 'node:crypto';

import { MongoClient, type ClientSession, type Db } from 'mongodb';

import type { MongoStorageConfig } from './storageConfig';
import { storageError } from './storageErrors';

const SERVER_SELECTION_TIMEOUT_MS = 5_000;
const CONNECT_TIMEOUT_MS = 10_000;

interface MongoClientEntry {
  client?: MongoClient;
  connecting?: Promise<MongoClient>;
}

interface MongoClientState {
  entries: Map<string, MongoClientEntry>;
  closing?: Promise<void>;
  /**
   * Legacy fields are retained only so a hot-reloaded process can safely drain
   * a client created by the previous single-client implementation.
   */
  client?: MongoClient;
  connecting?: Promise<MongoClient>;
  legacyDrain?: Promise<void>;
}

export interface MongoConnection {
  getDatabase(config: MongoStorageConfig): Promise<Db>;
  startSession(config: MongoStorageConfig): Promise<ClientSession>;
  close(): Promise<void>;
}

const globalWithMongo = globalThis as typeof globalThis & {
  __sandealMongoClientState?: Partial<MongoClientState>;
};

const existingState = globalWithMongo.__sandealMongoClientState;
const state: MongoClientState = {
  ...existingState,
  entries: existingState?.entries instanceof Map
      ? existingState.entries
      : new Map<string, MongoClientEntry>(),
};
globalWithMongo.__sandealMongoClientState = state;

function serverMongoUri(): string {
  const uri = process.env.MONGODB_URI;
  if (uri === undefined || uri.trim() === '') {
    throw storageError('MONGO_URI_REQUIRED');
  }
  return uri.trim();
}

function mongoUriFingerprint(uri: string): string {
  return createHash('sha256')
      .update(uri, 'utf8')
      .digest('hex');
}

function resolveConnectionIdentity(
    config: MongoStorageConfig,
): { uri: string; fingerprint: string } {
  const uri = serverMongoUri();
  const fingerprint = mongoUriFingerprint(uri);

  if (
      config.connectionFingerprint
      && config.connectionFingerprint !== fingerprint
  ) {
    // The adapter configuration and the live process environment disagree.
    // Fail closed rather than silently connecting with stale credentials.
    throw storageError('MONGO_CONNECTION_FAILED');
  }

  return { uri, fingerprint };
}

async function drainLegacyClientState(): Promise<void> {
  if (state.legacyDrain) return state.legacyDrain;
  if (!state.client && !state.connecting) return;

  const legacyClient = state.client;
  const legacyConnecting = state.connecting;
  state.client = undefined;
  state.connecting = undefined;

  state.legacyDrain = (async () => {
    let client = legacyClient;
    if (!client && legacyConnecting) {
      client = await legacyConnecting.catch(() => undefined);
    }
    await client?.close().catch(() => undefined);
  })().finally(() => {
    state.legacyDrain = undefined;
  });

  return state.legacyDrain;
}

async function connectedClient(
    config: MongoStorageConfig,
): Promise<MongoClient> {
  await drainLegacyClientState();

  const { uri, fingerprint } = resolveConnectionIdentity(config);
  const existing = state.entries.get(fingerprint);
  if (existing?.client) return existing.client;
  if (existing?.connecting) return existing.connecting;

  let client: MongoClient;
  try {
    client = new MongoClient(uri, {
      serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS,
      connectTimeoutMS: CONNECT_TIMEOUT_MS,
      retryWrites: true,
    });
  } catch (error) {
    throw storageError('MONGO_CONNECTION_FAILED', error);
  }

  const entry: MongoClientEntry = {};
  const connecting = client.connect()
      .then(connected => {
        if (state.entries.get(fingerprint) === entry) {
          entry.client = connected;
          entry.connecting = undefined;
        }
        return connected;
      })
      .catch(async error => {
        if (state.entries.get(fingerprint) === entry) {
          state.entries.delete(fingerprint);
        }
        await client.close().catch(() => undefined);
        throw storageError('MONGO_CONNECTION_FAILED', error);
      });

  entry.connecting = connecting;
  state.entries.set(fingerprint, entry);
  return connecting;
}

async function closeMongoClientEntry(
    fingerprint: string,
    entry: MongoClientEntry,
): Promise<void> {
  if (state.entries.get(fingerprint) === entry) {
    state.entries.delete(fingerprint);
  }

  let client = entry.client;
  entry.client = undefined;
  const pending = entry.connecting;
  entry.connecting = undefined;

  if (!client && pending) {
    client = await pending.catch(() => undefined);
  }
  await client?.close().catch(() => undefined);
}

export const mongoConnection: MongoConnection = {
  async getDatabase(config) {
    return (await connectedClient(config)).db(config.database);
  },

  async startSession(config) {
    return (await connectedClient(config)).startSession();
  },

  async close() {
    if (state.closing) return state.closing;

    state.closing = (async () => {
      await drainLegacyClientState();

      const entries = [...state.entries.entries()];
      state.entries.clear();
      await Promise.all(entries.map(([fingerprint, entry]) =>
          closeMongoClientEntry(fingerprint, entry)));
    })().finally(() => {
      state.closing = undefined;
    });

    return state.closing;
  },
};

export async function closeMongoConnection(): Promise<void> {
  await mongoConnection.close();
}
