/** Run lifecycle endpoints plus build/run lookup and logs. */
import { resolveUser } from '../auth.js';
import { TERMINAL_STATUSES } from '../constants.js';
import { data, notFound, readBody, response, textResponse } from '../http.js';
import { boundedInt } from '../pagination.js';
import { buildDict, runDict } from '../serializers.js';

// Logs are dynamic and must never be cached. no-store also opts these
// responses out of the browser's same-URL cache lock, which would otherwise
// queue a re-opened log view behind a still-open (never-ending, for a warm
// standby run) earlier stream to the same URL and render it empty forever.
const LOG_NO_STORE = [['cache-control', 'no-store']];

const STREAM_POLL_MS = 250;

function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

/** Start-run lives under the actor prefixes (/v2/acts + /v2/actors). */
export function registerActorRunRoutes(router, prefix) {
    router.add('POST', `${prefix}/:actorId/runs`, async (ctx, { actorId }) => {
        const svc = ctx.service;
        const user = await resolveUser(ctx);
        const actor = svc.getActor(actorId, user);
        if (!actor) return notFound(`Actor '${actorId}' was not found.`);
        const raw = await readBody(ctx);
        let runInput = {};
        if (raw.length) {
            try {
                runInput = JSON.parse(raw.toString('utf8'));
            } catch {
                runInput = {};
            }
        }
        // Validate every query param BEFORE starting the run so a bad value
        // returns a 400 without spawning a run. memory/timeout must be
        // positive integers (a zero/negative memory would otherwise silently
        // disable the container memory cap); waitForFinish may be 0.
        const options = {
            build: ctx.query.get('build') || 'latest',
            memoryMbytes: boundedInt(ctx.query, 'memory', 1024, 1, "Query parameter 'memory' must be positive."),
            timeoutSecs: boundedInt(ctx.query, 'timeout', 300, 1, "Query parameter 'timeout' must be positive."),
        };
        const waitSecs = Math.min(
            boundedInt(ctx.query, 'waitForFinish', 0, 0, "Query parameter 'waitForFinish' must not be negative."),
            60,
        );

        let run = await svc.startRun(actorId, runInput, options);

        let deadline = waitSecs;
        while (deadline > 0) {
            const current = svc.getRun(run.id);
            if (TERMINAL_STATUSES.has(current.status)) {
                run = current;
                break;
            }
            await sleep(500);
            deadline -= 0.5;
        }
        run = svc.getRun(run.id);
        return data(runDict(run), 201);
    });

    router.add('GET', `${prefix}/:actorId/runs`, async (ctx, { actorId }) => {
        const svc = ctx.service;
        const user = await resolveUser(ctx);
        const items = svc.listRuns(actorId, user).map(runDict);
        return data({ total: items.length, count: items.length, items });
    });
}

export function registerFlatRunRoutes(router) {
    router.add('GET', '/v2/actor-runs/:runId', async (ctx, { runId }) => {
        const user = await resolveUser(ctx);
        const run = ctx.service.getRun(runId, user);
        if (!run) return notFound(`Run '${runId}' was not found.`);
        return data(runDict(run));
    });

    router.add('POST', '/v2/actor-runs/:runId/abort', async (ctx, { runId }) => {
        const user = await resolveUser(ctx);
        const run = await ctx.service.abortRun(runId, user);
        if (!run) return notFound(`Run '${runId}' was not found.`);
        return data(runDict(run));
    });

    router.add('POST', '/v2/actor-builds/:buildId/abort', async (ctx, { buildId }) => {
        const user = await resolveUser(ctx);
        const build = ctx.service.abortBuild(buildId, user);
        if (!build) return notFound(`Build '${buildId}' was not found.`);
        return data(buildDict(build));
    });

    router.add('GET', '/v2/actor-builds/:buildId', async (ctx, { buildId }) => {
        const user = await resolveUser(ctx);
        const build = ctx.service.getBuild(buildId, user);
        if (!build) return notFound(`Build '${buildId}' was not found.`);
        return data(buildDict(build));
    });

    router.add('GET', '/v2/logs/:jobId', async (ctx, { jobId }) => {
        const svc = ctx.service;
        const user = await resolveUser(ctx);
        const build = svc.getBuild(jobId, user);
        if (build) return textResponse(build.log ?? '', 200, LOG_NO_STORE);
        const run = svc.getRun(jobId, user);
        if (run) {
            // A warm standby run's log lives only in its container until
            // teardown persists it; fetch it live so the log is not empty
            // while RUNNING.
            const live = await svc.standby.liveContainerLog(run);
            if (live !== null) return textResponse(live, 200, LOG_NO_STORE);
            return textResponse(run.log ?? '', 200, LOG_NO_STORE);
        }
        return textResponse('', 404);
    });

    router.add('GET', '/v2/logs/:jobId/stream', async (ctx, { jobId }) => {
        const svc = ctx.service;
        const user = await resolveUser(ctx);

        // Resolve the job's kind once up front (a build and a run never share
        // an id): this doubles as the unknown / cross-user 404 guard exactly
        // like the one-shot endpoint, and lets each poll tick below re-fetch
        // only the relevant object.
        const isBuild = svc.getBuild(jobId, user) !== null;
        if (!isBuild && svc.getRun(jobId, user) === null) {
            return textResponse('', 404);
        }

        const statusAndLog = () => {
            const job = isBuild ? svc.getBuild(jobId, user) : svc.getRun(jobId, user);
            if (!job) return { terminal: true, stored: '' };
            return { terminal: TERMINAL_STATUSES.has(job.status), stored: job.log ?? '' };
        };

        const liveStandbyLog = async () => {
            if (isBuild) return null;
            const run = svc.getRun(jobId, user);
            if (!run) return null;
            return svc.standby.liveContainerLog(run);
        };

        async function* tail() {
            let offset = 0;
            for (;;) {
                let buffer = svc.readLogBuffer(jobId);
                if (buffer === null) {
                    // Standby runs never create a live buffer; their
                    // in-container log grows monotonically and teardown
                    // persists that same text (plus a trailing note), so the
                    // offset stays consistent when the terminal drain below
                    // switches to the stored log.
                    buffer = await liveStandbyLog();
                }
                if (buffer !== null && buffer.length > offset) {
                    yield buffer.slice(offset);
                    offset = buffer.length;
                }
                const { terminal, stored } = statusAndLog();
                if (terminal) {
                    // Final drain: emit anything appended to the buffer since
                    // the last read, then any stored-log tail (e.g. a
                    // post-run import error the live stream never carried),
                    // so a client tailing right at the finish still receives
                    // the end of the log before the stream closes.
                    const finalBuffer = svc.readLogBuffer(jobId);
                    if (finalBuffer !== null && finalBuffer.length > offset) {
                        yield finalBuffer.slice(offset);
                        offset = finalBuffer.length;
                    }
                    if (stored.length > offset) {
                        yield stored.slice(offset);
                    }
                    return;
                }
                await sleep(STREAM_POLL_MS);
            }
        }

        return response({
            status: 200,
            headers: [['content-type', 'text/plain; charset=utf-8'], ...LOG_NO_STORE],
            stream: tail(),
        });
    });
}
