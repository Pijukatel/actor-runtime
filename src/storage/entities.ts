/** Domain record shapes stored in the `__*__` internal registries (see `storage.md`). */

export type StorageType = 'dataset' | 'keyValueStore' | 'requestQueue';

export interface StorageRecord {
	id: string;
	type: StorageType;
	userId: string;
	/** Human-facing name; distinct from the Crawlee storage name, which is always `id`. */
	name?: string;
	createdAt: string;
	modifiedAt: string;
	accessedAt: string;
}

/**
 * One record per token, created ad-hoc by `services/users.ts: getOrCreateUserForToken()` on the first
 * request that ever carries a given token (`cli.md`'s User bootstrap) - there is no startup-created
 * default user any more. `id`/`username` are the user's real identity outright, not an overlay on some
 * other fixed internal id: for a token that resolves against the real platform they are that account's
 * actual `id`/`username`; otherwise they are the fabricated `local-user-{n}` / `0000000000000000{n}`
 * pair. Every ownership filter (`actor.userId`, `run.userId`, ...) is keyed off `id` directly. Plain
 * per storage.md - no display-preference/overlay fields.
 */
export interface UserRecord {
	id: string;
	username: string;
	token: string;
	createdAt: string;
	/** Real Apify Proxy password for this account, harvested from the upstream `/v2/users/me` response
	 * at creation time when the token resolved against the real platform (see
	 * `services/identity-resolution.ts`). Absent for a fabricated user, or a real one whose upstream
	 * response carried none. */
	proxyPassword?: string;
}

export type SourceType = 'SOURCE_FILES';

export interface SourceFile {
	name: string;
	format: 'TEXT' | 'BASE64';
	content: string;
	/** Only for a symlink in a pushed monorepo repository; `content` is then empty. */
	linkTarget?: string;
}

/**
 * An Actor's input schema, exactly as it was pushed. A loose record rather than a modelled type: it is
 * the developer's own document, handed to the platform's validator verbatim, and the runtime itself
 * reads only `properties`/`required` out of it.
 */
export interface InputSchema {
	[key: string]: unknown;
	properties?: Record<string, unknown>;
	required?: string[];
}

export interface ActorEnvVarRecord {
	name: string;
	/** For a secret, the sealed value (`services/secrets.ts`); plain text otherwise. */
	value: string;
	isSecret?: boolean;
	/** A secret's AES key, encrypted with the Actor's public key. Never returned by the API. */
	encryptedAes256Password?: string;
}

/** PEM-encoded, the private key protected by `passphrase`; created with the Actor and never returned by
 * the API. */
export interface ActorSecretKeys {
	publicKey: string;
	privateKey: string;
	passphrase: string;
}

/** Shown in the build log only, never used to fetch anything. */
export interface LocalSourceContextGit {
	remoteUrl?: string;
	branch?: string;
	commit?: string;
	dirty?: boolean;
}

/** A monorepo Actor's pushed repository; its files are in `__FILES__` under `fileId`. */
export interface LocalSourceContext {
	fileId: string;
	/** The Actor's folder in the repository. */
	actorPath: string;
	fileCount: number;
	sizeBytes: number;
	uploadedAt: string;
	git?: LocalSourceContextGit;
}

export interface ActorVersionRecord {
	versionNumber: string;
	buildTag: string;
	sourceType: SourceType;
	sourceFiles: SourceFile[];
	envVars?: ActorEnvVarRecord[];
	/** Passes `envVars`, secrets included, to the image build as Docker build arguments. */
	applyEnvVarsToBuild?: boolean;
	/** When set, builds use it instead of `sourceFiles`. Never exposed on `/v2`. */
	localSourceContext?: LocalSourceContext;
}

/** Caller-facing language selector for the debug toggle. `'auto'` resolves from the built image at run
 * start; `'node'`/`'python'` is an explicit override. */
