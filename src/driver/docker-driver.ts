/**
 * The Docker driver: build/run Actor images over the host Docker socket via `dockerode`. Every Actor
 * container joins the `apify-local` network so it can resolve the runtime's own container by the
 * fixed DNS alias `apify-api` (`actor-driver.md`). Storage access is HTTP-only; the only filesystem
 * bind mounts this driver ever adds are the optional local-dev-folder mount on a real run
 * (`RunContext.devMount`, see `startRun` below) - conditional, never unconditional, on every Actor's
 * container - and the read-only probe mount `probeDevFolder` creates to validate a candidate dev folder
 * before it is ever registered (see below), whose container is never started.
 *
 * `probeDevFolder`'s container is created against `ensureProbeImage`'s own minimal image, not any
 * Actor's build - registering a dev folder must work for an Actor that has never been built. That image
 * is a one-line `FROM scratch` Dockerfile built the same `buildImage`-plus-in-memory-tar way as an Actor
 * build, so it needs no network access; built lazily on first use and reused after that, never rebuilt
 * per registration.
 *
 * Genuine cancellation: `docker.buildImage()` accepts an `abortSignal` option that dockerode forwards
 * all the way to Node's `http.request({ signal })` (`docker-modem/lib/modem.js`: `optionsf.signal =
 * options.abortSignal`, then `http[...].request(opts, ...)` in `buildRequest`) - aborting it destroys
 * the in-flight HTTP request to the daemon, and `followProgress`'s stream then emits `error`/`close`
 * (`dockerode/lib/buildkit.js`'s `onStreamError`), so `startBuild`'s promise settles instead of hanging
 * or silently ignoring the abort. One `AbortController` is kept per in-flight build, keyed by build id,
 * so `abortBuild` can call `.abort()` on the live one. Runs have no HTTP request to abort and are
 * cancelled at the container instead (`abortRun`).
 *
 * Host architecture: a build runs for the host's own, except that one whose base image has no manifest
 * for it is retried once for `linux/amd64` under the engine's emulation (`build-platform.ts`).
 *
 * Engine neutrality: everything here goes through the Docker Engine API, which Podman also serves
 * (`podman system service` / the `podman.socket` unit), so the same driver runs Actors on Docker and on
 * Podman 3.4 or newer, rootful or rootless. Where the engines genuinely differ, the difference is handled
 * at the code that meets it: bind-mount sources Podman would auto-create (`probeDevFolder`,
 * `assertDevFolderStillPresent`); Podman's `system_cpu_usage` scale (`cpuUsageSnapshotOf`); how Actor
 * containers reach this API when this container is not on `apify-local` (`selfAttachToNetwork`,
 * `chooseDefaultNetworkRoute` - Podman 3.x never uses the network at all); resource limits a rootless
 * engine cannot apply (`detectResourceLimitSupport`); and the image names and volume options Podman 3.x
 * needs (`LOCAL_IMAGE_PREFIX`, `ensureBrowserViewerImage`, `buildDevMounts`, `startBrowserViewer`).
 * Without any reachable socket, `init()` finds `available: false` and every build/run fails fast with a
 * clear status message instead of hanging; the rest of the runtime (storages, actors-as-records,
 * console) is unaffected.
 */
import { PassThrough } from 'node:stream';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import * as os from 'node:os';
import { createServer } from 'node:net';
import * as path from 'node:path';
import Docker from 'dockerode';
import * as tar from 'tar-stream';

import {
	API_PORT,
	CONTAINER_API_ALIAS,
	browserViewerRootfsTarPath,
	browserViewerVersionFilePath,
	debugpyPayloadTarPath,
	debugpyVersionFilePath,
} from '../config.js';
import { CPU_PERIOD_US, cpuQuotaFor, dedicatedCpusFor } from '../resources.js';
import { normalizeEntryName } from './tar-entry-name.js';
import {
	COMPATIBILITY_BUILD_PLATFORM,
	compatibilityBuildNotice,
	isMissingManifestForBuildPlatform,
} from './build-platform.js';
import { formatRuntimeLog } from '../runtime-log.js';
import type { SourceFile } from '../storage/entities.js';
import {
	DebugPortInUseError,
	DriverTimedOutError,
	type AbortRunOptions,
	type BrowserViewerHandle,
	type BrowserViewerTarget,
	type BuildContext,
	type BuildOutcome,
	type ContainerServerAddress,
	type DevFolderMount,
	type DevFolderProbeFailureReason,
	type DevFolderProbeOutcome,
	type Driver,
	type InspectedDebugTarget,
	type RunContext,
	type RunOutcome,
	type RunResourceSample,
} from './types.js';

const NETWORK_NAME = 'apify-local';

/**
 * Prefix for the images this driver builds or imports for its own use and later looks up BY NAME (the
 * browser-view sidecar, the dev-folder probe). A bare `actor-runtime/...` is a short name: Docker and
 * Podman 4 resolve it to the local image, but Podman 3.x resolves short names only through its search
 * registries and reports the locally stored `localhost/actor-runtime/...` as "image not known". Naming
 * the image `localhost/...` outright is what every engine stores it as anyway. Actor images need no
 * prefix: they are always referenced by image id.
 */
const LOCAL_IMAGE_PREFIX = 'localhost/';

/** The names an engine gives the host in every container's hosts file: Podman (3.3+) the first, Docker
 * Desktop the second (Docker Engine adds neither). */
const ENGINE_HOST_NAMES = ['host.containers.internal', 'host.docker.internal'];

/**
 * The address Actor containers can reach the host at, read from this process's own hosts file (this
 * container got it from the same engine, on the same default network, as every Actor container will).
 * Falls back to the engine keyword `host-gateway` (Docker 20.10+, Podman 4.1+) when the file has no such
 * entry - on Docker Engine, or when this process runs outside a container.
 */
export async function hostAddressSeenFromContainers(hostsFile: string): Promise<string> {
	return (await engineHostEntry(hostsFile)) ?? 'host-gateway';
}

async function engineHostEntry(hostsFile: string): Promise<string | undefined> {
	const content = await readFile(hostsFile, 'utf8').catch(() => '');
	for (const line of content.split('\n')) {
		const fields = line.split('#')[0]!.trim().split(/\s+/);
		if (fields.length >= 2 && fields.slice(1).some((name) => ENGINE_HOST_NAMES.includes(name))) return fields[0]!;
	}
	return undefined;
}

/** What this process can learn about its own container's network from the inside, with no engine call. */
export interface OwnNetworkView {
	/** Address the engine hands containers for the host (`hostAddressSeenFromContainers`), or undefined for `host-gateway`. */
	hostAddress: string | undefined;
	/** This container's default gateway, from `/proc/net/route`. */
	gateway: string | undefined;
	/** This container's first non-loopback IPv4 address and the interface it sits on. */
	own: { address: string; iface: string } | undefined;
}

/** How an Actor container on the engine's DEFAULT network reaches this API (`actorsOnDefaultNetwork`). */
export interface DefaultNetworkRoute {
	/** `ExtraHosts` entry for `apify-api`. */
	extraHost: string;
	/** Engine network mode the Actor container needs for that entry to work, if any. */
	networkMode?: string;
}

const SLIRP4NETNS_GATEWAY = '10.0.2.2';
const SLIRP4NETNS_INTERFACE = 'tap0';
/** Podman's user-mode network with the host's loopback reachable at the gateway - Actors under rootless
 * Podman before 4.0 need it, where the engine's own host entry IS that gateway and is otherwise blocked. */
const SLIRP4NETNS_HOST_LOOPBACK_MODE = 'slirp4netns:allow_host_loopback=true';

/**
 * Picks the route for Actor containers on the engine's default network. The engine's own host entry is
 * the default. Two cases where that entry is this container's gateway need more: under slirp4netns the
 * gateway only reaches the host's loopback when the Actor is started with `allow_host_loopback`
 * (rootless Podman 3.x points `host.containers.internal` there); on a rootful bridge every Actor shares
 * this container's bridge, so this container's own address is a direct route with no port-forward hop.
 */
export function chooseDefaultNetworkRoute(view: OwnNetworkView): DefaultNetworkRoute {
	const { hostAddress, gateway, own } = view;
	if (hostAddress && gateway && hostAddress === gateway) {
		if (own?.iface === SLIRP4NETNS_INTERFACE || gateway === SLIRP4NETNS_GATEWAY) {
			return { extraHost: `${CONTAINER_API_ALIAS}:${gateway}`, networkMode: SLIRP4NETNS_HOST_LOOPBACK_MODE };
		}
		if (own) return { extraHost: `${CONTAINER_API_ALIAS}:${own.address}` };
	}
	return { extraHost: `${CONTAINER_API_ALIAS}:${hostAddress ?? 'host-gateway'}` };
}

/** The default gateway from a Linux `/proc/net/route` (little-endian hex), or undefined. */
export function defaultGatewayFromRouteTable(routeTable: string): string | undefined {
	for (const line of routeTable.split('\n').slice(1)) {
		const [, destination, gateway] = line.trim().split(/\s+/);
		if (destination !== '00000000' || !gateway || gateway.length !== 8) continue;
		const bytes = gateway.match(/../g)!.map((hex) => parseInt(hex, 16));
		return bytes.reverse().join('.');
	}
	return undefined;
}

function firstNonLoopbackIpv4(interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>): OwnNetworkView['own'] {
	for (const [iface, infos] of Object.entries(interfaces)) {
		const info = infos?.find((i) => i.family === 'IPv4' && !i.internal);
		if (info) return { address: info.address, iface };
	}
	return undefined;
}

/** Which per-container resource limits the engine can actually apply for the user it runs as. */
export interface ResourceLimitSupport {
	cpu: boolean;
	memory: boolean;
}

const ALL_LIMITS_SUPPORTED: ResourceLimitSupport = { cpu: true, memory: true };

/**
 * Docker applies (or silently drops) whatever limits it is handed. Rootless Podman on cgroups v2 instead
 * refuses to START a container whose limit needs a cgroup controller systemd did not delegate to the
 * user - Ubuntu 22.04 delegates `memory` and `pids` but not `cpu`, so every run with a CPU quota died
 * at start. Podman's own (non-Docker) info endpoint lists the controllers it can use; a limit whose
 * controller is missing is left out, and `init` says so once. Anything unexpected keeps every limit.
 */
/** The engine behind the Docker API, as far as this driver needs to know: Podman's major version, or
 * undefined for Docker (and for anything that does not identify itself). */
export async function podmanMajorVersion(docker: Docker): Promise<number | undefined> {
	try {
		const version = (await docker.version()) as { Components?: Array<{ Name: string; Version?: string }> };
		const podman = version.Components?.find((component) => component.Name === 'Podman Engine');
		const major = podman?.Version ? Number.parseInt(podman.Version, 10) : Number.NaN;
		return Number.isNaN(major) ? undefined : major;
	} catch {
		return undefined;
	}
}

export async function detectResourceLimitSupport(docker: Docker): Promise<ResourceLimitSupport> {
	try {
		const version = (await docker.version()) as { Components?: Array<{ Name: string }> };
		if (!version.Components?.some((component) => component.Name === 'Podman Engine')) return ALL_LIMITS_SUPPORTED;
		const info = await new Promise<{ host?: { cgroupControllers?: unknown } }>((resolve, reject) => {
			docker.modem.dial(
				{ path: '/v4.0.0/libpod/info', method: 'GET', statusCodes: { 200: true, 500: 'server error' } },
				(error: Error | null, data: unknown) =>
					error ? reject(error) : resolve(data as { host?: { cgroupControllers?: unknown } }),
			);
		});
		const controllers = info.host?.cgroupControllers;
		if (!Array.isArray(controllers)) return ALL_LIMITS_SUPPORTED;
		return { cpu: controllers.includes('cpu'), memory: controllers.includes('memory') };
	} catch {
		return ALL_LIMITS_SUPPORTED;
	}
}

