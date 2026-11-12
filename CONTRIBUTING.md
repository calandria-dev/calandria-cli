# Contributing

Bug reports and pull requests are welcome.

## Setup

```sh
git clone https://github.com/calandria-dev/calandria-cli
cd calandria-cli
npm install
npm run build && npm test
```

Run `npm run typecheck`, `npm run build` and `npm test` before you open a pull request. CI runs the same three on Linux, macOS and Windows with Node 20 and 22.

## Pull request titles

Pull request titles must follow [Conventional Commits](https://www.conventionalcommits.org/), for example `feat: add calandria events --json` or `fix(watch): reconnect after a dropped stream`. Release Please reads the title of each squash-merged PR to choose the next version and write the changelog.

| Prefix | Release effect |
|-|-|
| `feat:` | minor bump |
| `fix:` | patch bump |
| `feat!:` or a `BREAKING CHANGE:` footer | major bump (minor while the version is below 1.0) |
| `docs:`, `test:`, `chore:`, `ci:`, `refactor:` | no release |

## Changing a command

Check the request body and response shape against the matching route under `app/api/` in the [Calandria repository](https://github.com/calandria-dev/calandria) before you change a command. Mirror new shapes in `src/types.ts` and name the source file in a comment.