export type DebugLanguagePreference = 'auto' | 'node' | 'python';
/** A run's actually-resolved debug language - never `'auto'`. */
export type DebugLanguage = 'node' | 'python';

/** The per-Actor debug toggle (`actor-driver.md`'s "Debug mode" section). Set or cleared only through
 * `services/debug-mode.ts: setDebugMode`. */
export interface ActorLocalDebug {
	language: DebugLanguagePreference;
	/** Explicit port override; absent means "use the resolved language's default port at run start". */
	port?: number;
}

/** The per-Actor browser-view toggle. Set or cleared only through `services/browser-view.ts: setBrowserView`. */
export interface ActorLocalBrowserView {
	/** `true` delivers the viewer's mouse/keyboard input to the display; `false` is view-only. */
	interactive: boolean;
}

/** The platform's `pricingModel` enum in full; only `FREE` and `PAY_PER_EVENT` are ever accepted here. */
export type ActorPricingModel = 'FREE' | 'FLAT_PRICE_PER_MONTH' | 'PRICE_PER_DATASET_ITEM' | 'PAY_PER_EVENT';

/** A chargeable event as the Actor stores it: exactly one of `eventPriceUsd`/`eventTieredPricingUsd`. */
export interface ActorChargeEventRecord {
	eventTitle: string;
	eventDescription: string;
	eventPriceUsd?: number;
	eventTieredPricingUsd?: Record<string, { tieredEventPriceUsd: number }>;
	isOneTimeEvent?: boolean;
	isPrimaryEvent?: boolean;
}

/** Always normalized by `services/pricing.ts` before it lands here, so it can go out on `/v2` verbatim. */
export interface ActorPricingInfoRecord {
	pricingModel: ActorPricingModel;
	createdAt: string;
	startedAt: string;
	apifyMarginPercentage: number;
	reasonForChange?: string;
	pricingPerEvent?: { actorChargeEvents: Record<string, ActorChargeEventRecord> };
}

/** One run's pricing: tiered prices already collapsed to the tier's own `eventPriceUsd`, the shape the
 * SDKs expect on the run object. */
export interface RunPricingInfoRecord {
	pricingModel: ActorPricingModel;
	createdAt: string;
	startedAt: string;
	apifyMarginPercentage: number;
	pricingPerEvent?: {
		actorChargeEvents: Record<
			string,
			{
				eventTitle: string;
				eventDescription: string;
				eventPriceUsd: number;
				isOneTimeEvent?: boolean;
				isPrimaryEvent?: boolean;
			}
		>;
	};
}

/** The platform's `actorStandby` Actor field, single-tenant only (`services/standby-config.ts`). */
export interface ActorStandbyRecord {
	isEnabled: boolean;
	disableStandbyFieldsOverride: boolean;
	tenancy: 'SINGLE_TENANT';
	desiredRequestsPerActorRun: number;
	maxRequestsPerActorRun: number;
	idleTimeoutSecs: number;
	build: string;
	memoryMbytes: number;
	shouldPassActorInput: boolean;
}

