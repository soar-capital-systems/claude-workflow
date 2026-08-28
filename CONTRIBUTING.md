# Contributing

Contributions belong in the
[canonical repository](https://github.com/yshaaban/claude-workflow). The Soar
Capital Systems repository is a synchronized mirror and does not accept a
separate stream of changes.

## Before you start

- Search existing issues and pull requests before opening a new one.
- Open an issue before a large behavioral or protocol change so the contract
  can be agreed before implementation.
- Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
  Never put credentials, private prompts, transcripts, or unredacted traces in
  an issue or pull request.

## Development setup

Use Node.js 20 or newer on macOS, Linux, or WSL 2:

```bash
git clone https://github.com/yshaaban/claude-workflow.git
cd claude-workflow
npm ci
npm test
npm run test:package
```

The offline suite does not make paid provider requests. Installed-client
contract tests skip when their required Claude Code or Codex CLI dependency is
unavailable.

Under WSL, keep the checkout, Node.js toolchain, npm cache and prefix, user
configuration, and gateway state on the Linux filesystem. Claude Workflow
setup rejects Windows-mounted paths for these components, and release tests
cover that behavior.

## Pull requests

Keep changes focused and describe the observable behavior they alter. Add a
regression test for bug fixes and contract changes. Run these checks before
opening a pull request:

```bash
npm run check
npm test
npm run test:package
```

For large files or diffs, follow the bounded coverage procedure in
[docs/LARGE_FILES_AND_DIFFS.md](docs/LARGE_FILES_AND_DIFFS.md). A passing test
does not replace review of every changed hunk.

By submitting a contribution, you agree that it may be distributed under the
project's MIT License.
