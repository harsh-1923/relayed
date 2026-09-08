# Postgres init

`*.sql` files here run **once**, when the data directory is first created.
They do not re-run on restart — `pnpm stack:reset` is required to replay them.

Intentionally empty for now. The server schema is not written yet, and when it
is it belongs in a real migration runner, not here. Reserve this directory for
things that must exist before migrations run (extensions, roles), not for the
schema itself.