function devNodeModulesVolumeName(runId: string): string {
	return `${DEV_NODE_MODULES_VOLUME_PREFIX}${runId}`;
}

/** Where a hidden command token's file sits in the image, or `undefined` if the mount cannot hide it.
 * Resolved rather than matched on spelling: Apify's Playwright images write the same entrypoint both
 * relative (`./xvfb-entrypoint.sh`) and absolute (`/home/myuser/...`). */
function entryHiddenByDevMount(
	token: string,
	imageWorkingDirectory: string,
): { inImage: string; relative: string } | undefined {
	// No path component at all: `PATH` decides, never the working directory.
	if (!token.startsWith('/') && !token.includes('/')) return undefined;
	const inImage = path.posix.resolve(imageWorkingDirectory, token);
	const relative = path.posix.relative(imageWorkingDirectory, inImage);
	if (relative === '' || relative === '..' || relative.startsWith('../')) return undefined;
	return { inImage, relative };
}

function readStream(stream: NodeJS.ReadableStream): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		stream.on('data', (chunk: Buffer) => chunks.push(chunk));
		stream.once('error', reject);
		stream.once('end', () => resolve(Buffer.concat(chunks)));
	});
}

/** Re-packs the single-file archive `getArchive` returns so its entries land under `directory` when
 * extracted at `/`, with an explicit directory entry so no engine has to invent the parent. */
async function repackUnderDirectory(archive: Buffer, directory: string): Promise<Buffer> {
	const dir = directory.replace(/^\/+/, '');
	const pack = tar.pack();
	const extract = tar.extract();
	const packed = readStream(pack);
	pack.entry({ name: dir, type: 'directory', mode: 0o755 });
	await new Promise<void>((resolve, reject) => {
		extract.on('entry', (header, content, next) => {
			const entry = pack.entry({ ...header, name: `${dir}/${header.name}` }, (error) => {
				if (error) reject(error);
				else next();
			});
			content.pipe(entry);
		});
		extract.once('error', reject);
		extract.once('finish', resolve);
		extract.end(archive);
	});
	pack.finalize();
	return packed;
}

/** A container's address on `network`, else on whatever network it does have. */
function containerAddress(info: Docker.ContainerInspectInfo, network: string | undefined): string | undefined {
	const networks = info.NetworkSettings?.Networks ?? {};
	const preferred = network ? networks[network]?.IPAddress : undefined;
	return (
		preferred ||
		Object.values(networks).find((n) => n.IPAddress)?.IPAddress ||
		info.NetworkSettings?.IPAddress ||
		undefined
	);
}
const RUN_LABEL = 'actor-runtime.runId';
/** Marks a create-only dev-folder-probe container (`probeDevFolder` below) so `reconcileOrphans` can
 * sweep one that outlived its own removal call. */
const PROBE_LABEL = 'actor-runtime.devFolderProbe';
/** Target path for the probe container's mount - arbitrary, since the probe is never started and
 * nothing ever reads from it. */
const PROBE_MOUNT_TARGET = '/probe';
/** On the browser-view sidecar container and its volume, so `reconcileOrphans` can sweep leftovers. */
const BROWSER_VIEWER_LABEL = 'actor-runtime.browserViewer';
/** Tagged with the payload's content hash, so a rebuilt runtime imports a fresh image. */
const BROWSER_VIEWER_IMAGE_REPO = `${LOCAL_IMAGE_PREFIX}actor-runtime/browser-viewer`;
/** Shared between the Actor container and the sidecar through a tmpfs volume. */
const X11_SOCKET_DIR = '/tmp/.X11-unix';
/** Name prefix of the per-run `node_modules` volume of a `devMount` run (`buildDevMounts`); the run id
 * follows. Named, not anonymous, because Podman 3.x refuses a volume mount without a source ("must set
 * source volume"). Removed with the run, and swept by this prefix after a restart. */
const DEV_NODE_MODULES_VOLUME_PREFIX = 'actor-runtime-node-modules-';
/** Where a `devMount` run keeps the image's own copy of an entrypoint file the bind mount would hide
 * (`preserveHiddenEntrypoint`). */
const PRESERVED_ENTRYPOINT_DIR = '/apify-runtime-entrypoint';

/** The image command a `devMount` run starts through instead of its own, plus the tar that puts the
 * preserved file in place before the container starts. */
interface PreservedEntrypoint {
	field: 'Entrypoint' | 'Cmd';
	command: string[];
	/** The image's own `Cmd`, restated whenever `Entrypoint` is overridden: an engine drops the image's
	 * `Cmd` from a create request that sets `Entrypoint` (Docker and Podman alike), which would have run
	 * the Xvfb wrapper with no program to wrap. */
	cmd?: string[];
	tar: Buffer;
}
/** Reachable only on `apify-local`; never published on the host. */
const BROWSER_VIEWER_VNC_PORT = 5900;
const BROWSER_VIEWER_MEMORY_BYTES = 256 * 1024 * 1024;
const BROWSER_VIEWER_SCRIPT = '/apify-browser-viewer.sh';
/** Names must match `docker/browser-viewer.sh`. */
const BROWSER_VIEWER_INTERACTIVE_ENV = 'APIFY_BROWSER_VIEWER_INTERACTIVE';
const BROWSER_VIEWER_PORT_ENV = 'APIFY_BROWSER_VIEWER_PORT';
/** Removing a volume right after its last container can race the daemon ("volume is in use"). */
const VOLUME_REMOVE_ATTEMPTS = 10;
const VOLUME_REMOVE_RETRY_MS = 200;
/** Tag for `ensureProbeImage`'s own minimal image - built and owned by this driver, never an Actor's.
 * An explicit `:probe` suffix, deliberately never `latest` (Docker's own implicit default for an
 * untagged name) - this image has nothing to do with an Actor's `latest`-tagged build, and an untagged
 * name would silently print as `...probe:latest` and invite exactly that confusion. */
const PROBE_IMAGE_TAG = `${LOCAL_IMAGE_PREFIX}actor-runtime/dev-folder-probe:probe`;
/**
 * `FROM scratch` with nothing else would build fine but fails every `createContainer` against it with
 * HTTP 400 "no command specified" (moby refuses to create a container for an image with no `Cmd`/
 * `Entrypoint`) - which would look exactly like a bad candidate path if left undiagnosed. `CMD` fixes
 * that; the command itself is never exec'd, since `probeDevFolder`'s container is created but never
 * started. Verified empirically against real Docker and Podman daemons: builds and creates with no
 * network access.
 */
const PROBE_DOCKERFILE = 'FROM scratch\nCMD ["/nonexistent"]\n';
/** The host path the probe container binds read-only at `PROBE_MOUNT_TARGET`: the host's root, so the
 * mount source always exists and the daemon never has to validate (or, on Podman, auto-create - see
 * `probeDevFolder`) the candidate path itself. */
const PROBE_MOUNT_SOURCE = '/';
/** Response header of `HEAD /containers/{id}/archive?path=...` - base64 JSON of moby's
 * `ContainerPathStat` (`name`, `size`, `mode`, `mtime`, `linkTarget`), identical on Podman. */
const PATH_STAT_HEADER = 'x-docker-container-path-stat';
/** Go `os.FileMode` type bits, as serialized into the stat header's `mode`. `GO_MODE_DIR` is bit 31, so a
 * JS bitwise AND against it yields a negative int32 for a directory - non-zero, which is all the checks
 * below need. */
const GO_MODE_DIR = 0x80000000;
const GO_MODE_SYMLINK = 0x08000000;
/** Bounds `probeDevFolder`'s manual symlink following - a longer chain is reported `unknown`. */
const MAX_SYMLINK_HOPS = 16;
/** Docker daemon rejection substrings for "host port already bound" - covers both the classic and
 * newer moby wording. */
const PORT_IN_USE_SUBSTRINGS = ['port is already allocated', 'address already in use'];

/** Per-run CPU/memory sampling cadence - decided, not tunable via env in this PR. A single module
 * constant, so it is trivially adjustable later if per-second `stats()` calls against the daemon (up to
 * one per concurrently running Actor, `system.md`'s scale budget) ever prove too much load. */
const SAMPLE_INTERVAL_MS = 1000;
/** Bounds `stop()`'s wait on the in-flight `stats()` call. The daemon client is built without a request
 * timeout, so an unanswered call would otherwise hold a run's finalization open forever; a call that
 * outlives this grace is abandoned, and `stopped` suppresses its result. Mirrors `LOG_DRAIN_GRACE_MS`. */
const SAMPLER_STOP_GRACE_MS = 5000;

/** Host capacity, snapshotted once at `init()`. Absent means "unknown", never "zero". */
interface HostCapacity {
	ncpu: number;
	memTotalBytes: number;
}

/** Narrows an unknown rejection to the shape `docker-modem` attaches to a daemon HTTP-level error
 * response (`Modem.prototype.buildPayload`: `msg.statusCode = res.statusCode`) - present only when the
 * daemon actually answered; a raw transport failure (socket refused/missing) carries no `statusCode` at
 * all, which is exactly the distinction `classifyProbeError`'s first branch depends on. */
function hasStatusCode(error: unknown): error is Error & { statusCode: number } {
	return (
		typeof error === 'object' &&
		error !== null &&
		'statusCode' in error &&
		typeof (error as { statusCode: unknown }).statusCode === 'number'
	);
}

/** Classifies a `createContainer` rejection from `probeDevFolder` - see `DevFolderProbeFailureReason`'s
 * doc comment in `driver/types.ts`. The probe's mount source is always `/`, so a create rejection is
 * never about the candidate path: it is either the daemon being gone or the probe image being gone. */
function classifyProbeCreateError(error: unknown): DevFolderProbeFailureReason {
	if (!hasStatusCode(error)) return 'unreachable';
	if (error.statusCode === 404) return 'image-missing';
	return 'unknown';
}

/** One parsed `PATH_STAT_HEADER`. `linkTarget` is only meaningful when `mode` carries `GO_MODE_SYMLINK`. */
interface ProbeStat {
	mode: number;
	linkTarget: string;
}

type ProbeStatOutcome = { ok: true; stat: ProbeStat } | { ok: false; reason: DevFolderProbeFailureReason };

/** Classifies an `infoArchive` (`HEAD .../archive`) rejection: the daemon answers 404 for a path that
 * does not exist under the probe mount - the one case allowed to say "does not exist". Anything else the
 * daemon answered is "could not verify" (a permission problem, a Docker Desktop file-sharing denial); no
 * answer at all is `unreachable`. */
function classifyProbeStatError(error: unknown): DevFolderProbeFailureReason {
	if (!hasStatusCode(error)) return 'unreachable';
	if (error.statusCode === 404) return 'not-found';
	return 'unknown';
}

/** Reads `PATH_STAT_HEADER` off the response `container.infoArchive` resolves with (dockerode hands back
 * the raw `http.IncomingMessage` for this `HEAD` call). A response without a parseable header is
 * `unknown`, never a guess. */
function parseProbeStatResponse(response: unknown): ProbeStatOutcome {
	const headers = (response as { headers?: Record<string, string | string[] | undefined> } | undefined)?.headers;
	const raw = headers?.[PATH_STAT_HEADER];
	const encoded = Array.isArray(raw) ? raw[0] : raw;
	if (!encoded) return { ok: false, reason: 'unknown' };
	try {
		const parsed = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as {
			mode?: unknown;
			linkTarget?: unknown;
		};
		if (typeof parsed.mode !== 'number') return { ok: false, reason: 'unknown' };
		return {
			ok: true,
			stat: { mode: parsed.mode, linkTarget: typeof parsed.linkTarget === 'string' ? parsed.linkTarget : '' },
		};
	} catch {
		return { ok: false, reason: 'unknown' };
	}
}

