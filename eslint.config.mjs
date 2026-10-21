// Not submitted for n8n Cloud verification, whose extra rules (no imports of npm libraries, no
// setTimeout) would forbid the Pub/Sub client this node is built on.
import { configWithoutCloudSupport } from '@n8n/node-cli/eslint';

export default [
	...configWithoutCloudSupport,
	{
		// Published as a team package with no personal contact address. Re-enable once a team email
		// exists for `author.email` in package.json.
		files: ['package.json'],
		rules: { '@n8n/community-nodes/valid-author': 'off' },
	},
];
