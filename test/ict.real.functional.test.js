'use strict';

// Real hardware functional test: hits a live m1-rest-server instance and
// triggers one actual ICT run against connected hardware. Not part of the
// mocked unit suite — run explicitly:
//   node --test test/ict.real.functional.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const baseUrl = process.env.M1_REST_SERVER_URL || 'http://localhost:3300';
const serial = process.env.ICT_TEST_SERIAL || 'AI-ICT-SMOKE-TEST';

test('POST /command runs one real ICT test against connected hardware', async () => {
    const response = await fetch(`${baseUrl}/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            command: 'ict',
            argument: `-b new -s ${serial}`
        })
    });

    const result = await response.json();

    assert.equal(result.status, 'OK', `ICT test failed: ${result.ErrorDescription}`);
    assert.equal(result.errorCode, 0);
});
