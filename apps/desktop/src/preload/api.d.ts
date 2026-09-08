export interface DbInfo {
  file: string; schemaVersion: number; autoVacuum: number; journalMode: string;
  tables: number; sqlite: string; node: string; pid: number;
}
export interface RelayedApi {
  query(op: 'ping'): Promise<{ pong: boolean; at: number }>;
  query(op: 'db.info'): Promise<DbInfo>;
  query(op: 'ports.live'): Promise<{ count: number }>;
}
declare global { interface Window { relayed: RelayedApi } }