/** Stats one path inside the (never-started) probe container, through the daemon's own archive-stat
 * endpoint - the same resolution `docker cp` uses, which both Docker and Podman perform on a stopped
 * container's bind mounts too. */
async function statInProbe(container: Docker.Container, containerPath: string): Promise<ProbeStatOutcome> {
	let response: unknown;
	try {
		response = await container.infoArchive({ path: containerPath });
	} catch (error) {
		return { ok: false, reason: classifyProbeStatError(error) };
	}
	// A `HEAD` response has no body, but the socket is only released once the message is consumed.
	(response as { resume?: () => void } | undefined)?.resume?.();
	return parseProbeStatResponse(response);
}

/** A TCP port that is free in this process's own network namespace right now - bound on loopback and
 * released again, for a sidecar about to share that namespace (`startBrowserViewer`). */
async function allocateFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			server.close(() => {
				if (address && typeof address === 'object') resolve(address.port);
				else reject(new Error('Could not allocate a free port'));
			});
		});
	});
}

/**
 * A standby container's env inside this process's network namespace: its server on `port`, and the API
 * on loopback, since `apify-api` is not in the hosts file a joined namespace shares.
 */
export function sharedNetnsEnv(env: Record<string, string>, port: number): Record<string, string> {
	const shared: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		shared[key] = value.replace(`://${CONTAINER_API_ALIAS}:`, '://127.0.0.1:');
	}
	shared.ACTOR_STANDBY_PORT = String(port);
	shared.ACTOR_WEB_SERVER_PORT = String(port);
	return shared;
}

/**
 * Maps the `linkTarget` a symlink stat reports back to a host path. Docker resolves a link's target in
 * the scope of the container's root filesystem and reports that absolute container path: a target that
 * landed under the probe mount is reported with the `PROBE_MOUNT_TARGET` prefix (a relative link, or an
 * absolute one pointing back inside), while a host-absolute target that escaped the mount is reported
 * verbatim - which, since the mount source is the host's `/`, is already the host path. Podman follows
 * symlinks itself before answering, so this never runs there.
 */
function hostPathOfLinkTarget(linkTarget: string): string {
	if (linkTarget === PROBE_MOUNT_TARGET) return '/';
	if (linkTarget.startsWith(`${PROBE_MOUNT_TARGET}/`)) return linkTarget.slice(PROBE_MOUNT_TARGET.length);
	return linkTarget;
}

/** True when a `container.start()` rejection means the host debug port is already bound. */
function isPortInUseError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return PORT_IN_USE_SUBSTRINGS.some((substring) => message.includes(substring));
}

function sourceFileToBuffer(file: SourceFile): Buffer {
	return file.format === 'BASE64' ? Buffer.from(file.content, 'base64') : Buffer.from(file.content, 'utf8');
}

/** The platform's builder gives every file in the Docker context these permission bits, whatever the source
 * had, so a script is executable in a build there even without `+x`. */
const DOCKER_FILE_MODE = 0o777;

function buildTarball(sourceFiles: SourceFile[]): NodeJS.ReadableStream {
	const pack = tar.pack();
	for (const file of sourceFiles) {
		const name = normalizeEntryName(file.name);
		if (file.linkTarget !== undefined) pack.entry({ name, type: 'symlink', linkname: file.linkTarget });
		else pack.entry({ name, mode: DOCKER_FILE_MODE }, sourceFileToBuffer(file));
	}
	pack.finalize();
	return pack;
}

/** An in-memory tar containing only a `Dockerfile` - the same `buildImage`-plus-tar-stream path an Actor
 * build uses (`buildTarball` above), reused here to build `ensureProbeImage`'s own image. */
function dockerfileTarball(contents: string): NodeJS.ReadableStream {
	const pack = tar.pack();
	pack.entry({ name: 'Dockerfile' }, Buffer.from(contents, 'utf8'));
	pack.finalize();
	return pack;
}

/** What the sampler diffs between two of its own successive samples: the container's cumulative CPU time
 * (`cpu_stats.cpu_usage.total_usage`, nanoseconds on every daemon) and when the daemon read it. */
interface CpuUsageSnapshot {
	totalUsageNs: number;
	readAtMs: number;
}

/**
 * `memory_stats.usage` minus the reclaimable page cache, the same adjustment `docker stats`' MEM USAGE
 * column makes (cgroup v1 reports it as `total_inactive_file`, v2 as `inactive_file`). Subtracted only
 * when smaller than `usage`, so the result can never go negative. `undefined` when `usage` is missing or
 * non-finite, which makes `takeSample` skip the tick rather than emit a partial frame.
 */
function memoryUsageBytesExcludingCache(stats: Docker.ContainerStats): number | undefined {
	const usage = stats.memory_stats?.usage;
	if (typeof usage !== 'number' || !Number.isFinite(usage)) return undefined;
	const memStats = stats.memory_stats.stats as { total_inactive_file?: number; inactive_file?: number } | undefined;
	const cacheBytes = memStats?.total_inactive_file ?? memStats?.inactive_file;
	return cacheBytes !== undefined && cacheBytes < usage ? usage - cacheBytes : usage;
}

/**
 * Presence-and-finiteness guard for the one `cpu_stats` field the delta reads. A missing or non-finite
 * `total_usage` skips the tick instead of throwing or producing a `NaN`. The read time is the daemon's own
 * `read` timestamp when it parses, else this process's clock - the two differ only by the request's
 * latency, which a one-second cadence makes negligible.
 *
 * Deliberately NOT `docker stats`' `cpu_delta / system_cpu_delta * online_cpus` formula: that one is only
 * right when `system_cpu_usage` is the sum over all CPUs of the host's `/proc/stat` time, which Docker
 * reports but Podman's Docker-compatible API does not (measured against a real Podman 4.9 daemon: a run
 * throttled to 0.25 core came out as ~66% of one core, not ~25%). CPU-time-over-wall-time needs no
 * daemon-specific field and agrees with the Docker formula on Docker to within a fraction of a percent.
 */
function cpuUsageSnapshotOf(stats: Docker.ContainerStats): CpuUsageSnapshot | undefined {
	const totalUsageNs = stats.cpu_stats?.cpu_usage?.total_usage;
	if (typeof totalUsageNs !== 'number' || !Number.isFinite(totalUsageNs)) return undefined;
	const daemonReadAtMs = typeof stats.read === 'string' ? Date.parse(stats.read) : Number.NaN;
	return { totalUsageNs, readAtMs: Number.isFinite(daemonReadAtMs) ? daemonReadAtMs : Date.now() };
}

/**
 * Samples an already-running container once per `SAMPLE_INTERVAL_MS`, reporting CPU as percent of one
 * core. The delta is computed against this sampler's own previous sample rather than the response's
 * `precpu_stats`, which `'one-shot': true` does not reliably populate; an unemitted baseline read seeds
 * it. `stop()` awaits the at-most-one in-flight call, bounded by `SAMPLER_STOP_GRACE_MS`. A tick that
 * finds the previous call still in flight is skipped, keeping "at most one in flight" an invariant.
 */
function startResourceSampler(
	container: Docker.Container,
	memoryLimitBytes: number,
	onSample: (sample: RunResourceSample) => void,
): { stop(): Promise<void> } {
	let stopped = false;
	let previous: CpuUsageSnapshot | undefined;
	let inFlight: Promise<void> | undefined;

	const takeSample = async (emit: boolean): Promise<void> => {
		let stats: Docker.ContainerStats;
		try {
			stats = await container.stats({ stream: false, 'one-shot': true });
		} catch {
			// The container may have already exited (or be mid-removal) by the time this particular tick's
			// round trip lands - not an error condition for the sampler itself, just a skipped sample.
			return;
		}
		if (stopped) return; // `stop()` raced this call to completion - never emit after stop.

		const current = cpuUsageSnapshotOf(stats);
		const memoryBytes = memoryUsageBytesExcludingCache(stats);
		if (!current || memoryBytes === undefined) {
			// This tick's stats blob is missing (or reports non-finite for) a field a complete eight-field
			// `systemInfo` frame needs - skipped exactly like the rejecting-stats case above: no emission,
			// `previous` left untouched. Never emit a partial frame (a frame missing even one field fails
			// Python-SDK-side pydantic validation and is silently dropped there), and never let a
			// `NaN`/`undefined` reach `events-channel.ts`'s running avg/max accumulators, which would poison
			// every later frame of the run, not just this one tick.
			return;
		}

		if (emit && previous) {
			const cpuDeltaNs = current.totalUsageNs - previous.totalUsageNs;
			const wallDeltaNs = (current.readAtMs - previous.readAtMs) * 1_000_000;
			// `wallDeltaNs` is 0 only in a degenerate case (two reads stamped with the very same instant) -
			// reported as 0% rather than producing NaN/Infinity.
			const cpuPercentOfOneCore = wallDeltaNs > 0 ? (cpuDeltaNs / wallDeltaNs) * 100 : 0;
			onSample({
				cpuPercentOfOneCore,
				memoryBytes,
				memoryLimitBytes,
				at: new Date(),
			});
		}
		previous = current;
	};

	// The unemitted baseline read (see doc comment above) - kicked off synchronously so `inFlight` is
	// already set before this function returns, exactly like every later tick.
	inFlight = takeSample(false).finally(() => {
		inFlight = undefined;
	});

	const timer = setInterval(() => {
		if (stopped || inFlight) return; // never overlap a still-in-flight call (see doc comment above).
		inFlight = takeSample(true).finally(() => {
			inFlight = undefined;
		});
	}, SAMPLE_INTERVAL_MS);

	return {
		async stop() {
			stopped = true;
			clearInterval(timer);
			if (!inFlight) return;
			// Bounded per `SAMPLER_STOP_GRACE_MS`'s own doc comment - a `stats()` call that never settles must
			// never leave this `await` (and everything waiting on it) unbounded. The grace timer's own handle
			// is captured and cleared once the race settles either way, so the common case (`inFlight` wins
			// well inside the grace window) never leaves an armed timer behind on the event loop.
			let graceTimer: ReturnType<typeof setTimeout> | undefined;
			await Promise.race([
				inFlight,
				new Promise<void>((resolve) => {
					graceTimer = setTimeout(resolve, SAMPLER_STOP_GRACE_MS);
				}),
			]).finally(() => clearTimeout(graceTimer));
		},
	};
}

