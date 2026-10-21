// Run with: npm test  (node --test, using Node's built-in TypeScript type stripping)
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	createSubscription,
	toJsonSafe,
	toTopic,
	type PubSubClient,
	type SfEvent,
	type SubscribeCallback,
	type SubscriptionOptions,
} from '../nodes/SalesforcePubSubTrigger/flow.ts';

class FakeClient implements PubSubClient {
	cb: SubscribeCallback | undefined;
	calls: string[] = [];
	closed = false;
	async connect() {
		this.calls.push('connect');
	}
	subscribe(_t: string, cb: SubscribeCallback, n: number) {
		this.cb = cb;
		this.calls.push(`subscribe:latest:${n}`);
	}
	subscribeFromEarliestEvent(_t: string, cb: SubscribeCallback, n: number) {
		this.cb = cb;
		this.calls.push(`subscribe:earliest:${n}`);
	}
	subscribeFromReplayId(_t: string, cb: SubscribeCallback, n: number, replayId: number) {
		this.cb = cb;
		this.calls.push(`subscribe:after:${replayId}:${n}`);
	}
	requestAdditionalEvents(_t: string, n: number) {
		this.calls.push(`more:${n}`);
	}
	close() {
		this.closed = true;
	}
	send(type: string, data?: unknown) {
		this.cb?.({}, type, data);
	}
}

const ev = (replayId: number): SfEvent => ({ id: `uuid-${replayId}`, replayId, payload: { n: replayId } });
const quiet = { debug() {}, info() {}, warn() {}, error() {} };

function harness(over: Partial<SubscriptionOptions> = {}) {
	const clients: FakeClient[] = [];
	const handled: number[] = [];
	const store: { pos?: number } = {};
	const sub = createSubscription({
		topic: '/event/Test__e',
		batchSize: 2,
		startFrom: 'latest',
		createClient: () => {
			const c = new FakeClient();
			clients.push(c);
			return c;
		},
		loadPosition: () => store.pos,
		savePosition: (id) => {
			store.pos = id;
		},
		handle: async (e) => {
			handled.push(e.replayId);
		},
		logger: quiet,
		sleep: async () => {},
		...over,
	});
	return { sub, clients, handled, store };
}

test('processes events in order and asks for the next batch only after the batch drains', async () => {
	const order: string[] = [];
	const { sub, clients, store } = harness({
		handle: async (e) => {
			await new Promise((r) => setTimeout(r, 5));
			order.push(`done:${e.replayId}`);
		},
	});
	await sub.start();
	const c = clients[0];
	c.send('event', ev(1));
	c.send('event', ev(2));
	c.send('lastEvent');
	await sub.idle();
	assert.deepEqual(order, ['done:1', 'done:2']);
	assert.deepEqual(c.calls, ['connect', 'subscribe:latest:2', 'more:2']);
	assert.equal(store.pos, 2);
});

test('a failed workflow run still advances the position', async () => {
	const { sub, clients, store } = harness({
		handle: async () => {
			throw new Error('boom');
		},
	});
	await sub.start();
	clients[0].send('event', ev(7));
	await sub.idle();
	assert.equal(store.pos, 7);
});

test('resumes after the saved replay ID on start and after a dropped stream', async () => {
	const { sub, clients, store } = harness();
	store.pos = 41;
	await sub.start();
	assert.ok(clients[0].calls.includes('subscribe:after:41:2'));
	clients[0].send('event', ev(42));
	clients[0].send('end');
	clients[0].send('error', { message: 'also fires' }); // second signal for the same failure: ignored
	await sub.idle();
	assert.equal(clients.length, 2);
	assert.ok(clients[0].closed);
	assert.ok(clients[1].calls.includes('subscribe:after:42:2'));
});

test('events from a replaced client are ignored (they are redelivered after the resume)', async () => {
	const { sub, clients, handled } = harness();
	await sub.start();
	clients[0].send('end');
	await sub.idle();
	clients[0].send('event', ev(5));
	clients[1].send('event', ev(5));
	await sub.idle();
	assert.deepEqual(handled, [5]);
});

test('a rejected replay ID falls back to latest', async () => {
	const { sub, clients, store } = harness();
	store.pos = 10;
	await sub.start();
	clients[0].send('error', { details: 'The Replay ID validation failed' });
	await sub.idle();
	assert.ok(clients[1].calls.includes('subscribe:latest:2'));
});

test('an unparseable event is skipped and its replay ID saved', async () => {
	const { sub, clients, store, handled } = harness();
	await sub.start();
	clients[0].send('error', { message: 'Failed to parse', replayId: 9, latestReplayId: 9 });
	await sub.idle();
	assert.deepEqual(handled, []);
	assert.equal(store.pos, 9);
	assert.equal(clients.length, 1);
});

test('stop closes the client and ignores later callbacks', async () => {
	const { sub, clients, handled } = harness();
	await sub.start();
	sub.stop();
	clients[0].send('event', ev(1));
	clients[0].send('end');
	await sub.idle();
	assert.ok(clients[0].closed);
	assert.deepEqual(handled, []);
	assert.equal(clients.length, 1);
});

test('a failed first connect rejects start (activation error)', async () => {
	const { sub } = harness({
		createClient: () => {
			const c = new FakeClient();
			c.connect = async () => {
				throw new Error('invalid_client_id');
			};
			return c;
		},
	});
	await assert.rejects(sub.start(), /invalid_client_id/);
});

test('toTopic normalizes names and rejects junk', () => {
	assert.equal(toTopic('Order_Event__e'), '/event/Order_Event__e');
	assert.equal(toTopic(' /event/Foo__e '), '/event/Foo__e');
	assert.equal(toTopic('AccountChangeEvent'), '/data/AccountChangeEvent');
	assert.throws(() => toTopic('../etc'));
	assert.throws(() => toTopic(''));
});

test('toJsonSafe stringifies BigInt at any depth', () => {
	assert.deepEqual(toJsonSafe({ a: 1n, b: [2n, { c: 3n }], d: 'x' }), { a: '1', b: ['2', { c: '3' }], d: 'x' });
});
