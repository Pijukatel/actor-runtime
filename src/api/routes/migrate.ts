/**
 * `POST /actor-runtime/migrate/:runId` - triggers an emulated migration of one run
 * (`requirements/api.md`, "Migration emulation"). In the local-runtime-only namespace because the real
 * platform has no migrate API.
 */
import type { Router } from 'express';

import { requireUser } from '../auth.js';
import { sendData } from '../envelope.js';
import { invalidRequest, jobAlreadyFinished, recordNotFound } from '../errors.js';
import { h } from '../handler.js';
import { isTerminalJobStatus } from '../../services/job-status.js';
import { getOwnedRun } from '../../services/runs.js';
import { migrateRun } from '../../services/migrations.js';
import { runDto } from '../dto/actors.js';
import type { ApiServerDeps } from '../server.js';

export function mountMigrate(router: Router, deps: ApiServerDeps): void {
	router.post(
		'/migrate/:runId',
		h(async (req, res) => {
			const user = requireUser(req);
			const run = await getOwnedRun(user.id, req.params.runId as string);
			if (!run) throw recordNotFound();
			if (isTerminalJobStatus(run.status)) throw jobAlreadyFinished();

			const result = await migrateRun(deps.driver, run);
			if (result === 'not-running') {
				// Non-terminal but without a container to migrate (READY, ABORTING).
				throw invalidRequest(`Only a RUNNING run can be migrated (current status: ${run.status})`);
			}

			// Read back after the migration started, like abort/reboot return the post-write record.
			const current = await getOwnedRun(user.id, run.id);
			sendData(res, runDto(current ?? run));
		}),
	);
}