export class DockerDriver implements Driver {
	private readonly docker: Docker;
	/** One `AbortController` per in-flight `startBuild` call, keyed by build id - `abortBuild` aborts it. */
	private readonly buildControllers = new Map<string, AbortController>();
	/** Build/run ids the driver itself killed via its own `timeoutSecs` timer, consumed exactly once by
	 * the corresponding `startBuild`/`startRun` call to tell a timeout apart from every other way a
	 * build/run can end (`DriverTimedOutError` for builds, `RunOutcome.timedOut` for runs). */
	private readonly timedOutBuilds = new Set<string>();
	private readonly timedOutRuns = new Set<string>();
	private readonly runContainers = new Map<string, Docker.Container>();
	/** The host's own CPU/memory capacity, snapshotted once at `init()` time - `undefined` when
	 * `docker.info()` threw or omitted either field, meaning "capacity unknown" (see
	 * `captureHostCapacity`'s doc comment). */
	private hostCapacity: HostCapacity | undefined;
	/** Set once `ensureProbeImage` has actually built (or found) the probe image - every later call
	 * returns this without touching the daemon again. */
	private probeImageId: string | undefined;
	/** In-flight build, shared by every concurrent `ensureProbeImage` caller so the image is never built
	 * twice at once; cleared on failure so a later call gets to retry rather than replaying the same
	 * rejection forever. */
	private probeImageBuild: Promise<string> | undefined;
	/** Python debug payload tar + debugpy version, read from disk at most once and cached. */
	private debugPayload: { tar: Buffer; debugpyVersion: string } | undefined;
	/** True once this process's own container is confirmed on the `apify-local` network
	 * (`selfAttachToNetwork`): joined by this process, or started there with `--network apify-local`.
	 * False when this process is not in a container at all (`pnpm dev`) or the engine refused the attach
	 * (rootless Podman runs the runtime container under slirp4netns/pasta, where joining a second network
	 * is unsupported). */
	private onActorNetwork = false;
	/** The `ExtraHosts` entry every Actor container gets so `apify-api` reaches this API, or undefined when
	 * the network's own DNS resolves the alias (this process registered it when it joined). Set by
	 * `selfAttachToNetwork`: `apify-api:host-gateway` (the host's published port) when this process is
	 * off the network; `apify-api:<own address>` when it sits on the network without the alias - a
	 * container started with `--network apify-local` has no alias unless the user also passed one. */
	private apiHostEntry: string | undefined;
	/** The `ExtraHosts` entry that routes `apify-api` to this API through the host's published port -
	 * for Actor containers off the `apify-local` network. The address is the one the engine itself hands
	 * every container for the host (`host.containers.internal` on Podman, `host.docker.internal` on Docker
	 * Desktop - read from this container's own hosts file in `init`), or the engine keyword `host-gateway`
	 * when the hosts file has no such entry (Docker Engine). Podman before 4.1 does not know the
	 * keyword, which is why the hosts file comes first. */
	private hostRouteEntry = `${CONTAINER_API_ALIAS}:host-gateway`;
	/** True on Podman 3.x (`init`): Actor containers and browser-view sidecars never use `apify-local`
	 * and run on the engine's default network, reaching this API by `chooseDefaultNetworkRoute`. */
	private actorsOnDefaultNetwork = false;
	/** `chooseDefaultNetworkRoute`'s answer, computed once on first use. */
	private defaultNetworkRoute: Promise<DefaultNetworkRoute> | undefined;
	/** `detectResourceLimitSupport`'s answer from `init`. */
	private resourceLimits: ResourceLimitSupport = ALL_LIMITS_SUPPORTED;
	private readonly hostsFile: string;
	private readonly routeFile: string;
	private readonly networkInterfaces: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>;
	private browserViewerImageId: string | undefined;
	/** Shared by concurrent callers; cleared on failure so a later call retries (like `probeImageBuild`). */
	private browserViewerImport: Promise<string> | undefined;
	private readonly browserViewers = new Map<string, { container: Docker.Container; volumeName: string }>();
	/** A started standby container's server address, keyed by run id; gone with the container. */
	private readonly containerServers = new Map<string, ContainerServerAddress>();

	available = false;
	unavailableReason: string | undefined;

	/** `docker` is injectable (defaults to a real `Docker()` socket client) so tests can pass a stub
	 * `dockerode`-shaped object - there is no Docker daemon in this sandbox to test against for real. */
	constructor(
		docker: Docker = new Docker(),
		options: {
			hostsFile?: string;
			routeFile?: string;
			networkInterfaces?: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>;
		} = {},
	) {
		this.docker = docker;
		this.hostsFile = options.hostsFile ?? '/etc/hosts';
		this.routeFile = options.routeFile ?? '/proc/net/route';
		this.networkInterfaces = options.networkInterfaces ?? (() => os.networkInterfaces());
	}

	async init(): Promise<void> {
		try {
			await this.docker.ping();
		} catch (error) {
			this.available = false;
			this.unavailableReason =
				`Docker API socket is not reachable (mount your Docker or Podman socket at /var/run/docker.sock, ` +
				`or point DOCKER_HOST at it): ${(error as Error).message}`;
			return;
		}

		// A `docker.info()` failure must not make an otherwise-reachable daemon look unavailable.
		await this.captureHostCapacity();
		this.resourceLimits = await detectResourceLimitSupport(this.docker);
		const unenforced = (['cpu', 'memory'] as const).filter((limit) => !this.resourceLimits[limit]);
		if (unenforced.length > 0) {
			console.warn(
				`Per-run ${unenforced.join(' and ')} limits are not enforced: the engine reports no ` +
					`${unenforced.map((limit) => `'${limit}'`).join('/')} cgroup controller available to it (rootless ` +
					`Podman on a host that does not delegate it, or cgroups v1). Runs start without ${unenforced.length > 1 ? 'those limits' : 'that limit'}.`,
			);
		}

		this.hostRouteEntry = `${CONTAINER_API_ALIAS}:${await hostAddressSeenFromContainers(this.hostsFile)}`;
		this.apiHostEntry = this.hostRouteEntry;

		// Podman 3.x (the CNI generation, e.g. Ubuntu 22.04's 3.4): its user-defined networks are not worth
		// touching - the stock config is unusable on the most common install, rootless cannot attach a
		// running container at all, and a failed attach can wreck this container's own networking. Actors
		// run on the engine's default network instead.
		if ((await podmanMajorVersion(this.docker)) === 3) {
			this.actorsOnDefaultNetwork = true;
			const route = await this.routeOnDefaultNetwork();
			console.warn(
				`Podman 3.x: Actor containers run on the engine's default network (its user-defined networks are ` +
					`not used) and reach this API as ${route.extraHost}` +
					`${route.networkMode ? ` (network mode ${route.networkMode})` : ''}; keep -p ${API_PORT}:${API_PORT} ` +
					`published on all interfaces.`,
			);
			this.available = true;
			return;
		}

		try {
			await this.ensureNetwork();
			await this.selfAttachToNetwork();
			this.available = true;
		} catch (error) {
			this.available = false;
			this.unavailableReason = `Docker network setup failed: ${(error as Error).message}`;
		}
	}

	/**
	 * Best-effort snapshot of the host's CPU count and total memory. A missing field or a failed call
	 * leaves `hostCapacity` unset - "unknown", which warns about nothing rather than warning on every run.
	 */
	private async captureHostCapacity(): Promise<void> {
		try {
			const info: unknown = await this.docker.info();
			const ncpu = (info as { NCPU?: unknown } | undefined)?.NCPU;
			const memTotalBytes = (info as { MemTotal?: unknown } | undefined)?.MemTotal;
			if (typeof ncpu === 'number' && typeof memTotalBytes === 'number') {
				this.hostCapacity = { ncpu, memTotalBytes };
			}
		} catch {
			// Capacity stays unknown - see the doc comment above.
		}
	}

	/**
	 * A warning naming the requested and host figures for whichever resource is over capacity. The limits
	 * are applied verbatim regardless; `undefined` covers both "in capacity" and "capacity unknown".
	 */
	private buildOverCapacityWarning(ctx: RunContext): string | undefined {
		if (!this.hostCapacity) return undefined;

		const requestedCores = dedicatedCpusFor(ctx.memoryMbytes);
		const hostMemoryMbytes = this.hostCapacity.memTotalBytes / (1024 * 1024);
		const memoryOverCapacity = ctx.memoryMbytes > hostMemoryMbytes;
		const cpuOverCapacity = requestedCores > this.hostCapacity.ncpu;
		if (!memoryOverCapacity && !cpuOverCapacity) return undefined;

		const overCapacityParts: string[] = [];
		if (memoryOverCapacity) {
			overCapacityParts.push(`${ctx.memoryMbytes} MB (host has ${Math.round(hostMemoryMbytes)} MB)`);
		}
		if (cpuOverCapacity) {
			overCapacityParts.push(`${requestedCores.toFixed(2)} CPU cores (host has ${this.hostCapacity.ncpu})`);
		}

		return (
			`Requested ${overCapacityParts.join(' and ')} — applying the requested limits anyway; this ` +
			`container is scheduled against resources the host does not have.\n`
		);
	}

	private async ensureNetwork(): Promise<void> {
		const networks = await this.docker.listNetworks({ filters: JSON.stringify({ name: [NETWORK_NAME] }) });
		if (networks.some((n) => n.Name === NETWORK_NAME)) return;
		await this.docker.createNetwork({ Name: NETWORK_NAME, Driver: 'bridge' });
	}

	private async selfAttachToNetwork(): Promise<void> {
		// Docker sets the container hostname to its own short id by default; this is a best-effort
		// self-identification that only matters when this process itself runs inside a container
		// (the shipped runtime image) - a bare `node dist/index.js` on the host has nothing to attach.
		const selfId = process.env.HOSTNAME;
		if (!selfId) {
			this.onActorNetwork = false;
			this.apiHostEntry = this.hostRouteEntry;
			console.warn(
				`Not running inside a container (no HOSTNAME): Actor containers will reach this API through ` +
					`the host's port ${API_PORT} (${this.hostRouteEntry}) instead of the ${NETWORK_NAME} ` +
					`network alias.`,
			);
			return;
		}

		const network = this.docker.getNetwork(NETWORK_NAME);
		const info = await network.inspect().catch(() => undefined);
		// `Containers` is keyed by full container id on both Docker and Podman, while `HOSTNAME` is the
		// short (12-char) one - a prefix match is what "already attached" actually means here. Without it
		// every restart of the runtime container re-attempted the connect and logged the daemon's
		// "already connected" rejection as a warning.
		if (Object.keys(info?.Containers ?? {}).some((id) => id.startsWith(selfId))) {
			this.onActorNetwork = true;
			this.apiHostEntry = await this.apiHostEntryWhenAlreadyAttached(selfId);
			return;
		}

		try {
			await network.connect({ Container: selfId, EndpointConfig: { Aliases: [CONTAINER_API_ALIAS] } });
			this.onActorNetwork = true;
			this.apiHostEntry = undefined;
		} catch (error) {
			// Not fatal: `startRun` falls back to routing Actor containers to this API through the host's
			// published port (`ExtraHosts: apify-api -> host-gateway`). The usual cause is rootless Podman,
			// whose default slirp4netns/pasta network mode cannot join a second network at runtime.
			this.onActorNetwork = false;
			this.apiHostEntry = this.hostRouteEntry;
			console.warn(
				`Could not attach the runtime's own container to the ${NETWORK_NAME} network: ${(error as Error).message}. ` +
					`Actor containers will reach this API through the host's published port ${API_PORT} instead ` +
					`(${this.hostRouteEntry}), so keep -p ${API_PORT}:${API_PORT} published on all interfaces. ` +
					`To use the network alias anyway, pre-create the network (\`podman network create ${NETWORK_NAME}\`) ` +
					`and start the runtime container with \`--network ${NETWORK_NAME}\`.`,
			);
		}
	}

	/** For a runtime container that was put on the network by whoever started it (`--network apify-local`)
	 * rather than by `selfAttachToNetwork`: the alias is registered only if they also passed
	 * `--network-alias apify-api`. Otherwise the container's own address on the network stands in for it -
	 * a hosts-file entry needs no DNS at all, so this route also works on engines whose network has no
	 * name resolution. The host's published port is the last resort if even the address is unknown. */
	private async apiHostEntryWhenAlreadyAttached(selfId: string): Promise<string | undefined> {
		const self = await this.docker
			.getContainer(selfId)
			.inspect()
			.catch(() => undefined);
		const endpoint = self?.NetworkSettings?.Networks?.[NETWORK_NAME];
		if (endpoint?.Aliases?.includes(CONTAINER_API_ALIAS)) return undefined;
		if (endpoint?.IPAddress) return `${CONTAINER_API_ALIAS}:${endpoint.IPAddress}`;
		console.warn(
			`The runtime's own container is on the ${NETWORK_NAME} network but its address there could not be ` +
				`read; Actor containers will reach this API through the host's published port ${API_PORT} instead ` +
				`(${this.hostRouteEntry}), so keep -p ${API_PORT}:${API_PORT} published on all interfaces.`,
		);
		return this.hostRouteEntry;
	}

