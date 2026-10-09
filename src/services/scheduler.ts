/**
 * Runs schedules (`api.md`'s "Schedules"), after apify-core's `SchedulesManager.invokeSchedule` and its
 * scheduling daemons: every enabled schedule has a timer for its `nextRunAt`; when it fires, each action
 * starts its run (skipped while the action's previous run is still going, for an exclusive schedule), the
 * outcome goes to the schedule's log, and the next run time is computed. A run time that passed while the
 * runtime was not running is made up once at start, as the platform re-enqueues an overdue schedule.
 */
import { CONTAINER_API_BASE_URL } from '../config.js';
import type { Driver } from '../driver/types.js';
import type {
	ActorRecord,
	RunMeta,
	ScheduleAction,
	ScheduleLogMessage,
	ScheduleRecord,
	UserRecord,
} from '../storage/entities.js';
import { KeyedMutex } from '../storage/mutex.js';
import { getRegistries } from '../storage/registries.js';
import { getOwnedActor } from './actors.js';
import { resolveTaggedBuild } from './builds.js';
import { defaultRunOptionsOf } from './default-run-options.js';
import { resolveBuildInput, type ActorInput } from './input-schema.js';
import { isTerminalJobStatus } from './job-status.js';
import { listOwnedRuns, startRun } from './runs.js';
import { MAX_LOG_MESSAGES, nextRunAtOf } from './schedules.js';
import { standbyUrl } from './standby-config.js';
import { getOwnedTask } from './tasks.js';
import { getUserById, resolveProxyPassword } from './users.js';

/** `setTimeout` overflows past this; a longer wait is re-armed when it elapses. */
const MAX_TIMER_DELAY_MILLIS = 2 ** 31 - 1;

export interface SchedulerOptions {
	driver: Driver;
}

let options: SchedulerOptions | undefined;
let unsubscribe: (() => void) | undefined;
const timers = new Map<string, NodeJS.Timeout>();
const inFlight = new Set<Promise<void>>();
/** One invocation of a schedule at a time, so a timer and a manual invoke never interleave their writes. */
const invokeLocks = new KeyedMutex();

/** Subscribes to schedule writes and arms a timer for every enabled schedule. */
export async function startScheduler(schedulerOptions: SchedulerOptions): Promise<void> {
	options = schedulerOptions;
	const registries = getRegistries();
	unsubscribe = registries.schedules.onChange((_previous, next) => arm(next));
	for (const schedule of await registries.schedules.list()) arm(schedule);
}

function arm(schedule: ScheduleRecord | null): void {
	if (!schedule) return;
	clearTimeout(timers.get(schedule.id));
	timers.delete(schedule.id);
	if (!schedule.isEnabled || !schedule.nextRunAt) return;
	const delay = Date.parse(schedule.nextRunAt) - Date.now();
	const timer = setTimeout(
		() => {
			timers.delete(schedule.id);
			const firing = fire(schedule.id)
				.catch((error: unknown) => console.error(`Schedule ${schedule.id} failed:`, error))
				.finally(() => inFlight.delete(firing));
			inFlight.add(firing);
		},
		Math.max(0, Math.min(delay, MAX_TIMER_DELAY_MILLIS)),
	);
	timer.unref();
	timers.set(schedule.id, timer);
}

/** A timer's turn: the schedule as it is now decides whether it is due, since it may have been edited. */
async function fire(scheduleId: string): Promise<void> {
	await invokeLocks.run(scheduleId, async () => {
		const schedule = await getRegistries().schedules.get(scheduleId);
		if (!schedule || !schedule.isEnabled || !schedule.nextRunAt) return;
		if (Date.parse(schedule.nextRunAt) > Date.now()) {
			arm(schedule);
			return;
		}
		const scheduledAt = schedule.nextRunAt;
		const { logs, startedAt } = await invokeSchedule(schedule, { scheduledAt });
		await getRegistries().schedules.update(scheduleId, (current) => {
			if (!current) return null;
			const next = { ...current, lastRunAt: startedAt.toISOString(), log: appendLogs(current.log, logs) };
			return { ...next, nextRunAt: nextRunAtOf(next, new Date()) };
		});
	});
}

function appendLogs(log: ScheduleLogMessage[], added: ScheduleLogMessage[]): ScheduleLogMessage[] {
	return [...log, ...added].slice(-MAX_LOG_MESSAGES);
}

/** `POST /v2/schedules/:scheduleId/invoke`: runs the actions now and logs it; the schedule's own run times
 * are unaffected, as on the platform. */
export async function invokeScheduleManually(schedule: ScheduleRecord): Promise<void> {
	await invokeLocks.run(schedule.id, async () => {
		const { logs } = await invokeSchedule(schedule, { manual: true });
		await getRegistries().schedules.update(schedule.id, (current) =>
			current ? { ...current, log: appendLogs(current.log, logs) } : null,
		);
	});
}

interface InvokeOptions {
	manual?: boolean;
	/** The run time the invocation is for; now, for a manual one. */
	scheduledAt?: string;
}

