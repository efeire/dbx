export interface PrimaryKeyChange {
  schema: string;
  tableName: string;
  columns: string[];
  dropPreviousIndex?: boolean;
}

export interface KeySnapshot {
  name: string;
  columns: string[];
  enabled: boolean;
  validated: boolean;
  deferrable: boolean;
  initiallyDeferred: boolean;
  indexOwner: string | null;
  indexName: string | null;
}

export interface ConstraintChangePreview {
  statements: string[];
  revision: string;
  currentConstraint: KeySnapshot | null;
  affectedObjects: string[];
  recoveryStatements: string[];
}

export interface ConstraintChangeResult {
  success: boolean;
  steps: { sql: string; success: boolean; error: string | null }[];
  currentConstraint: KeySnapshot | null;
  refreshError: string | null;
  recoveryStatements: string[];
}
