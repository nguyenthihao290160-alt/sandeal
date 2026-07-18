import { assertIsolatedDatabase, MigrationExecutionError } from './migrationExecutor';

export interface MongoAcceptanceEnvironment {
  readonly SANDEAL_MONGO_INTEGRATION_TEST?: string;
  readonly SANDEAL_STORAGE_DRIVER?: string;
  readonly MONGODB_URI?: string;
  readonly MONGODB_DATABASE?: string;
  readonly SANDEAL_ALLOW_ISOLATED_MONGO_WRITE?: string;
}

export interface MongoAcceptanceSafetyResult {
  readonly status: 'READY_FOR_ISOLATED_CHECK' | 'NOT_RUN';
  readonly ready: boolean;
  readonly database: string | null;
  readonly uriConfigured: boolean;
  readonly userConfirmed: boolean;
  readonly requiresEmptyTargetCheck: true;
  readonly blockers: string[];
  readonly realIsolatedMongoAcceptance: 'NOT_RUN';
}

function uriLooksMongo(value: string | undefined): boolean {
  if (!value || value.trim() === '') return false;
  try {
    const parsed = new URL(value.trim());
    return (parsed.protocol === 'mongodb:' || parsed.protocol === 'mongodb+srv:') && parsed.hostname !== '';
  } catch {
    return false;
  }
}

export function evaluateMongoAcceptanceSafety(
  environment: MongoAcceptanceEnvironment,
  userConfirmed: boolean
): MongoAcceptanceSafetyResult {
  const database = environment.MONGODB_DATABASE?.trim() || null;
  const uriConfigured = uriLooksMongo(environment.MONGODB_URI);
  const blockers: string[] = [];
  if (environment.SANDEAL_MONGO_INTEGRATION_TEST !== 'true') blockers.push('INTEGRATION_TEST_OPT_IN_REQUIRED');
  if (environment.SANDEAL_STORAGE_DRIVER !== 'mongo') blockers.push('MONGO_DRIVER_OPT_IN_REQUIRED');
  if (!uriConfigured) blockers.push('MONGO_URI_REQUIRED_OR_INVALID');
  if (!database) {
    blockers.push('MONGO_DATABASE_REQUIRED');
  } else {
    try {
      assertIsolatedDatabase(database);
    } catch (error) {
      blockers.push(error instanceof MigrationExecutionError ? error.code : 'MONGO_DATABASE_NOT_ISOLATED');
    }
  }
  if (environment.SANDEAL_ALLOW_ISOLATED_MONGO_WRITE !== 'true') blockers.push('ISOLATED_WRITE_OPT_IN_REQUIRED');
  if (!userConfirmed) blockers.push('USER_CONFIRMATION_REQUIRED');
  blockers.sort();
  return {
    status: blockers.length === 0 ? 'READY_FOR_ISOLATED_CHECK' : 'NOT_RUN',
    ready: blockers.length === 0,
    database,
    uriConfigured,
    userConfirmed,
    requiresEmptyTargetCheck: true,
    blockers,
    // This validator never connects. Runtime acceptance remains a separate explicit action.
    realIsolatedMongoAcceptance: 'NOT_RUN',
  };
}

