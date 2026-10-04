const fs = require('node:fs');
let calls = 0;
const idempotent = new Map();
global.fetch = async (url, options) => {
  if (String(url) !== 'https://api.resend.com/emails') throw Error('External request blocked in isolated tests');
  calls += 1;
  const body = JSON.parse(options.body);
  body._testHeaders = options.headers;
  fs.appendFileSync(process.env.MAIL_LOG, JSON.stringify(body) + '\n');
  const key = options.headers?.['Idempotency-Key'];
  const previous = key ? idempotent.get(key) : null;
  if (previous && previous.payload !== options.body) {
    return {
      ok: false,
      status: 409,
      async json() { return { name: 'invalid_idempotent_request' }; },
    };
  }
  const providerId = previous?.providerId || `test-provider-${calls}`;
  if (key && !previous) idempotent.set(key, { payload: options.body, providerId });
  const unknownCall = Number(process.env.TEST_MAIL_UNKNOWN_CALL || (process.env.TEST_MAIL_UNKNOWN_FIRST === 'true' ? 1 : 0));
  if (unknownCall > 0 && calls === unknownCall) {
    const err = new Error('simulated timeout after provider handoff');
    err.name = 'TimeoutError';
    throw err;
  }
  const fail = process.env.TEST_MAIL_FAIL === 'true'
    || (process.env.TEST_MAIL_FAIL_FIRST === 'true' && calls === 1);
  return {
    ok: !fail,
    status: fail ? 403 : 200,
    async json() { return fail ? {} : { id: providerId }; },
  };
};
