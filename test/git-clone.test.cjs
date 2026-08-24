const assert = require("node:assert/strict");
const { mkdir, mkdtemp, realpath, rm } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  cloneRepository,
  formatCloneError,
  parseGitCloneCommand,
  remoteRepositoryName,
  validateDirectoryName,
  validateRemote,
} = require("../src/git-clone.cjs");

test("parses Telegram clone commands without accepting extra shell syntax", () => {
  assert.deepEqual(parseGitCloneCommand("/clone https://github.com/example/demo.git"), {
    remote: "https://github.com/example/demo.git",
    directory: "",
  });
  assert.deepEqual(parseGitCloneCommand("git clone git@github.com:example/demo.git demo-copy"), {
    remote: "git@github.com:example/demo.git",
    directory: "demo-copy",
  });
  assert.equal(parseGitCloneCommand("git clone https://example.test/repo.git && whoami"), undefined);
  assert.equal(parseGitCloneCommand("/clone"), undefined);
});

test("validates clone remotes and safe repository directory names", () => {
  assert.equal(validateRemote("ssh://git@example.com/team/demo.git"), "ssh://git@example.com/team/demo.git");
  assert.equal(remoteRepositoryName("https://github.com/example/demo.git"), "demo");
  assert.equal(remoteRepositoryName("git@github.com:example/demo.git"), "demo");
  assert.equal(validateDirectoryName("demo-copy_2"), "demo-copy_2");
  assert.throws(() => validateRemote("C:\\private\\repo"), /HTTPS, SSH, or git/);
  assert.throws(() => validateDirectoryName("../outside"), /safe single directory/);
  assert.throws(() => validateDirectoryName("NUL"), /safe single directory/);
});

test("clones into wakeDefaultCwd and returns the repository working directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-notify-telegram-clone-"));
  try {
    const calls = [];
    const result = await cloneRepository({
      remote: "https://github.com/example/demo.git",
      defaultCwd: root,
      allowedRoots: [root],
      runGit: async (remote, destination, cwd) => {
        calls.push({ remote, destination, cwd });
        await mkdir(destination);
      },
    });
    const canonicalRoot = await realpath(root);
    assert.equal(result.directory, "demo");
    assert.equal(result.cwd, path.join(canonicalRoot, "demo"));
    assert.deepEqual(calls, [{
      remote: "https://github.com/example/demo.git",
      destination: path.join(canonicalRoot, "demo"),
      cwd: canonicalRoot,
    }]);
    await assert.rejects(() => cloneRepository({
      remote: "https://github.com/example/demo.git",
      defaultCwd: root,
      allowedRoots: [root],
      runGit: async () => {},
    }), /already exists/);
    await assert.rejects(() => cloneRepository({
      remote: "https://token@example.com/example/demo.git",
      directory: "failed-copy",
      defaultCwd: root,
      allowedRoots: [root],
      runGit: async () => {
        const error = new Error("clone failed");
        error.gitOutput = "fatal: https://token@example.com/example/demo.git denied";
        throw error;
      },
    }), (error) => !error.message.includes("token") && /https:\/\/\*\*\*@example.com/.test(error.message));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("redacts credentials from clone failures", () => {
  assert.equal(
    formatCloneError({ gitOutput: "fatal: unable to access 'https://token@example.com/repo.git/'" }),
    "fatal: unable to access 'https://***@example.com/repo.git/'",
  );
});
