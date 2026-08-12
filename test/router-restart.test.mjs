import assert from "node:assert/strict";
import test from "node:test";

import {
  restartRouterServiceIfInstalled,
  routerServiceStatus,
} from "../src/router-restart.mjs";

const INSTALLED_STATUS = {
  status: 0,
  error: undefined,
  stdout: JSON.stringify({ installed: true, loaded: true, state: "running" }),
};
const NOT_INSTALLED_STATUS = { status: 1, error: undefined, stdout: "" };

test("routerServiceStatus reports an installed, loaded service", () => {
  const seen = [];
  const spawn = (command, args) => {
    seen.push({ command, args });
    return INSTALLED_STATUS;
  };
  assert.deepEqual(routerServiceStatus({ spawn }), {
    installed: true,
    loaded: true,
    state: "running",
  });
  assert.equal(seen.length, 1);
  assert.ok(seen[0].args.at(-1) === "status");
});

test("routerServiceStatus degrades to not-installed on an unusable probe", () => {
  for (const stdout of ["", "not json"]) {
    assert.deepEqual(routerServiceStatus({ spawn: () => ({ status: 0, error: undefined, stdout }) }), {
      installed: false,
    });
  }
  assert.deepEqual(
    routerServiceStatus({ spawn: () => ({ status: 1, error: undefined, stdout: "" }) }),
    { installed: false },
  );
});

test("restart is skipped when no background service is installed", () => {
  const calls = [];
  const spawn = (command, args) => {
    calls.push(args.at(-1));
    return NOT_INSTALLED_STATUS;
  };
  assert.equal(restartRouterServiceIfInstalled({ spawn }), false);
  assert.deepEqual(calls, ["status"]);
});

test("restart runs the service restart command when installed", () => {
  const calls = [];
  const spawn = (command, args) => {
    calls.push(args.at(-1));
    return args.at(-1) === "status"
      ? INSTALLED_STATUS
      : { status: 0, error: undefined, stdout: JSON.stringify({ state: "running" }) };
  };
  assert.equal(restartRouterServiceIfInstalled({ spawn }), true);
  assert.deepEqual(calls, ["status", "restart"]);
});

test("a failed restart fails loudly instead of pretending the route is live", () => {
  const spawn = (command, args) =>
    args.at(-1) === "status"
      ? INSTALLED_STATUS
      : { status: 1, error: undefined, stdout: "" };
  assert.throws(
    () => restartRouterServiceIfInstalled({ spawn }),
    /could not be restarted/,
  );
});
