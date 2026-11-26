# Releasing @authalla/nextjs

`.github/workflows/release.yml` publishes to npm when a version tag (`v0.1.0`)
is pushed or a GitHub release is published. It uses npm trusted publishing:
npm trusts that workflow in this repo through GitHub's OIDC token, so there
is no npm token in GitHub, and every version gets a provenance attestation
linking it to the commit it was built from.

The workflow stops if the tag doesn't match `package.json`'s version, and
publishes nothing if that version is already on npm, so re-running it is
safe. It runs the tests, typecheck, lint and build, and checks that the
package holds only `dist/`, the README, the changelog and the license.

## One-time setup (an npm owner of `@authalla`)

1. **The `@authalla` scope.** Sign in at npmjs.com and open
   <https://www.npmjs.com/org/authalla>. If it doesn't exist, create the
   organization `authalla` (Add Organization, the free plan is enough for
   public packages). A scoped package can only be published by the scope's
   owner.
2. **The package.** npm only lets you add a trusted publisher to a package
   that exists. If `npm view @authalla/nextjs` still answers 404, publish
   0.1.0 once by hand from a clean checkout of the tag, with your own npm
   login (`npm login`, which uses your browser and 2FA):

   ```bash
   git checkout v0.1.0 && pnpm install --frozen-lockfile && pnpm build && pnpm check-package
   npm publish --access public
   ```

   If npmjs.com lets you add a trusted publisher before the first version
   (look for "Trusted Publisher" under the organization's packages when
   creating one), do that instead and let the workflow publish 0.1.0.
3. **The trusted publisher.** On
   <https://www.npmjs.com/package/@authalla/nextjs/access>, under Trusted
   Publisher, choose GitHub Actions and enter:
   - Organization or user: `Authalla`
   - Repository: `authalla-nextjs`
   - Workflow filename: `release.yml`
   - Environment: `npm`
4. **Lock it down** (recommended, on the same page): under Publishing
   access, choose "Require two-factor authentication and disallow tokens".
   Trusted publishing still works, and no token can publish the package.
5. **The `npm` environment** (optional): GitHub creates it on the first
   release run. To require an approval before each publish, add yourself as
   a required reviewer under the repo's Settings → Environments → npm.

## Each release

1. Bump `version` in `package.json` and add its section to `CHANGELOG.md`,
   headed `## [x.y.z]`. Merge that to `main`.
2. Tag the merged commit and push the tag:

   ```bash
   git checkout main && git pull
   git tag v0.2.0 && git push origin v0.2.0
   ```

   Or publish a GitHub release with a new tag `v0.2.0` on `main`.
3. The Release workflow publishes, then creates the GitHub release from the
   changelog section (when you pushed a tag). Check
   `npm view @authalla/nextjs version` and the provenance badge on npmjs.com.
