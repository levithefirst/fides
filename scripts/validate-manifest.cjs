// Offline manifest schema check using @forge/manifest (the package the
// Forge CLI uses). `forge lint` needs a login; this does not.
const { validate } = require('@forge/manifest');
validate(false, 'manifest.yml').then((r) => {
  for (const e of r.errors || []) console.log(`${e.level}: ${e.message} (line ${e.line ?? '?'})`);
  console.log(r.success ? 'manifest.yml: valid' : 'manifest.yml: INVALID');
  process.exit(r.success ? 0 : 1);
});
