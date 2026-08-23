const assert = require("node:assert/strict");
const test = require("node:test");

const { preserveOperationalConfig } = require("../setup.cjs");

test("rerunning setup preserves valid operational preferences", () => {
  const config = {
    port: 43871,
    linkPreview: false,
    wakeMode: false,
    wakeDefaultCwd: "",
    wakeAllowedRoots: [],
    wakePiCommand: "pi",
    wakePiCommandArgs: [],
    wakeOpenTerminal: true,
  };

  preserveOperationalConfig(config, {
    port: 44000,
    linkPreview: true,
    wakeMode: true,
    wakeDefaultCwd: "F:\\",
    wakeAllowedRoots: ["F:\\"],
    wakePiCommand: "custom-pi",
    wakePiCommandArgs: ["--profile", "wake"],
    wakeOpenTerminal: false,
  });

  assert.deepEqual(config, {
    port: 44000,
    linkPreview: true,
    wakeMode: true,
    wakeDefaultCwd: "F:\\",
    wakeAllowedRoots: ["F:\\"],
    wakePiCommand: "custom-pi",
    wakePiCommandArgs: ["--profile", "wake"],
    wakeOpenTerminal: false,
  });
});

test("rerunning setup ignores invalid operational preferences", () => {
  const config = {
    port: 43871,
    linkPreview: false,
    wakeMode: false,
    wakeDefaultCwd: "",
    wakeAllowedRoots: [],
    wakePiCommand: "pi",
    wakePiCommandArgs: [],
    wakeOpenTerminal: true,
  };

  preserveOperationalConfig(config, {
    port: 0,
    linkPreview: "yes",
    wakeMode: 1,
    wakeDefaultCwd: null,
    wakeAllowedRoots: ["F:\\", 42],
    wakePiCommand: "",
    wakePiCommandArgs: [null],
    wakeOpenTerminal: "yes",
  });

  assert.deepEqual(config, {
    port: 43871,
    linkPreview: false,
    wakeMode: false,
    wakeDefaultCwd: "",
    wakeAllowedRoots: [],
    wakePiCommand: "pi",
    wakePiCommandArgs: [],
    wakeOpenTerminal: true,
  });
});
