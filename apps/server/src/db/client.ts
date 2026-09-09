import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { env } from '../env.ts';
import type { DB } from './schema.ts';
// Side-effect import, and it must stay above the pool: registering pg's int8
// parser is what makes `ord` and `rev` arrive as numbers rather than strings.
// Without it the Kysely types are a lie and `next_ord + 1` concatenates.
import './types.ts';

export const pool = new pg.Pool({ connectionString: env.databaseUrl, max: 10 });
export const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
