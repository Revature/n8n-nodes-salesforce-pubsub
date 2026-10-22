// Fails if any package bundled into the node has a known vulnerability (OSV database, which
// aggregates GitHub, npm and other advisories). Only the bundle matters here: it is the code n8n
// runs. Build tooling is covered by dependency review on pull requests.
// Run after `npm run build`, which writes .bundle-packages.json.
import { readFileSync } from 'node:fs';

const packages = JSON.parse(readFileSync('.bundle-packages.json', 'utf8'));

async function osv(path, body) {
	const res = await fetch(`https://api.osv.dev/v1/${path}`, {
		method: body ? 'POST' : 'GET',
		headers: { 'Content-Type': 'application/json' },
		body: body && JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`OSV ${path}: HTTP ${res.status}`);
	return res.json();
}

let result;
try {
	result = await osv('querybatch', {
		queries: packages.map(({ name, version }) => ({ package: { name, ecosystem: 'npm' }, version })),
	});
} catch (error) {
	// Fail closed: an unanswered check must not read as a clean one.
	console.error(`Could not query OSV (${error.message}); failing rather than skipping the check.`);
	process.exit(2);
}

const hits = result.results.flatMap((r, i) => (r.vulns ?? []).map((v) => ({ pkg: packages[i], id: v.id })));
if (hits.length === 0) {
	console.log(`OSV: no known vulnerabilities in the ${packages.length} bundled packages.`);
	process.exit(0);
}

console.error(`OSV: ${hits.length} known vulnerabilit${hits.length === 1 ? 'y' : 'ies'} in bundled packages:`);
for (const { pkg, id } of hits) {
	const detail = await osv(`vulns/${id}`).catch(() => ({}));
	console.error(`  ${pkg.name}@${pkg.version}  ${id}  ${detail.summary ?? ''}`);
}
console.error('Update the dependency (or the client that pulls it in) and rebuild.');
process.exit(1);
