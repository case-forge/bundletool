/**
 * BundleTool test harness: hook registration. The Node compatibility shim itself is
 * scripts/node-compat.mjs, which scripts/build-cli.mjs shares; this file loads it for
 * `npm test`'s `--import ./tests/register-hooks.mjs`.
 */
import '../scripts/node-compat.mjs';
