// Static builds use an explicit public origin; never echo an invalid input.
const value = process.env.VITE_BACKEND_URL;
let valid = false;
try {
  const url = new URL(value);
  valid = typeof value === 'string' && value === url.origin &&
    url.protocol === 'https:' && !url.username && !url.password && !!url.hostname;
} catch {}
if (!valid) {
  console.error('VITE_BACKEND_URL must be an explicit HTTPS origin without credentials, path, query or fragment.');
  process.exitCode = 1;
}
