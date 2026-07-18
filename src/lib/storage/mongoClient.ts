import { MongoClient, type ClientSession, type Db } from 'mongodb';

import type { MongoStorageConfig } from './storageConfig';
import { storageError } from './storageErrors';

const SERVER_SELECTION_TIMEOUT_MS = 5_000;
const CONNECT_TIMEOUT_MS = 10_000;

interface MongoClientState {
  client?: MongoClient;
  connecting?: Promise<MongoClient>;
}

export interface MongoConnection {
  getDatabase(config: MongoStorageConfig): Promise<Db>;
  startSession(config: MongoStorageConfig): Promise<ClientSession>;
  close(): Promise<void>;
}

const globalWithMongo = globalThis as typeof globalThis & {
  __sandealMongoClientState?: MongoClientState;
};

const state = globalWithMongo.__sandealMongoClientState ?? {};
globalWithMongo.__sandealMongoClientState = state;

function serverMongoUri(): string {
  const uri = process.env.MONGODB_URI;
  if (uri === undefined || uri.trim() === '') throw storageError('MONGO_URI_REQUIRED');
  return uri.trim();
}

async function connectedClient(): Promise<MongoClient> {
  if (state.client) return state.client;
  if (state.connecting) return state.connecting;

  let client: MongoClient;
  try {
    client = new MongoClient(serverMongoUri(), {
      serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS,
      connectTimeoutMS: CONNECT_TIMEOUT_MS,
      retryWrites: true,
    });
  } catch (error) {
    throw storageError('MONGO_CONNECTION_FAILED', error);
  }

  state.connecting = client.connect()
    .then(connected => {
      state.client = connected;
      state.connecting = undefined;
      return connected;
    })
    .catch(async error => {
      state.connecting = undefined;
      await client.close().catch(() => undefined);
      throw storageError('MONGO_CONNECTION_FAILED', error);
    });

  return state.connecting;
}

export const mongoConnection: MongoConnection = {
  async getDatabase(config) {
    return (await connectedClient()).db(config.database);
  },

  async startSession() {
    return (await connectedClient()).startSession();
  },

  async close() {
    const pending = state.connecting;
    let client = state.client;
    state.client = undefined;
    state.connecting = undefined;
    if (!client && pending) client = await pending.catch(() => undefined);
    if (client) await client.close();
    if (state.client === client) state.client = undefined;
  },
};

export async function closeMongoConnection(): Promise<void> {
  await mongoConnection.close();
}