export interface ActorRecord {
	id: string;
	userId: string;
	name: string;
	title?: string;
	createdAt: string;
	modifiedAt: string;
	versions: ActorVersionRecord[];
	/** The Actor's pricing history (`actor-driver.md`). Unlike the `local*` fields below, it is exposed
	 * on `/v2`. Absent or empty means the Actor is free. */
	pricingInfos?: ActorPricingInfoRecord[];
	/** Exposed on `/v2`; absent until the Actor is first given one. */
	actorStandby?: ActorStandbyRecord;
	/** tag -> latest successful build for that tag; `apify push` polls this after a build. */
	taggedBuilds: Record<string, { buildId: string; buildNumber: string }>;
	/** Host path bind-mounted over the image's working directory at run start (`actor-driver.md`). Set or
	 * cleared only through `services/dev-folder.ts: setDevFolder` - via a direct registry write that
	 * deliberately bypasses `updateActor`, so registering/clearing never bumps `modifiedAt` (which, unlike
	 * this field, *is* exposed on `/v2`). Never touched by any other Actor write. Optional and never
	 * exposed on `/v2` itself either (`dto/actors.ts: actorDto` is explicit field-by-field). */
	localDevFolder?: string;
	/** Live dev folder toggle; absent means off. Same `modifiedAt`/`/v2` rules as `localDevFolder`. */
	localDevFolderEnabled?: true;
	/** The per-Actor debug-mode toggle (`actor-driver.md`'s "Debug mode" section). Absent means off.
	 * Same `modifiedAt`-preserving, never-`/v2`-exposed pattern as `localDevFolder` above. */
	localDebug?: ActorLocalDebug;
	/** Browser-view toggle; absent means off. Same `modifiedAt`/`/v2` rules as `localDevFolder`. */
	localBrowserView?: ActorLocalBrowserView;
	/** Encrypts and decrypts this Actor's secrets (`services/secrets.ts`). Absent only on an Actor stored
	 * before Actors got one on creation, until its next write or run - which never bumps `modifiedAt`. */
	secretKeys?: ActorSecretKeys;
}

export type JobStatus = 'READY' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'ABORTING' | 'ABORTED' | 'TIMED-OUT';

/** Matches the real platform's `RUN_GENERAL_ACCESS` enum (public `@apify/consts`) - `FOLLOW_USER_SETTING`
 * is the default a freshly-started run gets, matched here in `services/runs.ts`. */
export type RunGeneralAccess = 'FOLLOW_USER_SETTING' | 'RESTRICTED' | 'ANYONE_WITH_ID_CAN_READ';

export interface BuildRecord {
	id: string;
	userId: string;
	actorId: string;
	versionNumber: string;
	buildNumber: string;
	tag: string;
	status: JobStatus;
	startedAt: string;
	finishedAt?: string;
	imageId?: string;
	/** This build's own image's `Config.WorkingDir`, captured right after the build succeeds
	 * (`docker-driver.ts`'s `inspectWorkingDirectory`) and written in the same status-transition write
	 * that records `SUCCEEDED` (`services/builds.ts`). Build-specific, not Actor-specific: a run derives
	 * its dev-folder mount target from *this build's own* value (`services/runs.ts`), never from some
	 * other tag's most-recently-built image - the human-directed fix for the cross-tag staleness a
	 * single Actor-level field could not avoid (a differently-tagged, more-recently-built image could
	 * silently overwrite the value a same-run, different-tag mount was built from). Unset when the
	 * inspect failed or the working directory was empty/`/` (mounting over `/` would destroy the
	 * container) - never present on a non-`SUCCEEDED` build. */
	imageWorkingDirectory?: string;
	/** The input schema this build's own source files declared, written with `SUCCEEDED` like
	 * `imageWorkingDirectory` above, and build-specific for the same reason: a run validates against the
	 * schema of the build it resolved, never another tag's more recently pushed one. Absent when the
	 * Actor declares none - such a run takes its input exactly as the caller sent it. */
	inputSchema?: InputSchema;
	/** The memory fields this build's `.actor/actor.json` declared, build-specific like `inputSchema`.
	 * Absent when it declares none. */
	memorySettings?: ActorMemorySettings;
	exitCode?: number;
	statusMessage?: string;
}

/** `.actor/actor.json`'s run-memory fields; `defaultMemoryMbytes` may be a memory expression. */
export interface ActorMemorySettings {
	defaultMemoryMbytes?: string | number;
	minMemoryMbytes?: number;
	maxMemoryMbytes?: number;
}

