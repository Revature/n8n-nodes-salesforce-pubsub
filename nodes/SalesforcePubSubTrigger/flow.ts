// Subscription flow control, kept free of n8n imports so test/flow.test.ts can drive it with a
// fake client. Only erasable TypeScript here (no enums/param properties): the test runs this file
// through Node's built-in type stripping.

export type StartFrom = 'latest' | 'earliest' | 'replayId';

/** A parsed event as salesforce-pubsub-api-client delivers it. */
export interface SfEvent {
	id?: string;
	schemaId?: string;
	replayId: number;
	payload: Record<string, unknown>;
}

export type SubscribeCallback = (info: unknown, callbackType: string, data?: unknown) => void;

/** The slice of PubSubApiClient this module uses. */
export interface PubSubClient {
	connect(): Promise<void>;
	subscribe(topic: string, cb: SubscribeCallback, numRequested: number): unknown;
	subscribeFromEarliestEvent(topic: string, cb: SubscribeCallback, numRequested: number): unknown;
	subscribeFromReplayId(topic: string, cb: SubscribeCallback, numRequested: number, replayId: number): unknown;
	requestAdditionalEvents(topic: string, numRequested: number): void;
	close(): void;
}

export interface Logger {
	debug(message: string): void;
	info(message: string): void;
	warn(message: string): void;
	error(message: string): void;
}

export interface SubscriptionOptions {
	topic: string;
	batchSize: number;
	startFrom: StartFrom;
	startReplayId?: number;
	createClient: () => PubSubClient;
	loadPosition: () => number | undefined;
	savePosition: (replayId: number) => void;
	/** Resolves once the workflow run for this event has finished, whatever its outcome. */
	handle: (event: SfEvent) => Promise<void>;
	logger: Logger;
	sleep?: (ms: number) => Promise<void>;
	backoffMs?: number[];
}

export interface Subscription {
	/** First connect + subscribe. Rejects on failure so activation fails loudly (e.g. bad credentials). */
	start(): Promise<void>;
	stop(): void;
	/** Settles when queued work (events, batch requests, reconnects) has drained. For tests. */
	idle(): Promise<void>;
}

const DEFAULT_BACKOFF_MS = [5_000, 15_000, 30_000, 60_000, 300_000];

/** `Order_Event__e` → `/event/Order_Event__e`; full paths pass through. */
export function toTopic(input: string): string {
	const value = (input ?? '').trim();
	const topic = value.startsWith('/')
		? value
		: value.endsWith('ChangeEvent')
			? `/data/${value}`
			: `/event/${value}`;
	if (!/^\/(event|data)\/[A-Za-z][A-Za-z0-9_]*$/.test(topic)) {
		throw new Error(
			`"${input}" is not a platform event or channel name (expected e.g. Order_Event__e or /event/Order_Event__e)`,
		);
	}
	return topic;
}

/** Deep copy that turns BigInt into strings, so n8n can serialize the item. */
export function toJsonSafe(value: unknown): unknown {
	if (typeof value === 'bigint') return value.toString();
	if (Array.isArray(value)) return value.map(toJsonSafe);
	if (value && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) out[k] = toJsonSafe(v);
		return out;
	}
	return value;
}

function describe(err: unknown): string {
	if (!err) return 'unknown error';
	if (typeof err === 'object') {
		const e = err as { details?: string; message?: string };
		return e.details || e.message || String(err);
	}
	return String(err);
}

// Pub/Sub reports a replay ID outside the retention window (or otherwise unusable) as a stream error
// whose details mention the replay ID. Matching loosely is deliberate: a false positive only costs a
// fall back to "latest", and that is logged.
function isReplayIdError(err: unknown): boolean {
	return /replay\s*id/i.test(describe(err));
}

// EventParseError carries latestReplayId; a gRPC stream error does not.
function isParseError(data: unknown): data is { replayId?: number; message?: string } {
	return !!data && typeof data === 'object' && 'latestReplayId' in data;
}

