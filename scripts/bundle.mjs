// Runs after `n8n-node build`. Replaces the compiled trigger with a single self-contained bundle so
// the published package has NO runtime dependencies: what was tested is exactly what n8n runs, and
// nothing is resolved from npm when the package is installed.
import { build } from 'esbuild';
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const outDir = 'dist/nodes/SalesforcePubSubTrigger';
const outfile = path.join(outDir, 'SalesforcePubSubTrigger.node.js');
const require = createRequire(import.meta.url);
// The CommonJS build of the client. Left to itself esbuild resolves the ESM build (the source uses
// `import`), whose `import.meta.url` is empty in a CJS bundle -> "Failed to connect: Invalid URL".
const clientCjs = require.resolve('salesforce-pubsub-api-client');

const result = await build({
	alias: { 'salesforce-pubsub-api-client': clientCjs },
	entryPoints: ['nodes/SalesforcePubSubTrigger/SalesforcePubSubTrigger.node.ts'],
	outfile,
	bundle: true,
	platform: 'node',
	format: 'cjs',
	target: 'node20',
	external: ['n8n-workflow'], // provided by n8n itself
	legalComments: 'none', // licences are collected into THIRD_PARTY_LICENSES.txt below
	metafile: true,
	logLevel: 'warning',
});

// The Pub/Sub client reads its gRPC definition and CA bundle from next to its own code
// (`new URL('./x', 'file://' + __filename)`); once bundled, "its own code" is the node file.
const clientDir = path.dirname(clientCjs);
const assets = readdirSync(clientDir).filter((f) => /\.(proto|pem)$/.test(f));
if (assets.length < 2) throw new Error(`expected a .proto and a .pem in ${clientDir}, found: ${assets.join(', ')}`);
for (const f of assets) copyFileSync(path.join(clientDir, f), path.join(outDir, f));

// Every package that ended up in the bundle, with its licence text.
const packages = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
	const m = input.match(/node_modules\/((?:@[^/]+\/)?[^/]+)\//g);
	if (!m) continue;
	const rel = m.join('').replace(/\/$/, '');
	const name = m.at(-1).replace(/^node_modules\/|\/$/g, '');
	if (!packages.has(name)) packages.set(name, rel);
}
const sections = [...packages.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, dir]) => {
	const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
	const licenceFile = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
	const notice = readdirSync(dir).find((f) => /^notice(\.|$)/i.test(f));
	const text = [
		licenceFile ? readFileSync(path.join(dir, licenceFile), 'utf8').trim() : `License: ${pkg.license ?? 'see package'}`,
		notice ? `\n--- NOTICE ---\n${readFileSync(path.join(dir, notice), 'utf8').trim()}` : '',
	].join('');
	return `${'='.repeat(78)}\n${name}@${pkg.version} (${pkg.license ?? 'unknown'})\n${'='.repeat(78)}\n${text}\n`;
});
writeFileSync(
	'dist/THIRD_PARTY_LICENSES.txt',
	`Third-party software bundled into dist/nodes/SalesforcePubSubTrigger/SalesforcePubSubTrigger.node.js\n\n${sections.join('\n')}`,
);

if (!existsSync(outfile)) throw new Error('bundle was not written');
console.log(`bundled ${packages.size} packages into ${outfile}; copied ${assets.join(', ')}`);
