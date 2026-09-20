// What the current build is, and the oldest one still allowed to run
// (docs/RELEASE.md §1 — the nag is the whole update mechanism until signing and
// auto-update land together).
//
// UNAUTHENTICATED, DELIBERATELY. A client that is too old to be allowed in may
// also be too old to authenticate, and the answer is public either way: a
// version number and a download link say nothing a downloader could not read
// off the releases page.
//
// CONFIGURED, NOT COMPILED. Cutting a release should not require editing this
// file — `railway variable set RELAYED_LATEST_VERSION=0.0.2` is the whole
// operation, and raising the floor after a bad build is the same one command.
import type { FastifyInstance } from 'fastify';

export interface VersionAnswer {
  /** The newest build there is. A client below it is offered an update. */
  latest: string;
  /**
   * The oldest build still allowed to run. A client below it is REFUSED, and
   * the client makes that unusable rather than merely loud.
   *
   * Defaults to `0.0.0`, which nothing is below — so the forcing half stays off
   * until somebody deliberately raises it. A floor that defaulted to `latest`
   * would lock every user out of an app that was working a moment ago, on the
   * first deploy that forgot to set it.
   */
  minimum: string;
  /** Where to get it. Shown by the client rather than fetched by it. */
  url: string;
}

export const versionAnswer = (env: NodeJS.ProcessEnv = process.env): VersionAnswer => ({
  latest: env['RELAYED_LATEST_VERSION'] ?? '0.0.0',
  minimum: env['RELAYED_MINIMUM_VERSION'] ?? '0.0.0',
  url: env['RELAYED_DOWNLOAD_URL'] ?? 'https://github.com/harsh-1923/relayed/releases/latest',
});

export async function versionRoutes(app: FastifyInstance): Promise<void> {
  app.get('/version', async () => versionAnswer());
}