export interface RunRecord {
	id: string;
	userId: string;
	actorId: string;
	buildId: string;
	buildNumber: string;
	status: JobStatus;
	startedAt: string;
	finishedAt?: string;
	defaultDatasetId: string;
	defaultKeyValueStoreId: string;
	defaultRequestQueueId: string;
	options: {
		memoryMbytes: number;
		/** `0` means no timeout - only a standby run has none. */
		timeoutSecs: number;
		/** Which build tag or build number this run used - the real platform's `options.build`
		 * (the public API's `ActorRunOptions.build`). Optional here (unlike the always-populated real
		 * platform field) purely so pre-existing directly-seeded test fixtures keep compiling without
		 * change; `startRun` always sets it for real runs, and `runDto` backfills `'latest'` for any
		 * record that predates this field. */
		build?: string;
		/** In MB - the real platform's `options.diskMbytes`, required by the Apify API contract
		 * (`apify-client`'s `RunOptions` pydantic model has no
		 * default). Optional here for the same test-fixture-compatibility reason as `build`; `startRun`
		 * always sets it for real runs, and `runDto` backfills a sensible default when absent. */
		diskMbytes?: number;
		/** Absent means no cap. */
		maxTotalChargeUsd?: number;
	};
	exitCode?: number;
	statusMessage?: string;
	/** Set by the Actor (or the runtime) to say `statusMessage` is the run's final word. */
	isStatusMessageTerminal?: boolean;
	/** The runtime's own reason for ending the run, which the Actor's later messages must not hide. */
	isStatusMessageFromRuntime?: boolean;
	meta: { origin: string };
	/** When the run was last resurrected (`services/runs.ts: resurrectRun`); absent until then. The
	 * timeout budget and the current incarnation's duration count from here, `startedAt` staying the
	 * original as on the platform. Never on `/v2`. */
	resurrectedAt?: string;
	/** The platform's restart-bookkeeping subset of `Run.stats`; locally only `migrationCount`,
	 * `rebootCount` and `resurrectCount` ever move. Optional for pre-existing test fixtures; `runDto`
	 * backfills zeros. */
	stats?: {
		migrationCount?: number;
		rebootCount?: number;
		restartCount?: number;
		resurrectCount?: number;
		inputBodyLen?: number;
		/** What the run had consumed before its last resurrection, so the time it spent finished is not
		 * billed as run time. Never on `/v2`; `durationMillis` there already includes it. */
		durationMillisBeforeResurrect?: number;
		/** The run's final resource figures, written when it ends. While it is live the equivalent figures
		 * are the events channel's live accumulators, which is what `runDto` reads instead. */
		memAvgBytes?: number;
		memMaxBytes?: number;
		memCurrentBytes?: number;
		cpuAvgUsage?: number;
		cpuMaxUsage?: number;
		cpuCurrentUsage?: number;
	};
	/** Resolved at run creation and never rewritten, so an Actor's later pricing change cannot reprice a
	 * run that already exists. Absent for a run of an Actor with no pricing. */
	pricingInfo?: RunPricingInfoRecord;
	/** Charges so far, keyed by event name; present only on a pay-per-event run. */
	chargedEventCounts?: Record<string, number>;
	/** When the run first reached `options.maxTotalChargeUsd`; set once (`services/charging.ts`). */
	chargingStoppedAt?: string;
	/** Required by the real Apify API contract (`Run.generalAccess`) but optional here for the same
	 * test-fixture-compatibility reason as `options.build`/`options.diskMbytes` above; `startRun` always
	 * sets it for real runs (`FOLLOW_USER_SETTING`, the platform's run-creation default), and `runDto`
	 * backfills the same default when absent. */
	generalAccess?: RunGeneralAccess;
	/** This run's resolved debug plan, written before the container starts. Absent for non-debug runs
	 * and for a debug run that failed before resolving. Top-level (not nested under `options`) to stay
	 * out of the emulated `/v2` run object automatically. */
	localDebug?: { language: DebugLanguage; port: number };
	/** Written once the run's sidecar is up: where its VNC server listens on `apify-local`. Absent when the
	 * toggle is off or the sidecar failed to start. Never on `/v2`, like `localDebug`. */
	localBrowserView?: { interactive: boolean; vncHost: string; vncPort: number };
}
