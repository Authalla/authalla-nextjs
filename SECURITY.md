# Security

## Reporting a vulnerability

Please don't open a public issue. Report it privately on GitHub:
[Report a vulnerability](https://github.com/Authalla/authalla-nextjs/security/advisories/new)
(the Security tab → Report a vulnerability). Include the affected version,
what an attacker can do, and the steps to reproduce it.

Once a fix is out we publish a new version and a GitHub security advisory,
crediting you if you want.

## Supported versions

Fixes go into the latest published version of `@authalla/nextjs`.

## Verifying a release

Every version is published from this repository's Release workflow with
npm provenance. Check that the copy you installed was built here:

```bash
npm audit signatures
```

The package page on npmjs.com links each version to the commit and
workflow run that built it.
