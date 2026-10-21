import type {
	ICredentialDataDecryptedObject,
	ICredentialsDecrypted,
	ICredentialTestFunctions,
	IDataObject,
	INodeCredentialTestResult,
	INodeType,
	INodeTypeDescription,
	IRun,
	ITriggerFunctions,
	ITriggerResponse,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import PubSubApiClient from 'salesforce-pubsub-api-client';

import type { Logger, PubSubClient, SfEvent, StartFrom } from './flow';
import { createSubscription, toJsonSafe, toTopic } from './flow';

function clientConfig(creds: ICredentialDataDecryptedObject) {
	const loginUrl = String(creds.loginUrl ?? '').replace(/\/+$/, '');
	if (creds.authType === 'usernamePassword') {
		return {
			authType: 'username-password',
			loginUrl,
			username: creds.username as string,
			password: creds.password as string,
			userToken: (creds.securityToken as string) || '',
		};
	}
	return {
		authType: 'oauth-client-credentials',
		loginUrl,
		clientId: creds.clientId as string,
		clientSecret: creds.clientSecret as string,
	};
}

// The Pub/Sub client wraps the real reason ("invalid_client_id", a TLS or gRPC error) in `cause`;
// surface the whole chain so the n8n UI shows something actionable.
function errorText(error: unknown): string {
	const parts: string[] = [];
	let e = error as { message?: string; cause?: unknown } | undefined;
	for (let depth = 0; e && depth < 5; depth++) {
		if (e.message && !parts.includes(e.message)) parts.push(e.message);
		e = e.cause as typeof e;
	}
	return parts.join(': ') || String(error);
}

function toItem(topic: string, event: SfEvent): IDataObject {
	return toJsonSafe({
		topic,
		eventName: topic.split('/').pop(),
		replayId: String(event.replayId),
		eventUuid: event.id ?? null,
		payload: event.payload,
		receivedAt: new Date().toISOString(),
	}) as IDataObject;
}

export class SalesforcePubSubTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Salesforce Pub/Sub Trigger',
		name: 'salesforcePubSubTrigger',
		icon: { light: 'file:salesforce.svg', dark: 'file:salesforce.svg' },
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["event"]}}',
		description: 'Starts the workflow once per Salesforce platform event, via the Pub/Sub API',
		defaults: { name: 'Salesforce Pub/Sub Trigger' },
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'salesforcePubSubApi', required: true, testedBy: 'salesforcePubSubConnect' }],
		eventTriggerDescription: 'Waiting for a Salesforce event',
		activationMessage: 'Subscribed. Each platform event now starts one run of this workflow, in order.',
		properties: [
			{
				displayName: 'Event',
				name: 'event',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'Order_Event__e',
				description:
					'Platform event API name, or a full channel path such as /event/Order_Event__e. The credential user needs Read access to it.',
			},
			{
				displayName: 'Start From',
				name: 'startFrom',
				type: 'options',
				options: [
					{ name: 'Latest', value: 'latest', description: 'Only events published from now on' },
					{
						name: 'Earliest Retained',
						value: 'earliest',
						description: 'Everything still retained by Salesforce (up to 72 hours)',
					},
					{ name: 'After a Replay ID', value: 'replayId' },
				],
				default: 'latest',
				description:
					'Used only the first time. Afterwards the trigger resumes after the last event it processed, including across restarts.',
			},
			{
				displayName: 'Replay ID',
				name: 'replayId',
				type: 'string',
				default: '',
				required: true,
				description: 'Events published after this replay ID are delivered',
				displayOptions: { show: { startFrom: ['replayId'] } },
			},
			{
				displayName: 'Batch Size',
				name: 'batchSize',
				type: 'number',
				typeOptions: { minValue: 1, maxValue: 100 },
				default: 100,
				description:
					'Events requested from Salesforce at a time. The next batch is requested only after this one has been processed.',
			},
		],
	};

	methods = {
		credentialTest: {
			// Logs in and opens the Pub/Sub channel, i.e. exactly what activation does first.
			async salesforcePubSubConnect(
				this: ICredentialTestFunctions,
				credential: ICredentialsDecrypted,
			): Promise<INodeCredentialTestResult> {
				const quiet = { debug() {}, info() {}, warn() {}, error() {} };
				const client = new PubSubApiClient(
					clientConfig(credential.data ?? {}) as never,
					quiet,
				) as unknown as PubSubClient;
				try {
					await client.connect();
					return { status: 'OK', message: 'Logged in to Salesforce and connected to the Pub/Sub API' };
				} catch (error) {
					return { status: 'Error', message: errorText(error) };
				} finally {
					try {
						client.close();
					} catch {
						// nothing to clean up if connect never got a channel
					}
				}
			},
		},
	};

	async trigger(this: ITriggerFunctions): Promise<ITriggerResponse> {
		const node = this.getNode();
		const creds = await this.getCredentials('salesforcePubSubApi');
		let topic: string;
		try {
			topic = toTopic(this.getNodeParameter('event') as string);
		} catch (error) {
			throw new NodeOperationError(node, error as Error);
		}
		const startFrom = this.getNodeParameter('startFrom', 'latest') as StartFrom;
		const batchSize = Math.min(100, Math.max(1, Number(this.getNodeParameter('batchSize', 100)) || 100));
		let startReplayId: number | undefined;
		if (startFrom === 'replayId') {
			startReplayId = Number(this.getNodeParameter('replayId'));
			if (!Number.isSafeInteger(startReplayId) || startReplayId < 0) {
				throw new NodeOperationError(node, 'Replay ID must be a whole number');
			}
		}

		const logger: Logger = {
			debug: (m) => this.logger.debug(m),
			info: (m) => this.logger.info(m),
			warn: (m) => this.logger.warn(m),
			error: (m) => this.logger.error(m),
		};
		// The library logs every batch at info; keep that at debug so n8n's log stays readable.
		const libLogger = { ...logger, info: logger.debug };
		const createClient = () =>
			new PubSubApiClient(clientConfig(creds) as never, libLogger) as unknown as PubSubClient;

		if (this.getMode() === 'manual') {
			// "Listen for test event": take the next event published, then disconnect.
			let client: PubSubClient | undefined;
			const manualTriggerFunction = async () => {
				client = createClient();
				await client.connect();
				const c = client;
				await new Promise<void>((resolve, reject) => {
					c.subscribe(
						topic,
						(_info, type, data) => {
							if (type === 'event') {
								this.emit([this.helpers.returnJsonArray([toItem(topic, data as SfEvent)])]);
								resolve();
							} else if (type === 'error' || type === 'end') {
								reject(new NodeOperationError(node, `Pub/Sub subscription to ${topic} failed`, {
									description: data ? String((data as Error).message ?? data) : undefined,
								}));
							}
						},
						1,
					);
				});
				c.close();
			};
			return { manualTriggerFunction, closeFunction: async () => client?.close() };
		}

		// Position per topic: changing the Event parameter starts fresh instead of reusing another topic's ID.
		const staticData = this.getWorkflowStaticData('node');
		const positionKey = `replayId:${topic}`;

		const subscription = createSubscription({
			topic,
			batchSize,
			startFrom,
			startReplayId,
			createClient,
			logger,
			loadPosition: () => {
				const saved = Number(staticData[positionKey]);
				return Number.isSafeInteger(saved) && saved > 0 ? saved : undefined;
			},
			// n8n persists static data on the next emit, so after a restart at most the last event repeats.
			savePosition: (replayId) => {
				staticData[positionKey] = String(replayId);
			},
			handle: async (event) => {
				const done = this.helpers.createDeferredPromise<IRun>();
				this.emit([this.helpers.returnJsonArray([toItem(topic, event)])], undefined, done);
				const run = await done.promise;
				if (run?.data?.resultData?.error) {
					logger.warn(`${topic}: workflow run for replay ID ${event.replayId} failed; continuing with the next event`);
				}
			},
		});

		try {
			await subscription.start();
		} catch (error) {
			subscription.stop();
			throw new NodeOperationError(node, `Could not subscribe to ${topic}`, {
				description: errorText(error),
			});
		}

		return { closeFunction: async () => subscription.stop() };
	}
}
