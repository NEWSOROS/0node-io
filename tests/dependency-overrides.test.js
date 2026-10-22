import { expect, test } from 'bun:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// package.json overrides jayson to ^5 although web3.js 1.x still asks for ^4:
// jayson 5 drops the vulnerable stream-json chain. web3.js only uses jayson's
// browser client, so pin exactly the call it makes.
test('jayson override keeps the browser client contract used by web3.js', async () => {
  const ClientBrowser = require('jayson/lib/client/browser');
  const client = new ClientBrowser((body, callback) => {
    const { id, jsonrpc, method } = JSON.parse(body);
    callback(null, JSON.stringify({ jsonrpc, id, result: `${method}:ok` }));
  }, {});

  const response = await new Promise((resolve, reject) => {
    client.request('getHealth', [], (err, res) => (err ? reject(err) : resolve(res)));
  });
  expect(response.jsonrpc).toBe('2.0');
  expect(typeof response.id).toBe('string');
  expect(response.result).toBe('getHealth:ok');
});
