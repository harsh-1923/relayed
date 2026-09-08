import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { env } from '../env.ts';
import type { DB } from './schema.ts';

export const pool = new pg.Pool({ connectionString: env.databaseUrl, max: 10 });
export const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
