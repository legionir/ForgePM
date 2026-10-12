// FORBIDDEN sample for the ESLint raw-connection rule (acceptance §4).
// This file lives under tests/lint-fixtures/ which is excluded from `npm run lint`
// but included by the `lint:fixtures` test, which asserts eslint errors here.
// eslint-disable-next-line use-isomorphic-code
import { Pool } from 'pg';
import { Kysely } from 'kysely';
import { Queue } from 'bullmq';

export const pool = new Pool();
export const kysely = new Kysely({});
export const queue = new Queue('x', {});
