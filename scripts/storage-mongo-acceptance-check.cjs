/* eslint-disable @typescript-eslint/no-require-imports */

const USER_CONFIRMED_ARGUMENT = '--user-confirmed';

function writeJson(stream, value) {
  stream.write(`${JSON.stringify(value, null, 2)}\n`);
}

function parseArguments(argv) {
  const unknown = argv.filter(argument => argument !== USER_CONFIRMED_ARGUMENT);
  const confirmationCount = argv.filter(
      argument => argument === USER_CONFIRMED_ARGUMENT,
  ).length;

  if (unknown.length > 0 || confirmationCount > 1) {
    return {
      valid: false,
      userConfirmed: false,
    };
  }

  return {
    valid: true,
    userConfirmed: confirmationCount === 1,
  };
}

function safeFailureCode(error) {
  if (
      error
      && typeof error === 'object'
      && typeof error.code === 'string'
      && /^[A-Z0-9_]{1,96}$/.test(error.code)
  ) {
    return error.code;
  }
  return 'MONGO_ACCEPTANCE_CHECK_FAILED';
}

function main() {
  const parsed = parseArguments(process.argv.slice(2));
  if (!parsed.valid) {
    writeJson(process.stderr, {
      status: 'NOT_RUN',
      ready: false,
      realIsolatedMongoAcceptance: 'NOT_RUN',
      errorCode: 'MONGO_ACCEPTANCE_ARGUMENT_UNKNOWN',
    });
    process.exitCode = 1;
    return;
  }

  try {
    // Load TypeScript and the acceptance evaluator only after CLI validation.
    // This path performs configuration validation only; it must not initialize
    // MongoClient or attempt a network connection.
    require('./register-typescript.cjs');
    const {
      evaluateMongoAcceptanceSafety,
    } = require('../src/lib/storage/mongoAcceptanceSafety.ts');

    const result = evaluateMongoAcceptanceSafety(
        process.env,
        parsed.userConfirmed,
    );
    writeJson(process.stdout, result);
  } catch (error) {
    // Never print the exception message, stack, URI, credentials, or the
    // environment. The stable code is sufficient for operator diagnostics.
    writeJson(process.stderr, {
      status: 'NOT_RUN',
      ready: false,
      realIsolatedMongoAcceptance: 'NOT_RUN',
      errorCode: safeFailureCode(error),
    });
    process.exitCode = 1;
  }
}

main();
