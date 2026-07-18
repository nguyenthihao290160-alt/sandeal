/* eslint-disable @typescript-eslint/no-require-imports */
require('./register-typescript.cjs');

const { evaluateMongoAcceptanceSafety } = require('../src/lib/storage/mongoAcceptanceSafety.ts');

const args = process.argv.slice(2);
if (args.some(argument => argument !== '--user-confirmed')) {
  console.error(JSON.stringify({ status: 'NOT_RUN', errorCode: 'MONGO_ACCEPTANCE_ARGUMENT_UNKNOWN' }));
  process.exitCode = 1;
} else {
  const result = evaluateMongoAcceptanceSafety(process.env, args.includes('--user-confirmed'));
  console.log(JSON.stringify(result, null, 2));
}