async function invokeSchedule(
	schedule: ScheduleRecord,
	invoke: InvokeOptions,
): Promise<{ logs: ScheduleLogMessage[]; startedAt: Date }> {
	if (!options) throw new Error('Scheduler not started');
	const startedAt = new Date();
	const logs: ScheduleLogMessage[] = [];
	const addLog = (level: ScheduleLogMessage['level'], message: string) =>
		logs.push({ message, level, createdAt: new Date().toISOString() });

	const user = await getUserById(schedule.userId);
	if (!user) {
		addLog('ERROR', 'Cannot invoke schedule because its user was not found.');
		return { logs, startedAt };
	}
	const scheduledAt = invoke.scheduledAt ?? startedAt.toISOString();
	for (const action of schedule.actions) {
		const label = action.type === 'RUN_ACTOR' ? `Actor "${action.actorId}"` : `Actor task "${action.actorTaskId}"`;
		if (schedule.isExclusive && (await hasUnfinishedRun(schedule.userId, action))) {
			addLog('WARNING', `Skipping ${label}, it must be exclusive but previous run is still running`);
			continue;
		}
		try {
			await startActionRun(options.driver, user, schedule, action, scheduledAt);
		} catch (error) {
			addLog('ERROR', `Cannot start ${label}: ${(error as Error).message || 'Unknown error'}`);
		}
	}
	addLog('INFO', invoke.manual ? 'Schedule invoked manually' : 'Schedule invoked');
	return { logs, startedAt };
}

/** The platform's exclusivity check: a run of this very action that has not finished (an aborting one
 * counts as finished, as on the platform). */
async function hasUnfinishedRun(userId: string, action: ScheduleAction): Promise<boolean> {
	const runs = await listOwnedRuns(userId);
	return runs.some(
		(run) =>
			!isTerminalJobStatus(run.status) &&
			run.status !== 'ABORTING' &&
			(action.type === 'RUN_ACTOR'
				? run.meta.scheduledAct2Id === action.id
				: run.meta.scheduledActorTaskId === action.id),
	);
}

/** What an action resolves to before its run starts: the task's saved options, or the action's own. */
interface RunOptions {
	build?: string;
	timeoutSecs?: number;
	memoryMbytes?: number;
	maxTotalChargeUsd?: number;
	restartOnError?: boolean;
	actorTaskId?: string;
}

function jsonInput(value: Record<string, unknown>): ActorInput {
	return { body: Buffer.from(JSON.stringify(value), 'utf8'), contentType: 'application/json' };
}

/** Starts one action's run the way its API endpoint would, with the platform's scheduler `meta`. */
async function startActionRun(
	driver: Driver,
	user: UserRecord,
	schedule: ScheduleRecord,
	action: ScheduleAction,
	scheduledAt: string,
): Promise<void> {
	let actor: ActorRecord | null;
	let input: ActorInput | undefined;
	let runOptions: RunOptions;
	let actionMeta: Omit<RunMeta, 'origin'>;
	if (action.type === 'RUN_ACTOR') {
		actor = await getOwnedActor(schedule.userId, action.actorId);
		if (!actor) throw new Error('Actor was not found');
		input = action.runInput
			? { body: Buffer.from(action.runInput.body, 'utf8'), contentType: action.runInput.contentType }
			: undefined;
		runOptions = { ...action.runOptions };
		actionMeta = { scheduleId: schedule.id, scheduledAct2Id: action.id, scheduledAt };
	} else {
		const task = await getOwnedTask(schedule.userId, action.actorTaskId);
		if (!task) throw new Error('Actor task was not found');
		actor = await getOwnedActor(schedule.userId, task.actorId);
		if (!actor) throw new Error('Actor was not found');
		// As `POST /v2/actor-tasks/:actorTaskId/runs`: the action's input over the task's, key by key.
		input = task.input || action.input ? jsonInput({ ...task.input, ...action.input }) : undefined;
		const { build, timeoutSecs, memoryMbytes, maxTotalChargeUsd, restartOnError } = task.options ?? {};
		runOptions = { build, timeoutSecs, memoryMbytes, maxTotalChargeUsd, restartOnError, actorTaskId: task.id };
		actionMeta = { scheduleId: schedule.id, scheduledActorTaskId: action.id, scheduledAt };
	}

	const tag = runOptions.build ?? defaultRunOptionsOf(actor).build;
	const lookup = await resolveTaggedBuild(actor, tag);
	if (!lookup.found) throw new Error(`Actor has no build tagged "${tag}"`);
	const processed = resolveBuildInput(lookup.build, input);
	if (processed.kind !== 'ok') throw new Error(processed.message);

	await startRun(driver, actor, lookup.build, {
		input: processed.input,
		memoryMbytes: runOptions.memoryMbytes,
		timeoutSecs: runOptions.timeoutSecs,
		maxTotalChargeUsd: runOptions.maxTotalChargeUsd,
		restartOnError: runOptions.restartOnError,
		build: tag,
		...(runOptions.actorTaskId ? { actorTaskId: runOptions.actorTaskId } : {}),
		origin: 'SCHEDULER',
		scheduleMeta: actionMeta,
		standbyUrl: standbyUrl(actor, user.username),
		proxyPassword: resolveProxyPassword(user),
		apiBaseUrl: CONTAINER_API_BASE_URL,
		token: user.token,
	});
}

/** Test-only: stops the scheduler and waits for whatever it was doing. */
export async function stopSchedulerForTests(): Promise<void> {
	unsubscribe?.();
	unsubscribe = undefined;
	for (const timer of timers.values()) clearTimeout(timer);
	timers.clear();
	await Promise.all([...inFlight]);
	for (const timer of timers.values()) clearTimeout(timer);
	timers.clear();
	options = undefined;
}
