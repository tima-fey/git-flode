// Initialize only the disposable HA instance defined in compose.yaml.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';

const base = 'http://127.0.0.1:18123';
const runtime = new URL('./runtime/', import.meta.url);
const tokenFile = new URL('token', runtime);

async function request(route, body, token, form = false) {
  const response = await fetch(`${base}${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined
        ? {}
        : { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json' }),
    },
    ...(body === undefined
      ? {}
      : { body: form ? new URLSearchParams(body) : JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${route}: HTTP ${response.status}`);
  return response.json();
}

await fs.mkdir(runtime, { recursive: true });
let token;
try {
  token = (await fs.readFile(tokenFile, 'utf8')).trim();
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  const steps = await request('/api/onboarding');
  if (steps.find((step) => step.step === 'user')?.done)
    throw new Error(
      'Test HA already has a user but no local token. Use its login or a fresh runtime.'
    );
  const password = randomBytes(24).toString('base64url');
  const user = { name: 'FLODE Test', username: 'flode_test', password };
  // Keep the disposable login private and outside version control.
  await fs.writeFile(new URL('credentials.json', runtime), JSON.stringify(user), { mode: 0o600 });
  const { auth_code: code } = await request('/api/onboarding/users', {
    ...user,
    client_id: `${base}/`,
    language: 'en',
  });
  const tokens = await request(
    '/auth/token',
    { grant_type: 'authorization_code', code, client_id: `${base}/` },
    undefined,
    true
  );
  token = tokens.access_token;
  // Store the refresh token as well for this disposable instance.
  await fs.writeFile(new URL('auth.json', runtime), JSON.stringify(tokens), { mode: 0o600 });
  for (const step of ['core_config', 'analytics'])
    await request(`/api/onboarding/${step}`, {}, token);
  await request(
    '/api/onboarding/integration',
    { client_id: `${base}/`, redirect_uri: `${base}/` },
    token
  );
  const socket = new WebSocket(`${base.replace('http', 'ws')}/api/websocket`);
  token = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('Test token creation timed out'));
    }, 15000);
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error('Test HA WebSocket failed'));
    };
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      if (message.type === 'auth_required')
        socket.send(JSON.stringify({ type: 'auth', access_token: token }));
      if (message.type === 'auth_ok')
        socket.send(
          JSON.stringify({
            id: 1,
            type: 'auth/long_lived_access_token',
            client_name: 'FLODE container tests',
            lifespan: 365,
          })
        );
      if (message.id === 1 || message.type === 'auth_invalid') {
        clearTimeout(timer);
        socket.close();
        if (message.success) resolve(message.result);
        else reject(new Error('Test token creation rejected'));
      }
    };
  });
  await fs.writeFile(tokenFile, token, { mode: 0o600 });
}

const entries = await request('/api/config/config_entries/entry', undefined, token);
if (!entries.some((entry) => entry.domain === 'flode')) {
  const flow = await request(
    '/api/config/config_entries/flow',
    { handler: 'flode', show_advanced_options: false },
    token
  );
  const result = await request(`/api/config/config_entries/flow/${flow.flow_id}`, {}, token);
  if (result.type !== 'create_entry')
    throw new Error(`Unexpected FLODE setup result: ${result.type}`);
}
console.log(
  `Test HA initialized: ${base}/flode (credentials and token stored privately in runtime/)`
);
