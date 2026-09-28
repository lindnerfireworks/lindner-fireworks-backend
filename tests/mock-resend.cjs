const fs = require('node:fs');
let calls = 0;
global.fetch = async (url, options) => {
  if (String(url) !== 'https://api.resend.com/emails') throw Error('External request blocked in isolated tests');
  calls += 1;
  const body = JSON.parse(options.body);
  body._testHeaders = options.headers;
  fs.appendFileSync(process.env.MAIL_LOG, JSON.stringify(body) + '\n');
  if (process.env.TEST_MAIL_UNKNOWN_FIRST === 'true' && calls === 1) {
    const err = new Error('simulated timeout after provider handoff');
    err.name = 'TimeoutError';
    throw err;
  }
  const fail = process.env.TEST_MAIL_FAIL === 'true'
    || (process.env.TEST_MAIL_FAIL_FIRST === 'true' && calls === 1);
  return {
    ok: !fail,
    status: fail ? 403 : 200,
    async json() { return fail ? {} : { id: `test-provider-${calls}` }; },
  };
};
