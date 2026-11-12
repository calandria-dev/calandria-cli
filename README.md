# calandria-cli

`calandria` is a command-line client for [Calandria](https://github.com/calandria-dev/calandria), the self-hosted app that runs coding-agent sessions in parallel across your projects. You create tasks, start them, watch the live transcript, answer permission cards and merge the result from a terminal. The CLI talks to Calandria's REST API over HTTP and needs no API key of its own.

## Install

```sh
npm i -g calandria-cli
calandria --help
```

You need Node 20 or newer.

## Connect

The CLI picks the instance in this order. The first match wins.

1. `--url <url>`
2. the `CALANDRIA_URL` environment variable
3. a named profile (`--profile`, `CALANDRIA_PROFILE`, or the `default` in the config file)
4. local discovery

### Local instance

With no configuration, `calandria` finds an instance running on your machine, including the desktop app. It reads the `calandria.lock.json` file that the server writes beside its database (`$CALANDRIA_DB_DIR`, then `~/.calandria`, then the legacy `~/.zen-orchestrator`). It uses the `url` in that file when the recorded process is alive on this host. If that fails, it probes `http://127.0.0.1:3000` to `3019` for a Calandria `/api/version` response.

A client on the same machine needs no token.

### Remote instance

1. Generate a token on the server with `openssl rand -hex 32`.
2. Set it as `CALANDRIA_API_TOKEN` in the server's environment and restart. Calandria's `docs/SELF_HOSTING.md` describes this in "Exposing the REST API to command-line clients".
3. Save the instance on your machine:

```sh
calandria login https://calandria.example.com --token <token> --name home
```

`login` checks `/api/version`, saves a profile and makes it the default when it is your first. The config file is `$XDG_CONFIG_HOME/calandria-cli/config.json` (`~/.config/calandria-cli/config.json` by default, `%APPDATA%\calandria-cli\config.json` on Windows) with mode 0600. It holds tokens, so keep it private.

You can also skip the config file and pass `CALANDRIA_URL` and `CALANDRIA_API_TOKEN` in the environment.

### Cloudflare Access

If the instance sits behind Cloudflare Access, create an Access service token and give it to the CLI:

```sh
calandria login https://calandria.example.com --cf-client-id <id> --cf-client-secret <secret>
```

The CLI sends them as `CF-Access-Client-Id` and `CF-Access-Client-Secret`. The environment variables `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` work too. Pair them with `CALANDRIA_API_TOKEN` when the server has one set.

## Global flags

| Flag | Effect |
|-|-|
| `--url <url>` | Instance URL |
| `--token <token>` | API token (default: `CALANDRIA_API_TOKEN` or the profile's token) |
| `--profile <name>` | Profile from the config file |
| `--json` | Machine output: raw JSON, NDJSON for streams, no colors |
| `--no-color` | Disable colors. `NO_COLOR` is honored too |

## Commands

References accept what you would type:

- `<task>` is a full id or a unique id prefix of at least 4 characters. An ambiguous prefix lists the candidates and exits with code 2.
- `<project>`, `<runbook>` and `<schedule>` accept an id or an exact name (case-insensitive).

| Command | What it does |
|-|-|
| `login <url>` | Verify an instance and save a profile (`--token`, `--name`, `--cf-client-id`, `--cf-client-secret`) |
| `profiles` | List saved profiles |
| `logout [name]` | Remove a profile |
| `status` | Instance URL and version, running and needs-you counts per project |
| `projects` (`projects ls`) | List projects |
| `tasks` | List tasks. Filters: `--project`, `--status`, `--running`, `--needs-you`, `--all`. Done and cancelled tasks are hidden unless you pass `--all` or `--status` |
| `show <task>` | Task details and the last transcript messages (`--messages N`, default 10) |
| `new <title>` | Create a task. Needs `--project`. Options: `--description`, `--description-file`, `--priority`, `--agent`, `--model`, `--provider`, `--tag NAME` (repeatable), `--start`, `--watch` |
| `start <task>` | Start the first turn. A suggested task is accepted first. `--watch` streams it |
| `send <task> <text...>` | Send a follow-up. `-` reads stdin. `--watch` streams it |
| `watch <task>` | Stream the transcript until the turn ends. `--follow` keeps going, `--interactive` prompts on a terminal when a card arrives, `--exit-on-ask` exits as soon as a card needs you |
| `answer <task>` | Answer the pending card (see below) |
| `stop <task>` | Abort the running turn |
| `set <task>` | Edit `--status`, `--title`, `--priority`, `--description`, `--auto-start on\|off` |
| `done`, `hold`, `cancel <task>` | Shorthands for `set --status done`, `on_hold` and `cancelled` |
| `accept <task>`, `dismiss <task>` | Accept a suggested task onto the board, or delete it |
| `move <task...> --to <project>` | Move tasks. `--discard-worktree` and `--discard-unsafe` acknowledge teardown of a started task's checkout |
| `rm <task...>` | Delete tasks. This is a hard delete with no undo. Asks first unless you pass `--yes` |
| `merge <task>` | Merge the task branch into its base branch |
| `pr <task>` | Push the branch and open or update its pull request (`--title`) |
| `inbox` | Tasks that need you |
| `events` | Tail the global event stream, one line per event |
| `runbooks`, `run <runbook>` | List runbooks. Run one (`--title`, `--extra`, `--no-start`, `--confirm REV`) |
| `schedules`, `schedule-run <schedule>` | List schedules. Fire one now |

### Answering cards

`watch` prints each permission card and question with the exact command that answers it.

```sh
calandria answer 7f3a --allow              # allow once
calandria answer 7f3a --always             # allow and remember the rule
calandria answer 7f3a --deny "too risky"   # deny, with a note for the agent
calandria answer 7f3a --choice "Option A"  # a question: pick an option label
calandria answer 7f3a --text "use Redis"   # a question: free text
```

When more than one card is pending, add `--ask <id>`. Environment-change proposals and cards that collect a secret cannot be answered here. The CLI tells you to open the web UI.

## Examples

```sh
# Create a task from a file, start it and watch it work
calandria new "Fix flaky login test" --project webapp --description-file brief.md --tag Auth --watch

# Pipe a description in
git diff | calandria new "Review this diff" --project webapp --description - --start

# Answer prompts inline while watching
calandria watch 7f3a --interactive

# See what is waiting on you, then clear it
calandria inbox
calandria answer 7f3a --allow

# Move three misfiled tasks
calandria move 1a2b 3c4d 5e6f --to infra

# Run a runbook whose recipe an agent edited
calandria run nightly-sweep --confirm 4

# Script against the JSON output
calandria tasks --needs-you --json | jq -r '.[].id'
```

## Exit codes

| Code | Meaning |
|-|-|
| 0 | Success |
| 1 | Server or runtime error, including a turn that ended in an error |
| 2 | Usage error or an ambiguous or unknown reference |
| 3 | Connection failure |

## Development

```sh
npm install
npm run build
npm run typecheck
npm test
```

The integration tests start a small fake Calandria server and run commands through the real client. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache-2.0. See [LICENSE](LICENSE).
