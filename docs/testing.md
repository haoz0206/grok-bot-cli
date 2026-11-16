# Testing

Run `npm run check` for the package gate. It validates the source bundle, rebuilds and validates the artifact, runs TypeScript checks, and runs the unit and route suites.

Run `npm run test:platform` for the credential boundary gate. It exercises macOS Keychain, Linux Secret Service, and Windows DPAPI command vectors with fixture data. The tests assert the executable, arguments, input, output trimming, and decrypt result without reading a real user credential.

The pull request and release workflows run this gate on Ubuntu, macOS, and Windows. They also build, validate, pack, install into an isolated prefix, and invoke `gbot`, `grok-bot`, and `gbot-install`.

Hosted CI does not use a developer's Keychain, Secret Service session, or Windows profile. A local CLI smoke test that needs the signed-in desktop session must run in the user's own interactive terminal. A managed shell can see the same home directory while still lacking the desktop application's credential access context.

For an authorized live smoke test, send a harmless request to the dedicated `gb-test` bot and verify the exact reply. Do not use production bots or put tokens in workflow variables.
