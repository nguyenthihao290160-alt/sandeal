export interface RollbackReadinessInput {
  readonly configuredDriver: string | undefined;
  readonly fileReachable: boolean;
  readonly snapshotSourceChecksum: string;
  readonly currentSourceChecksum: string;
  readonly mongoWriteDetectedAfterSnapshot: boolean;
}

export interface RollbackReadiness {
  readonly fileConfigured: boolean;
  readonly fileReachable: boolean;
  readonly sourceChecksumMatches: boolean;
  readonly mongoWriteDetectedAfterSnapshot: boolean;
  readonly rollbackSafe: boolean;
  readonly blockers: string[];
}

export function evaluateRollbackReadiness(input: RollbackReadinessInput): RollbackReadiness {
  const fileConfigured = input.configuredDriver === undefined || input.configuredDriver.trim() === 'file';
  const sourceChecksumMatches = input.snapshotSourceChecksum !== ''
    && input.snapshotSourceChecksum === input.currentSourceChecksum;
  const blockers = [
    ...(!fileConfigured ? ['FILE_DRIVER_NOT_CONFIGURED'] : []),
    ...(!input.fileReachable ? ['FILE_STORAGE_UNREACHABLE'] : []),
    ...(!sourceChecksumMatches ? ['FILE_SOURCE_CHECKSUM_CHANGED'] : []),
    ...(input.mongoWriteDetectedAfterSnapshot ? ['MONGO_WRITES_AFTER_FILE_SNAPSHOT'] : []),
  ].sort();
  return {
    fileConfigured,
    fileReachable: input.fileReachable,
    sourceChecksumMatches,
    mongoWriteDetectedAfterSnapshot: input.mongoWriteDetectedAfterSnapshot,
    rollbackSafe: blockers.length === 0,
    blockers,
  };
}