	/** The `HostConfig` network fields for an Actor container: on the `apify-local` network with the alias
	 * route, or - Podman 3.x - on the engine's default network with `chooseDefaultNetworkRoute`'s. */
	private async actorNetworkHostConfig(): Promise<Pick<Docker.HostConfig, 'NetworkMode' | 'ExtraHosts'>> {
		if (!this.actorsOnDefaultNetwork) {
			return {
				NetworkMode: NETWORK_NAME,
				// Only when the alias cannot resolve through the network's own DNS (`apiHostEntry`'s doc
				// comment). Never added when the alias works: a hosts-file entry would override the DNS alias
				// and force every Actor through the host.
				...(this.apiHostEntry ? { ExtraHosts: [this.apiHostEntry] } : {}),
			};
		}
		const route = await this.routeOnDefaultNetwork();
		return { ...(route.networkMode ? { NetworkMode: route.networkMode } : {}), ExtraHosts: [route.extraHost] };
	}

	private routeOnDefaultNetwork(): Promise<DefaultNetworkRoute> {
		this.defaultNetworkRoute ??= (async () => {
			const view: OwnNetworkView = {
				hostAddress: await engineHostEntry(this.hostsFile),
				gateway: defaultGatewayFromRouteTable(await readFile(this.routeFile, 'utf8').catch(() => '')),
				own: firstNonLoopbackIpv4(this.networkInterfaces()),
			};
			return chooseDefaultNetworkRoute(view);
		})();
		return this.defaultNetworkRoute;
	}

	async startBuild(ctx: BuildContext, onLog: (chunk: string) => void): Promise<BuildOutcome> {
		if (!this.available) {
			throw new Error(this.unavailableReason ?? 'Docker is not available');
		}

		const imageTag = `actor-runtime/${ctx.actorName}:${ctx.buildId}`.toLowerCase();

		const controller = new AbortController();
		this.buildControllers.set(ctx.buildId, controller);
		const timeoutTimer = setTimeout(() => {
			this.timedOutBuilds.add(ctx.buildId);
			controller.abort();
		}, ctx.timeoutSecs * 1000);

		try {
			return await this.buildImageOnce(ctx, imageTag, controller.signal, onLog);
		} catch (error) {
			// Never after an abort or a timeout, and never twice - the second attempt names its platform, so
			// the same failure again is genuine.
			const failure = this.asTimedOutOrOriginal(ctx, error as Error);
			if (controller.signal.aborted || !isMissingManifestForBuildPlatform(failure.message)) throw failure;
			onLog(formatRuntimeLog(compatibilityBuildNotice(failure.message)));
			return await this.buildImageOnce(ctx, imageTag, controller.signal, onLog, COMPATIBILITY_BUILD_PLATFORM);
		} finally {
			clearTimeout(timeoutTimer);
			this.buildControllers.delete(ctx.buildId);
			// Dropped for the paths that never look at it (a build that succeeded after its timeout fired),
			// so it cannot leak into a later build with the same id.
			this.timedOutBuilds.delete(ctx.buildId);
		}
	}

	/** One `docker build` attempt. The tar is rebuilt per attempt (a tar stream is consumed once), and
	 * `platform` is left off entirely for the host-native one. */
	private async buildImageOnce(
		ctx: BuildContext,
		imageTag: string,
		abortSignal: AbortSignal,
		onLog: (chunk: string) => void,
		platform?: string,
	): Promise<BuildOutcome> {
		let stream: NodeJS.ReadableStream;
		try {
			stream = await this.docker.buildImage(buildTarball(ctx.sourceFiles), {
				t: imageTag,
				nocache: !ctx.useCache,
				dockerfile: ctx.dockerfilePath,
				...(ctx.buildArgs ? { buildargs: ctx.buildArgs } : {}),
				abortSignal,
				...(platform ? { platform } : {}),
			});
		} catch (error) {
			throw this.asTimedOutOrOriginal(ctx, error as Error);
		}

		return new Promise<BuildOutcome>((resolve, reject) => {
			this.docker.modem.followProgress(
				stream,
				// Async is fine here: TypeScript allows a `Promise<void>`-returning function where `void` is
				// expected, and `followProgress` (`docker-modem`) only ever invokes this callback once and
				// never awaits its result - `resolve`/`reject` below settle the outer Promise whenever this
				// async function actually gets there.
				async (err: Error | null, res: Array<{ stream?: string; error?: string; aux?: { ID?: string } }>) => {
					if (this.timedOutBuilds.delete(ctx.buildId)) {
						reject(new DriverTimedOutError(`Build exceeded its ${ctx.timeoutSecs}s timeout`));
						return;
					}
					if (err) {
						reject(err);
						return;
					}
					const errorLine = res.find((line) => line.error);
					if (errorLine) {
						reject(new Error(errorLine.error));
						return;
					}
					const imageWorkingDirectory = await this.inspectWorkingDirectory(imageTag);
					resolve({ imageId: imageTag, imageWorkingDirectory });
				},
				(event: { stream?: string; status?: string; error?: string }) => {
					if (event.stream) onLog(event.stream);
					else if (event.status) onLog(`${event.status}\n`);
					else if (event.error) onLog(`${event.error}\n`);
				},
			);
		});
	}

	/** The timeout flag is consumed exactly once, however a build attempt ends - whichever site notices it
	 * first reports TIMED-OUT instead of whatever error the cancelled build produced. */
	private asTimedOutOrOriginal(ctx: BuildContext, error: Error): Error {
		return this.timedOutBuilds.delete(ctx.buildId)
			? new DriverTimedOutError(`Build exceeded its ${ctx.timeoutSecs}s timeout`)
			: error;
	}

	/** `.Config.WorkingDir` of the image just built, via `dockerode`, never a shelled-out
	 * `docker inspect`. An inspect failure is logged and tolerated - must never fail an otherwise-
	 * successful build - and an empty or `/` working directory is treated as unknown too: mounting a dev
	 * folder over `/` would destroy the container. */
	private async inspectWorkingDirectory(imageId: string): Promise<string | undefined> {
		try {
			const info = await this.docker.getImage(imageId).inspect();
			const workingDir = info.Config.WorkingDir;
			return workingDir && workingDir !== '/' ? workingDir : undefined;
		} catch (error) {
			console.warn(`Could not inspect image ${imageId} for its working directory: ${(error as Error).message}`);
			return undefined;
		}
	}

	/**
	 * Reads back `Config.Cmd`/`Config.Entrypoint` and env for `resolveDebugPlan`
	 * (`services/debug-mode.ts`). An inspect failure here is not tolerated - it propagates rather than
	 * being treated as "no Cmd, no Entrypoint, no env", which would misreport as unclassifiable.
	 */
	async inspectDebugTarget(imageId: string): Promise<InspectedDebugTarget> {
		const info = await this.docker.getImage(imageId).inspect();
		const envList = info.Config.Env ?? [];
		const envMap: Record<string, string> = {};
		for (const entry of envList) {
			const separatorIndex = entry.indexOf('=');
			if (separatorIndex === -1) continue;
			envMap[entry.slice(0, separatorIndex)] = entry.slice(separatorIndex + 1);
		}
		// Entrypoint arrives as either a string or a string array; normalized to an array here.
		const entrypointRaw = info.Config.Entrypoint;
		const entrypoint = Array.isArray(entrypointRaw) ? entrypointRaw : entrypointRaw ? [entrypointRaw] : undefined;
		return {
			cmd: info.Config.Cmd ?? undefined,
			entrypoint,
			env: {
				PYTHONPATH: envMap.PYTHONPATH,
				NODE_OPTIONS: envMap.NODE_OPTIONS,
				PYTHON_VERSION: envMap.PYTHON_VERSION,
				NODE_VERSION: envMap.NODE_VERSION,
			},
		};
	}

	/**
	 * Genuinely interrupts the in-flight build: aborts the `AbortController` passed to `buildImage` as
	 * `abortSignal`, which destroys the underlying HTTP request to the Docker daemon (see the class
	 * doc comment). A no-op if the build already finished (its controller was already cleaned up) - the
	 * caller's own terminal-status guard is what makes that safe, not this check.
	 */
	async abortBuild(buildId: string): Promise<void> {
		this.buildControllers.get(buildId)?.abort();
	}

