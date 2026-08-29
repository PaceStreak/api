# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project will use [Semantic Versioning](https://semver.org/) once it ships.

## [Unreleased]

Nothing built yet.

### Added

- Repository scaffolding and the constraints that were already settled by
  decisions elsewhere: cookie scoping, CORS, route versioning, and the CSP
  change the frontend needs before its first call to this service.

### Changed

- The consumer of this API is `PaceStreak/app` on `app.pacestreak.com`, not the
  public site. `PaceStreak/landing` was renamed to `PaceStreak/web` and is now
  a permanently static marketing site that makes no authenticated requests —
  so the `connect-src` widening this API requires belongs in `app`, not there.
