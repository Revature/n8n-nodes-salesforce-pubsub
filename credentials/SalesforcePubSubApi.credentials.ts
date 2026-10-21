import type { ICredentialType, INodeProperties } from 'n8n-workflow';

// Not an HTTP credential: the Pub/Sub client performs the login itself (gRPC), so there is
// no `authenticate` block. A wrong value surfaces as an activation error on the trigger.
export class SalesforcePubSubApi implements ICredentialType {
	name = 'salesforcePubSubApi';

	displayName = 'Salesforce Pub/Sub API';

	icon = 'file:../nodes/SalesforcePubSubTrigger/salesforce.svg' as const;

	documentationUrl = 'https://developer.salesforce.com/docs/platform/pub-sub-api/guide/supported-auth.html';

	properties: INodeProperties[] = [
		{
			displayName: 'Authentication',
			name: 'authType',
			type: 'options',
			options: [
				{
					name: 'OAuth 2.0 Client Credentials',
					value: 'clientCredentials',
					description: 'Connected app with the client credentials flow enabled (recommended)',
				},
				{
					name: 'Username and Password',
					value: 'usernamePassword',
					description: 'SOAP login; no connected app needed. Salesforce is retiring SOAP login.',
				},
			],
			default: 'clientCredentials',
		},
		{
			displayName: 'Login URL',
			name: 'loginUrl',
			type: 'string',
			default: '',
			placeholder: 'https://yourcompany.my.salesforce.com',
			description:
				'Your My Domain URL (client credentials only issues tokens there). For username and password, https://login.salesforce.com or https://test.salesforce.com also work.',
			required: true,
		},
		{
			displayName: 'Client ID',
			name: 'clientId',
			type: 'string',
			default: '',
			required: true,
			displayOptions: { show: { authType: ['clientCredentials'] } },
		},
		{
			displayName: 'Client Secret',
			name: 'clientSecret',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			displayOptions: { show: { authType: ['clientCredentials'] } },
		},
		{
			displayName: 'Username',
			name: 'username',
			type: 'string',
			default: '',
			required: true,
			displayOptions: { show: { authType: ['usernamePassword'] } },
		},
		{
			displayName: 'Password',
			name: 'password',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			displayOptions: { show: { authType: ['usernamePassword'] } },
		},
		{
			displayName: 'Security Token',
			name: 'securityToken',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			description: 'Leave empty if the login IP is trusted in Salesforce',
			displayOptions: { show: { authType: ['usernamePassword'] } },
		},
	];
}