	async startRun(
		ctx: RunContext,
		onLog: (chunk: string) => void,
		onSample?: (sample: RunResourceSample) => void,
	): Promise<RunOutcome> {
		if (!this.available) {
			throw new Error(this.unavailableReason ?? 'Docker is not available');
		}

		const serverRoute = ctx.containerServerPort ? this.containerServerRoute() : undefined;
		// In this process's network namespace every server needs a port of its own, and the API is on loopback.
		const netnsServerPort = serverRoute === 'netns' ? await allocateFreePort() : undefined;
		const env = Object.entries(netnsServerPort ? sharedNetnsEnv(ctx.env, netnsServerPort) : ctx.env).map(
			([key, value]) => `${key}=${value}`,
		);

		// Informational only - the requested limits are applied verbatim either way.
		const overCapacityWarning = this.buildOverCapacityWarning(ctx);
		if (overCapacityWarning) onLog(formatRuntimeLog(overCapacityWarning));

		// Re-verified on every dev-mount run, before any container exists: Docker would reject a `Mounts`
		// bind whose source vanished since registration, but Podman's Docker-compatible API auto-creates the
		// missing source instead - which would silently start the run against an empty directory, exactly
		// what `actor-driver.md` forbids ("fail visibly - never silently mount an empty directory").
		let preservedEntrypoint: PreservedEntrypoint | undefined;
		if (ctx.devMount) {
			await this.assertDevFolderStillPresent(ctx.devMount.localDevFolder);
			preservedEntrypoint = await this.preserveHiddenEntrypoint(ctx.imageId, ctx.devMount, onLog);
		}

		// Loaded and logged before `createContainer` so a missing payload fails the run before any
		// container exists, and the attach line lands in the log even if container creation fails.
		let debugPayload: { tar: Buffer; debugpyVersion: string } | undefined;
		if (ctx.debug) {
			if (ctx.debug.language === 'python') {
				debugPayload = await this.loadDebugPayload();
				onLog(
					formatRuntimeLog(
						this.buildDebugLogLine(
							{ language: 'python', port: ctx.debug.port, debugpyVersion: debugPayload.debugpyVersion },
							ctx.timeoutSecs,
						),
					),
				);
			} else {
				onLog(
					formatRuntimeLog(
						this.buildDebugLogLine({ language: 'node', port: ctx.debug.port }, ctx.timeoutSecs),
					),
				);
			}
		}

		// The X-socket volume is the only change a browser-view run makes to the Actor's container.
		const mounts: Docker.MountSettings[] = [
			...(ctx.devMount ? this.buildDevMounts(ctx.devMount, ctx.runId) : []),
			...(ctx.x11SocketVolume
				? [{ Type: 'volume' as const, Source: ctx.x11SocketVolume, Target: X11_SOCKET_DIR }]
				: []),
		];

		// Only a server this process cannot reach on `apify-local` is published, on an engine-picked port.
		const serverPublish =
			ctx.containerServerPort && (serverRoute === 'loopback' || serverRoute === 'host')
				? {
						port: `${ctx.containerServerPort}/tcp`,
						// A process on the host reaches loopback; one in a container off the network reaches the host.
						binding: { HostIp: serverRoute === 'loopback' ? '127.0.0.1' : '', HostPort: '' },
					}
				: undefined;
		const exposedPorts: Record<string, object> = {
			...(ctx.debug ? { [`${ctx.debug.port}/tcp`]: {} } : {}),
			...(serverPublish ? { [serverPublish.port]: {} } : {}),
		};
		const portBindings: Record<string, Array<{ HostIp: string; HostPort: string }>> = {
			// Fixed 127.0.0.1-bound publish - lands on the developer's own host, not wherever the
			// runtime process itself runs.
			...(ctx.debug
				? { [`${ctx.debug.port}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: String(ctx.debug.port) }] }
				: {}),
			...(serverPublish ? { [serverPublish.port]: [serverPublish.binding] } : {}),
		};

		const container = await this.docker.createContainer({
			Image: ctx.imageId,
			Env: env,
			Labels: { [RUN_LABEL]: ctx.runId },
			...(preservedEntrypoint
				? {
						[preservedEntrypoint.field]: preservedEntrypoint.command,
						...(preservedEntrypoint.cmd ? { Cmd: preservedEntrypoint.cmd } : {}),
					}
				: {}),
			...(Object.keys(exposedPorts).length > 0 && !netnsServerPort ? { ExposedPorts: exposedPorts } : {}),
			HostConfig: {
				...(netnsServerPort
					? { NetworkMode: `container:${process.env.HOSTNAME}` }
					: await this.actorNetworkHostConfig()),
				...(this.resourceLimits.memory ? { Memory: ctx.memoryMbytes * 1024 * 1024 } : {}),
				// A CFS quota, never `NanoCpus`: the daemon hard-rejects a `NanoCpus` above the host's own
				// CPU count, which would turn "warn, never clamp" into "cannot run at all". `CpuQuota` is
				// validated for range only, so an over-capacity request still starts.
				...(this.resourceLimits.cpu
					? { CpuPeriod: CPU_PERIOD_US, CpuQuota: cpuQuotaFor(ctx.memoryMbytes) }
					: {}),
				AutoRemove: false,
				...(mounts.length > 0 ? { Mounts: mounts } : {}),
				...(Object.keys(portBindings).length > 0 && !netnsServerPort ? { PortBindings: portBindings } : {}),
			},
			Tty: false,
		});
		this.runContainers.set(ctx.runId, container);

		// Both declared outside the `try` below (so the `finally` can always see them) but only ever
		// assigned inside it - `sampler` stays `undefined` if `container.start()` itself throws, and
		// `timeout` stays `undefined` if anything before its own `setTimeout` call throws; `finally` guards
		// each accordingly.
		let sampler: { stop(): Promise<void> } | undefined;
		let timeout: ReturnType<typeof setTimeout> | undefined;

		try {
			// Inside the try so a failed upload still reaches the finally below and removes the container.
			if (preservedEntrypoint) await container.putArchive(preservedEntrypoint.tar, { path: '/' });
			if (debugPayload) {
				await container.putArchive(debugPayload.tar, { path: '/' });
			}

			try {
				await container.start();
			} catch (error) {
				if (ctx.debug && isPortInUseError(error)) {
					throw new DebugPortInUseError(ctx.debug.port);
				}
				throw error;
			}

			// Only started when someone is actually listening - an unconditional sampler would issue
			// `container.stats()` calls no caller asked for (and against a stub `dockerode` in tests that
			// never mocks `.stats()` at all, a hard failure). Created (and the log stream opened, below)
			// Inside the `try` so a throw here still reaches the `finally` that stops the sampler and
			// removes the container.
			sampler = onSample ? startResourceSampler(container, ctx.memoryMbytes * 1024 * 1024, onSample) : undefined;

			if (netnsServerPort) {
				this.containerServers.set(ctx.runId, { host: '127.0.0.1', port: netnsServerPort });
			} else if (ctx.containerServerPort && serverRoute && serverRoute !== 'netns') {
				const address = await this.resolveContainerServer(container, ctx.containerServerPort, serverRoute);
				if (address) this.containerServers.set(ctx.runId, address);
				else
					onLog(
						formatRuntimeLog(
							`Could not determine where the Actor's server on port ${ctx.containerServerPort} is reachable.`,
						),
					);
			}

			const logStream = (await container.logs({
				follow: true,
				stdout: true,
				stderr: true,
			})) as NodeJS.ReadableStream;
			const stdout = new PassThrough();
			const stderr = new PassThrough();
			stdout.on('data', (chunk: Buffer) => onLog(chunk.toString('utf8')));
			stderr.on('data', (chunk: Buffer) => onLog(chunk.toString('utf8')));
			this.docker.modem.demuxStream(logStream, stdout, stderr);

			// `container.logs({follow:true})` is a separate Docker API connection from `container.wait()` -
			// the two settle independently, with no ordering guarantee between "the container process exited"
			// and "every byte of its stdout/stderr has actually arrived over the logs connection". Without
			// this, `startRun` could resolve (and its caller could write a terminal run status) before the
			// run's trailing log output had even reached `onLog` yet: a client that polls status, sees it turn
			// terminal, and immediately does a non-stream `GET /v2/logs/:id` could read the log before its
			// final chunk landed.
			//
			// "Logs drained" MUST be derived from `logStream` (the SOURCE multiplexed stream) ending, not from
			// `stdout`/`stderr` (the demuxed destinations) ending - `docker-modem`'s `demuxStream` only ever
			// copies frames: it registers exactly `streama.on('data', processData)` on the source
			// (`node_modules/docker-modem/lib/modem.js`, `Modem.prototype.demuxStream`) and never calls
			// `.end()`/`.destroy()` on `stdout`/`stderr` itself. Awaiting the destinations' own `'end'` (the
			// previous fix) therefore never resolves against a real daemon, which never ends them on its own -
			// the run stayed RUNNING until its `timeoutSecs` finalized it as TIMED-OUT, exactly the CI
			// regression this closes. So this driver ends them itself, once the source stream ends.
			let sourceEnded = false;
			const sourceEndedPromise = new Promise<void>((resolve) => {
				const finish = (): void => {
					if (sourceEnded) return;
					sourceEnded = true;
					stdout.end();
					stderr.end();
					resolve();
				};
				logStream.once('end', finish);
				logStream.once('close', finish);
			});

			if (ctx.timeoutSecs > 0) {
				timeout = setTimeout(() => {
					this.timedOutRuns.add(ctx.runId);
					void container.stop().catch(() => undefined);
				}, ctx.timeoutSecs * 1000);
			}

			const result = (await container.wait()) as { StatusCode: number };
			// `container.wait()` resolves the same way whether the process exited on its own or was
			// stopped by our own timeout timer - the timer having fired is the only signal that
			// distinguishes the two, hence tracking it out-of-band instead of trusting the exit code.
			const timedOut = this.timedOutRuns.delete(ctx.runId);

			// Bounded grace, counted from the container's actual exit: the logs connection *should* close
			// very soon after, but a source stream that never ends (a daemon quirk, a hung proxy - the
			// pathological case this grace guards against) must never again hold the run open past the
			// container's real exit the way awaiting `stdout`/`stderr` directly used to. Race the
			// source-end wait against a few seconds; if it expires, log a warning and finalize anyway -
			// `stdout`/`stderr` are left open so any bytes that do eventually arrive still reach `onLog`,
			// they just no longer block this method from resolving.
			const LOG_DRAIN_GRACE_MS = 5000;
			// The grace timer's own handle is captured and cleared once the race settles either way (the
			// common case: `sourceEndedPromise` wins well inside the grace window) - see
			// `SAMPLER_STOP_GRACE_MS`'s own `stop()` above, which clears its identically-shaped timer for
			// exactly this reason.
			let logDrainGraceTimer: ReturnType<typeof setTimeout> | undefined;
			await Promise.race([
				sourceEndedPromise,
				new Promise<void>((resolve) => {
					logDrainGraceTimer = setTimeout(resolve, LOG_DRAIN_GRACE_MS);
				}),
			]).finally(() => clearTimeout(logDrainGraceTimer));
			if (!sourceEnded) {
				console.warn(
					`Run ${ctx.runId}: log stream did not end within ${LOG_DRAIN_GRACE_MS}ms of the container exiting; finalizing the run without waiting further.`,
				);
			}

			return { exitCode: result.StatusCode, timedOut };
		} finally {
			if (timeout) clearTimeout(timeout);
			// Awaited before `container.remove()` so no `stats()` call is issued against a removed container.
			await sampler?.stop();
			this.timedOutRuns.delete(ctx.runId);
			this.runContainers.delete(ctx.runId);
			this.containerServers.delete(ctx.runId);
			// `{ v: true }` also removes any anonymous volumes; the named per-run `node_modules` volume of a
			// `devMount` run (`buildDevMounts`) is not covered by it and goes separately, after the container.
			await container.remove({ v: true }).catch(() => undefined);
			if (ctx.devMount) await this.removeVolumeWithRetry(devNodeModulesVolumeName(ctx.runId));
		}
	}

	async containerServerAddress(runId: string): Promise<ContainerServerAddress | undefined> {
		return this.containerServers.get(runId);
	}

	/**
	 * How this process reaches a standby container's server: directly on `apify-local` when this process
	 * sits there too; otherwise through a published port - on loopback for a process running on the host
	 * itself, on the host's address for one in a container off the network (rootless Podman). On Podman
	 * 3.x the host's address from a container is the slirp4netns gateway, which reaches the host's
	 * published ports only for containers started with `allow_host_loopback` - never this one - so the
	 * standby container joins this container's network namespace instead, as a browser-view sidecar does.
	 */
	private containerServerRoute(): 'network' | 'loopback' | 'host' | 'netns' {
		if (this.onActorNetwork && !this.actorsOnDefaultNetwork) return 'network';
		if (this.actorsOnDefaultNetwork && process.env.HOSTNAME) return 'netns';
		return process.env.HOSTNAME ? 'host' : 'loopback';
	}

	private async resolveContainerServer(
		container: Docker.Container,
		port: number,
		route: 'network' | 'loopback' | 'host',
	): Promise<ContainerServerAddress | undefined> {
		const info = await container.inspect().catch(() => undefined);
		if (!info) return undefined;
		if (route === 'network') {
			const host = containerAddress(info, NETWORK_NAME);
			return host ? { host, port } : undefined;
		}
		const hostPort = Number(info.NetworkSettings?.Ports?.[`${port}/tcp`]?.[0]?.HostPort);
		if (!Number.isInteger(hostPort) || hostPort <= 0) return undefined;
		if (route === 'loopback') return { host: '127.0.0.1', port: hostPort };
		const host =
			(await engineHostEntry(this.hostsFile)) ??
			defaultGatewayFromRouteTable(await readFile(this.routeFile, 'utf8').catch(() => ''));
		return host ? { host, port: hostPort } : undefined;
	}

	/** `startRun`'s pre-container check that a registered dev folder is still a directory on the host -
	 * the same probe registration used (`probeDevFolder`), so the two can never disagree on what counts as
	 * present. Throws (failing the run, with this as its status message) on every non-ok outcome, including
	 * "could not verify": a run that cannot prove its folder exists must not start against whatever the
	 * daemon would put there instead. */
	private async assertDevFolderStillPresent(localDevFolder: string): Promise<void> {
		const outcome = await this.probeDevFolder(localDevFolder, await this.ensureProbeImage());
		if (outcome.ok) return;
		const problem =
			outcome.reason === 'not-found'
				? 'no longer exists on the host'
				: outcome.reason === 'not-a-directory'
					? 'is no longer a directory on the host'
					: `could not be verified on the host (${outcome.reason})`;
		throw new Error(
			`The registered local dev folder ${localDevFolder} ${problem} - the run was not started, so that a ` +
				`missing folder is never silently replaced by an empty directory. Restore the folder, or clear the ` +
				`registration (POST /actor-runtime/dev-folder/<actorId> with an empty string body) to run from the ` +
				`built image alone.`,
		);
	}