export function createSubscription(o: SubscriptionOptions): Subscription {
	const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const backoff = o.backoffMs ?? DEFAULT_BACKOFF_MS;
	let stopped = false;
	let client: PubSubClient | undefined;
	let generation = 0; // bumped on every (re)connect; callbacks from an older client are ignored
	let attempt = 0;
	let ignoreSaved = false; // set when the saved replay ID was rejected, until a new event is saved
	let chain: Promise<void> = Promise.resolve(); // every event / batch request / reconnect runs in order

	const enqueue = (work: () => Promise<void> | void) => {
		chain = chain.then(work).catch((err) => o.logger.error(`${o.topic}: ${describe(err)}`));
	};

	const closeClient = () => {
		try {
			client?.close();
		} catch (err) {
			o.logger.warn(`${o.topic}: error while closing the Pub/Sub client: ${describe(err)}`);
		}
		client = undefined;
	};

	const processEvent = async (event: SfEvent) => {
		if (stopped) return;
		try {
			await o.handle(event);
		} catch (err) {
			// The position still advances: one bad event must not block the topic forever.
			o.logger.error(`${o.topic}: workflow run for replay ID ${event.replayId} failed: ${describe(err)}`);
		}
		o.savePosition(event.replayId);
		ignoreSaved = false;
	};

	const callbackFor =
		(gen: number): SubscribeCallback =>
		(_info, type, data) => {
			if (stopped || gen !== generation) return;
			switch (type) {
				case 'event':
					attempt = 0;
					enqueue(() => processEvent(data as SfEvent));
					break;
				case 'lastEvent':
					// Ask for the next batch only after this one has been fully processed (backpressure).
					enqueue(() => {
						if (stopped || gen !== generation || !client) return;
						client.requestAdditionalEvents(o.topic, o.batchSize);
					});
					break;
				case 'grpcKeepalive':
					attempt = 0;
					break;
				case 'error':
					if (isParseError(data)) {
						o.logger.error(`${o.topic}: skipped an event Salesforce sent that could not be parsed: ${describe(data)}`);
						const replayId = data.replayId;
						if (typeof replayId === 'number') enqueue(() => o.savePosition(replayId));
					} else {
						reconnect(gen, data);
					}
					break;
				case 'end':
					reconnect(gen);
					break;
				default:
					o.logger.debug(`${o.topic}: ${type}`);
			}
		};

	const open = async () => {
		const gen = ++generation;
		closeClient();
		const c = o.createClient();
		client = c;
		await c.connect();
		if (stopped || gen !== generation) {
			c.close();
			return;
		}
		const cb = callbackFor(gen);
		const saved = ignoreSaved ? undefined : o.loadPosition();
		if (saved !== undefined) {
			o.logger.info(`${o.topic}: resuming after replay ID ${saved}`);
			await c.subscribeFromReplayId(o.topic, cb, o.batchSize, saved);
		} else if (o.startFrom === 'earliest') {
			await c.subscribeFromEarliestEvent(o.topic, cb, o.batchSize);
		} else if (o.startFrom === 'replayId' && o.startReplayId !== undefined) {
			await c.subscribeFromReplayId(o.topic, cb, o.batchSize, o.startReplayId);
		} else {
			await c.subscribe(o.topic, cb, o.batchSize);
		}
	};

	function reconnect(gen: number, err?: unknown) {
		if (stopped || gen !== generation) return; // a newer client is already being opened
		generation++; // drop anything the failed client still emits
		if (isReplayIdError(err)) {
			o.logger.warn(
				`${o.topic}: Salesforce rejected the saved replay ID (${describe(err)}); restarting from the latest event`,
			);
			ignoreSaved = true;
		} else {
			o.logger.warn(`${o.topic}: stream ${err ? `error: ${describe(err)}` : 'ended'}; reconnecting`);
		}
		const delay = backoff[Math.min(attempt, backoff.length - 1)];
		attempt++;
		enqueue(async () => {
			closeClient();
			await sleep(delay);
			if (stopped) return;
			try {
				await open();
			} catch (e) {
				reconnect(generation, e);
			}
		});
	}

	return {
		start: async () => {
			await open();
		},
		stop: () => {
			stopped = true;
			generation++;
			closeClient();
		},
		idle: async () => {
			// Drain until no new work was appended while waiting.
			let current: Promise<void>;
			do {
				current = chain;
				await current;
			} while (current !== chain);
		},
	};
}