	/**
	 * A `devMount` run starts through the image's own `Entrypoint` (or `Cmd`); when the mount hides that
	 * file the engine refuses to start ("executable file not found"). Unless the dev folder carries its
	 * own copy, the image's is extracted and the run starts through it, at a path no mount covers.
	 */
	private async preserveHiddenEntrypoint(
		imageId: string,
		devMount: DevFolderMount,
		onLog: (chunk: string) => void,
	): Promise<PreservedEntrypoint | undefined> {
		const info = await this.docker.getImage(imageId).inspect();
		const entrypointRaw = info.Config?.Entrypoint;
		const entrypoint = Array.isArray(entrypointRaw) ? entrypointRaw : entrypointRaw ? [entrypointRaw] : [];
		const field: PreservedEntrypoint['field'] = entrypoint.length > 0 ? 'Entrypoint' : 'Cmd';
		const command = field === 'Entrypoint' ? entrypoint : (info.Config?.Cmd ?? []);
		const first = command[0];
		const hidden = first ? entryHiddenByDevMount(first, devMount.imageWorkingDirectory) : undefined;
		if (!hidden) return undefined;
		if (await this.devFolderHasEntry(devMount.localDevFolder, hidden.relative)) return undefined;

		const inImage = hidden.inImage;
		const archive = await this.extractFromImage(imageId, inImage);
		const tarball = await repackUnderDirectory(archive, PRESERVED_ENTRYPOINT_DIR);
		onLog(
			formatRuntimeLog(
				`The image starts through ${first} in its working directory, which the dev folder does not contain; ` +
					`using the image's own copy of it.`,
			),
		);
		return {
			field,
			command: [`${PRESERVED_ENTRYPOINT_DIR}/${path.posix.basename(inImage)}`, ...command.slice(1)],
			...(field === 'Entrypoint' && info.Config?.Cmd ? { cmd: info.Config.Cmd } : {}),
			tar: tarball,
		};
	}

	/** Whether `relativePath` exists inside the registered dev folder on the host - through the same probe
	 * container `probeDevFolder` uses, so the answer is the engine's own. Public for tests. */
	async devFolderHasEntry(localDevFolder: string, relativePath: string): Promise<boolean> {
		const container = await this.docker.createContainer({
			Image: await this.ensureProbeImage(),
			Labels: { [PROBE_LABEL]: 'true' },
			HostConfig: {
				Mounts: [{ Type: 'bind', Source: PROBE_MOUNT_SOURCE, Target: PROBE_MOUNT_TARGET, ReadOnly: true }],
			},
		});
		try {
			const outcome = await statInProbe(
				container,
				path.posix.join(PROBE_MOUNT_TARGET, localDevFolder, relativePath),
			);
			return outcome.ok;
		} finally {
			await container.remove().catch((error: Error) => {
				console.warn(`Could not remove dev-folder probe container ${container.id}: ${error.message}`);
			});
		}
	}

	/** The archive of one path from an image, read through a container created (never started) from it. */
	private async extractFromImage(imageId: string, pathInImage: string): Promise<Buffer> {
		const container = await this.docker.createContainer({ Image: imageId, Labels: { [PROBE_LABEL]: 'true' } });
		try {
			return await readStream((await container.getArchive({ path: pathInImage })) as NodeJS.ReadableStream);
		} finally {
			await container.remove().catch(() => undefined);
		}
	}

	/** The two `HostConfig.Mounts` entries for a `devMount` run: a read-write bind for the dev folder
	 * itself (`Mounts`, not `Binds` - a `Mounts`-type bind errors on a missing source instead of silently
	 * auto-creating one), plus a fresh per-run volume over `node_modules` - the engine creates it at
	 * container creation and copies the image's existing contents into it before mounting, preserving the
	 * image's installed dependencies underneath the bind (a plain bind would erase them). */
	private buildDevMounts(devMount: DevFolderMount, runId: string): Docker.MountSettings[] {
		return [
			{ Type: 'bind', Source: devMount.localDevFolder, Target: devMount.imageWorkingDirectory },
			{
				Type: 'volume',
				Source: devNodeModulesVolumeName(runId),
				Target: `${devMount.imageWorkingDirectory}/node_modules`,
			},
		];
	}

	/** Reads the Python debug payload tar and debugpy version off disk, caching a successful read.
	 * Outside the runtime's own built image (e.g. `pnpm dev`) these files don't exist; the rejection
	 * propagates so the run fails before `createContainer`, never as a silent non-debug start. */
	private async loadDebugPayload(): Promise<{ tar: Buffer; debugpyVersion: string }> {
		if (this.debugPayload) return this.debugPayload;
		let tarBuffer: Buffer;
		let versionText: string;
		try {
			[tarBuffer, versionText] = await Promise.all([
				readFile(debugpyPayloadTarPath()),
				readFile(debugpyVersionFilePath(), 'utf8'),
			]);
		} catch (error) {
			throw new Error(
				`Cannot start a Python debug run: the runtime's debugpy payload is missing (${(error as Error).message}). ` +
					`This runtime only injects debugpy when it is running from its own built image (its Dockerfile ` +
					`bakes this payload in) - debug mode for Python Actors does not work when the runtime itself runs ` +
					`from source (e.g. \`pnpm dev\`).`,
			);
		}
		this.debugPayload = { tar: tarBuffer, debugpyVersion: versionText.trim() };
		return this.debugPayload;
	}

	/** The run log's "paused, waiting for a debugger" line, printed before `createContainer`. */
	private buildDebugLogLine(
		debug: { language: 'node'; port: number } | { language: 'python'; port: number; debugpyVersion: string },
		timeoutSecs: number,
	): string {
		const { language, port } = debug;
		const tool =
			language === 'python'
				? `Python (debugpy ${debug.debugpyVersion}, injected by the runtime)`
				: `Node (its own built-in inspector)`;
		const attach =
			language === 'python'
				? `attach PyCharm's "Attach to DAP" or VS Code's "Python: Remote Attach" there`
				: `attach VS Code's "Attach" or Chrome DevTools' "Open dedicated DevTools for Node" there`;
		return (
			`Debug mode: this run is paused before its first line, waiting for a debugger. ${tool} is listening ` +
			`inside the container on 0.0.0.0:${port}, published on the host at 127.0.0.1:${port} - ${attach}. Set ` +
			`your breakpoints as part of that attach - the runtime does not stop synthetically beyond the initial ` +
			`wait, so code runs to your first breakpoint once the IDE delivers it. ` +
			(timeoutSecs > 0
				? `The run's ${timeoutSecs}s timeout is already running and is NOT extended for debugging; pass a ` +
					`larger \`apify call --timeout\` when you expect a long session.\n`
				: `The run has no timeout.\n`)
		);
	}

	/**
	 * Builds (on first call) and returns the id of this driver's own minimal probe image, reusing it on
	 * every later call - idempotent, verified empirically against a real daemon: re-building when the
	 * image already exists succeeds and needs no network access either time. Concurrent callers share
	 * one in-flight build rather than racing separate `buildImage` calls; a failed build is not cached, so
	 * the next call gets to retry against a daemon that may have recovered.
	 *
	 * `FROM scratch` alone builds fine but leaves the image with no `Cmd`/`Entrypoint`, and moby refuses
	 * to create a container from one at all (`no command specified`) - which `probeDevFolder` below would
	 * otherwise misreport as a bad candidate path. The `CMD` fixes that; it is never executed, since the
	 * probe container this image backs is created but never started.
	 */
	async ensureProbeImage(): Promise<string> {
		if (this.probeImageId) return this.probeImageId;
		if (!this.available) throw new Error(this.unavailableReason ?? 'Docker is not available');

		this.probeImageBuild ??= this.buildProbeImage().catch((error) => {
			this.probeImageBuild = undefined;
			throw error;
		});
		const imageId = await this.probeImageBuild;
		this.probeImageId = imageId;
		return imageId;
	}

	private async buildProbeImage(): Promise<string> {
		const tarball = dockerfileTarball(PROBE_DOCKERFILE);
		const stream = await this.docker.buildImage(tarball, { t: PROBE_IMAGE_TAG });
		await new Promise<void>((resolve, reject) => {
			this.docker.modem.followProgress(stream, (err: Error | null, res: Array<{ error?: string }>) => {
				if (err) {
					reject(err);
					return;
				}
				const errorLine = res.find((line) => line.error);
				if (errorLine) {
					reject(new Error(errorLine.error));
					return;
				}
				resolve();
			});
		});
		return PROBE_IMAGE_TAG;
	}

	/**
	 * Host-side existence-and-directory check for a candidate dev-folder path: a probe container that
	 * binds the host's `/` read-only at `PROBE_MOUNT_TARGET`, is never started, and is stat'ed through
	 * `HEAD /containers/{id}/archive?path=/probe<candidate>` (`container.infoArchive`) - the same
	 * resolution `docker cp` uses, which both Docker and Podman perform on a stopped container's bind
	 * mounts too. `fs.existsSync` would test this process's own filesystem, not the host's. `imageId` is
	 * always `ensureProbeImage`'s own image above - never an Actor's build (registration must work for an
	 * Actor with no build at all), a self-inspected runtime image (`HOSTNAME` is unset in bare local dev,
	 * per `selfAttachToNetwork` above), or a pulled one (would break offline-after-first-build).
	 *
	 * Why the host root rather than the candidate itself as the mount source: Docker rejects a `Mounts`
	 * bind whose source is missing, but Podman's Docker-compatible API instead auto-creates the missing
	 * source directory on the host (its `containers_create` compat handler `MkdirAll`s every bind source
	 * and ignores `BindOptions.CreateMountpoint`), so a create-only probe would report a typo'd path as
	 * present *and* leave a root-owned empty directory behind. Mounting `/` (which always exists) and
	 * stat'ing beneath it has no such side effect on either daemon, and one code path serves both.
	 *
	 * The candidate is walked component by component so a symlink anywhere in it still resolves to what
	 * it points at on the host: Docker reports a symlink component as such (with the daemon's
	 * container-scoped `linkTarget`, mapped back to a host path by `hostPathOfLinkTarget`) instead of
	 * following it, while Podman follows symlinks itself. A regular file, or a symlink to one, is
	 * `not-a-directory`; a missing component is `not-found`; anything the daemon would not confirm is
	 * `unknown`, never a guess. Only the classified `DevFolderProbeFailureReason` crosses back to the
	 * caller (`services/dev-folder.ts`), so the path stored and displayed anywhere is always exactly what
	 * the caller submitted.
	 */
	async probeDevFolder(candidatePath: string, imageId: string): Promise<DevFolderProbeOutcome> {
		if (!this.available) return { ok: false, reason: 'unreachable' };

		let container: Docker.Container;
		try {
			container = await this.docker.createContainer({
				Image: imageId,
				Labels: { [PROBE_LABEL]: 'true' },
				HostConfig: {
					Mounts: [{ Type: 'bind', Source: PROBE_MOUNT_SOURCE, Target: PROBE_MOUNT_TARGET, ReadOnly: true }],
				},
			});
		} catch (error) {
			// Creation itself failed, so there is nothing to clean up.
			return { ok: false, reason: classifyProbeCreateError(error) };
		}

		try {
			return await this.resolveDirectoryInProbe(container, candidatePath);
		} finally {
			// This container genuinely exists on the daemon now - a failed removal here would leak a real
			// container. Logged rather than swallowed so the leak is discoverable; `PROBE_LABEL` also lets
			// `reconcileOrphans` sweep it on next startup.
			await container.remove().catch((error: Error) => {
				console.warn(`Could not remove dev-folder probe container ${container.id}: ${error.message}`);
			});
		}
	}

	/** The component walk `probeDevFolder`'s doc comment describes, against an already-created probe
	 * container. Restarts from the link's target whenever a component turns out to be a symlink, bounded
	 * by `MAX_SYMLINK_HOPS`. */
	private async resolveDirectoryInProbe(
		container: Docker.Container,
		candidatePath: string,
	): Promise<DevFolderProbeOutcome> {
		let pending = candidatePath.split('/').filter((component) => component !== '');
		let resolved = '';
		let hops = 0;
		let stat: ProbeStat | undefined;
		while (pending.length > 0) {
			const [component, ...rest] = pending;
			const current = `${resolved}/${component}`;
			const outcome = await statInProbe(container, `${PROBE_MOUNT_TARGET}${current}`);
			if (!outcome.ok) return outcome;
			stat = outcome.stat;
			if ((stat.mode & GO_MODE_SYMLINK) !== 0) {
				if (++hops > MAX_SYMLINK_HOPS || stat.linkTarget === '') return { ok: false, reason: 'unknown' };
				const target = hostPathOfLinkTarget(stat.linkTarget);
				// A relative target is relative to the link's own directory; an absolute one restarts at `/`.
				const base = target.startsWith('/') ? '' : resolved;
				const normalized = path.posix.normalize(`${base}/${target}`);
				pending = [...normalized.split('/').filter((part) => part !== ''), ...rest];
				resolved = '';
				continue;
			}
			resolved = current;
			pending = rest;
		}
		// `/` itself (no components) stats the mount root, which is always a directory.
		if (!stat) {
			const outcome = await statInProbe(container, PROBE_MOUNT_TARGET);
			if (!outcome.ok) return outcome;
			stat = outcome.stat;
		}
		return (stat.mode & GO_MODE_DIR) !== 0 ? { ok: true } : { ok: false, reason: 'not-a-directory' };
	}

	/** `graceSecs` is always passed to the engine explicitly, never left to its 10s default
	 * (`AbortRunOptions`). A container that already exited answers 304/409, swallowed like every other
	 * stop failure here. */
	async abortRun(runId: string, { graceSecs = 0 }: AbortRunOptions = {}): Promise<void> {
		const container = this.runContainers.get(runId);
		if (!container) return;
		if (graceSecs <= 0) {
			await container.kill().catch(() => undefined);
			return;
		}
		await container.stop({ t: graceSecs }).catch(() => undefined);
	}

	/** Imports the bundled sidecar rootfs (`docker import`, no network) once per process; an image already
	 * present under the content-hash tag is reused. */
	private async ensureBrowserViewerImage(): Promise<string> {
		if (this.browserViewerImageId) return this.browserViewerImageId;
		this.browserViewerImport ??= this.importBrowserViewerImage().catch((error) => {
			this.browserViewerImport = undefined;
			throw error;
		});
		const imageId = await this.browserViewerImport;
		this.browserViewerImageId = imageId;
		return imageId;
	}

	private async importBrowserViewerImage(): Promise<string> {
		let version: string;
		try {
			version = (await readFile(browserViewerVersionFilePath(), 'utf8')).trim();
		} catch (error) {
			throw new Error(
				`the runtime's browser-view sidecar payload is missing (${(error as Error).message}). Browser view ` +
					`needs the runtime to run from its own built image, not from source (e.g. \`pnpm dev\`).`,
			);
		}
		const tag = `${BROWSER_VIEWER_IMAGE_REPO}:${version}`;

		try {
			await this.docker.getImage(tag).inspect();
			return tag;
		} catch (error) {
			if (!hasStatusCode(error) || error.statusCode !== 404) throw error;
		}

		// A read error on the tar must reject the import, not surface as an unhandled stream error.
		const rootfs = createReadStream(browserViewerRootfsTarPath());
		let rootfsError: Error | undefined;
		rootfs.on('error', (error: Error) => {
			rootfsError = error;
		});
		// The tag travels inside `repo` (`name:tag`, which the Docker API allows) rather than as the separate
		// `tag` parameter: Podman 3.x ignores that parameter and would store the image as `:latest`.
		const stream = await this.docker.importImage(rootfs, { repo: tag });
		await new Promise<void>((resolve, reject) => {
			if (rootfsError) {
				reject(rootfsError);
				return;
			}
			rootfs.once('error', reject);
			this.docker.modem.followProgress(stream, (err: Error | null, res: Array<{ error?: string }>) => {
				if (err) {
					reject(err);
					return;
				}
				const errorLine = res.find((line) => line.error);
				if (errorLine) {
					reject(new Error(errorLine.error));
					return;
				}
				resolve();
			});
		});
		return tag;
	}

	/** A plain local volume, no tmpfs options: rootless Podman 3.x cannot mount a tmpfs volume at all
	 * ("cannot mount volumes without root privileges"), and Podman 5 rejects a sized one on a filesystem
	 * without project quota. It only ever holds one Unix socket. The Actor's Xvfb runs unprivileged and
	 * must be able to create that socket, so the directory must end up mode 1777: the sidecar image
	 * carries `/tmp/.X11-unix` with that mode (copied onto the empty volume when the sidecar, which mounts
	 * it first, starts) and its script chmods it again as root to be sure. Anything created here is
	 * removed again if a later step fails. */
	async startBrowserViewer(target: BrowserViewerTarget): Promise<BrowserViewerHandle> {
		if (!this.available) {
			throw new Error(this.unavailableReason ?? 'Docker is not available');
		}
		const imageId = await this.ensureBrowserViewerImage();

		const volumeName = `actor-runtime-x11-${target.runId}`;
		const containerName = `actor-runtime-browser-viewer-${target.runId}`;
		const labels = { [RUN_LABEL]: target.runId, [BROWSER_VIEWER_LABEL]: 'true' };

		await this.docker.createVolume({ Name: volumeName, Driver: 'local', Labels: labels });

		// How the console reaches the sidecar's VNC server. Normally the sidecar joins `apify-local` and is
		// reached by its address there. When this process runs in a container that is not on that network
		// (`onActorNetwork`'s doc comment - rootless Podman; or Podman 3.x, where Actors never use it), the
		// sidecar shares this container's own network namespace instead, so the console reaches it on
		// localhost; every sidecar then needs a port of its own in that shared namespace, allocated here.
		const selfContainerId = process.env.HOSTNAME;
		const sharesRuntimeNetns = (!this.onActorNetwork || this.actorsOnDefaultNetwork) && !!selfContainerId;
		const vncPort = sharesRuntimeNetns ? await allocateFreePort() : BROWSER_VIEWER_VNC_PORT;

		let container: Docker.Container | undefined;
		try {
			container = await this.docker.createContainer({
				Image: imageId,
				name: containerName,
				Cmd: ['/bin/sh', BROWSER_VIEWER_SCRIPT],
				Env: [
					`${BROWSER_VIEWER_INTERACTIVE_ENV}=${target.interactive ? '1' : '0'}`,
					`${BROWSER_VIEWER_PORT_ENV}=${vncPort}`,
				],
				Labels: labels,
				HostConfig: {
					...(sharesRuntimeNetns
						? { NetworkMode: `container:${selfContainerId}` }
						: this.actorsOnDefaultNetwork
							? {}
							: { NetworkMode: NETWORK_NAME }),
					...(this.resourceLimits.memory ? { Memory: BROWSER_VIEWER_MEMORY_BYTES } : {}),
					AutoRemove: false,
					Mounts: [{ Type: 'volume', Source: volumeName, Target: X11_SOCKET_DIR }],
				},
				Tty: false,
			});
			this.browserViewers.set(target.runId, { container, volumeName });
			await container.start();

			if (sharesRuntimeNetns) {
				return { vncHost: '127.0.0.1', vncPort, x11SocketVolume: volumeName };
			}
			const info = await container.inspect();
			const address = containerAddress(info, this.actorsOnDefaultNetwork ? undefined : NETWORK_NAME);
			return {
				// The IP also works from a runtime running outside Docker; the name only resolves from inside.
				vncHost: address || containerName,
				vncPort,
				x11SocketVolume: volumeName,
			};
		} catch (error) {
			this.browserViewers.delete(target.runId);
			if (container) await container.remove({ force: true }).catch(() => undefined);
			await this.removeVolumeWithRetry(volumeName);
			throw error;
		}
	}

	async stopBrowserViewer(runId: string): Promise<void> {
		const viewer = this.browserViewers.get(runId);
		if (!viewer) return;
		this.browserViewers.delete(runId);
		await viewer.container.remove({ force: true }).catch(() => undefined);
		await this.removeVolumeWithRetry(viewer.volumeName);
	}

	/** Best-effort: a 404 is success, the last failure is logged, never thrown. */
	private async removeVolumeWithRetry(volumeName: string): Promise<void> {
		const volume = this.docker.getVolume(volumeName);
		for (let attempt = 1; ; attempt++) {
			try {
				await volume.remove({ force: true });
				return;
			} catch (error) {
				if (hasStatusCode(error) && error.statusCode === 404) return;
				if (attempt >= VOLUME_REMOVE_ATTEMPTS) {
					console.warn(`Could not remove browser-view volume ${volumeName}: ${(error as Error).message}`);
					return;
				}
				await new Promise((resolve) => setTimeout(resolve, VOLUME_REMOVE_RETRY_MS));
			}
		}
	}

	/**
	 * Cleans up two kinds of leftover containers from a previous process: orphaned *run* containers
	 * (builds never create one of their own - orphaned build *records* are still marked `ABORTED` by
	 * `reconcileOrphanedJobs` in `services/runs.ts`, independent of this method), and any dev-folder
	 * probe container that outlived its own removal call (`probeDevFolder`'s `PROBE_LABEL`) - the latter
	 * swept unconditionally, since a leftover probe is never a container anything still needs.
	 *
	 * Queries once per label *key*, each query carrying exactly one value under `label`, then matches
	 * `runIds` against each container's own label client-side - deliberately not one query with
	 * `{ label: [RUN_LABEL, PROBE_LABEL] } }`. Docker's daemon-side label filter ANDs multiple values
	 * given for the same key (moby's `api/types/filters`: `MatchKVList`), so a single query carrying both
	 * label keys would require one container to match both simultaneously - never true, silently matching
	 * nothing. Issuing one single-value query per key and unioning the results client-side (de-duplicated
	 * by container `Id`, in case a container is ever matched by both queries) avoids depending on that
	 * cross-key semantics at all.
	 */
	async reconcileOrphans(runIds: string[]): Promise<void> {
		if (!this.available) return;
		const runIdSet = new Set(runIds);

		const [runLabelled, probeLabelled, viewerLabelled] = await Promise.all([
			this.docker.listContainers({ all: true, filters: JSON.stringify({ label: [RUN_LABEL] }) }),
			this.docker.listContainers({ all: true, filters: JSON.stringify({ label: [PROBE_LABEL] }) }),
			this.docker.listContainers({ all: true, filters: JSON.stringify({ label: [BROWSER_VIEWER_LABEL] }) }),
		]);
		const byId = new Map<string, Docker.ContainerInfo>();
		for (const info of [...runLabelled, ...probeLabelled, ...viewerLabelled]) byId.set(info.Id, info);

		for (const info of byId.values()) {
			const isOrphanedRun = runIdSet.has(info.Labels?.[RUN_LABEL] ?? '');
			const isLeftoverProbe = info.Labels?.[PROBE_LABEL] !== undefined;
			// Swept unconditionally, like a probe.
			const isLeftoverViewer = info.Labels?.[BROWSER_VIEWER_LABEL] !== undefined;
			if (!isOrphanedRun && !isLeftoverProbe && !isLeftoverViewer) continue;
			const container = this.docker.getContainer(info.Id);
			// `{ v: true }` alongside `force: true`: an orphaned run's anonymous `node_modules` volume (if
			// it had a `devMount`) must not survive reconciliation either (mirrors `startRun`'s finally
			// block's identical fix).
			await container.remove({ force: true, v: true }).catch(() => undefined);
		}

		// Named volumes are not covered by `{ v: true }` above.
		const { Volumes: viewerVolumes } = await this.docker.listVolumes({
			filters: JSON.stringify({ label: [BROWSER_VIEWER_LABEL] }),
		});
		for (const volume of viewerVolumes ?? []) {
			await this.removeVolumeWithRetry(volume.Name);
		}
		const { Volumes: devVolumes } = await this.docker.listVolumes({
			filters: JSON.stringify({ name: [DEV_NODE_MODULES_VOLUME_PREFIX] }),
		});
		for (const volume of devVolumes ?? []) {
			if (volume.Name.startsWith(DEV_NODE_MODULES_VOLUME_PREFIX)) await this.removeVolumeWithRetry(volume.Name);
		}
	}
}
